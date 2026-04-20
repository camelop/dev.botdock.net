import { DataDir } from "../storage/index.ts";
import {
  readCreditAccount,
  readCreditAccountCredential,
  writeCreditAccount,
  type CreditAccount,
} from "./credit-accounts.ts";

/**
 * Trigger a provider-specific refresh for one account.
 *
 * Persists:
 *   - `used` (and optionally `balance`) on success
 *   - `last_checked_at` always
 *   - `last_refresh_error` on failure (cleared on success)
 *
 * Throws the underlying error too so the HTTP handler can return a useful
 * body; callers that want to survive errors should catch.
 */
export async function refreshCreditAccount(
  dir: DataDir,
  nickname: string,
): Promise<CreditAccount> {
  const acc = readCreditAccount(dir, nickname);
  const credential = readCreditAccountCredential(dir, nickname);
  if (!credential) {
    throw new Error("no credential stored; edit the account to add one");
  }

  const provider = acc.provider;
  try {
    let patch: Partial<CreditAccount>;
    if (provider === "anthropic-api") {
      // Admin API cost_report endpoint. Only works with Developer Console
      // Admin keys (sk-ant-admin…), not with consumer Claude Pro/Max
      // subscriptions.
      patch = await refreshAnthropic(credential);
    } else if (provider === "claude") {
      throw new Error(
        "Claude Pro/Max subscriptions don't expose a public usage API. " +
        "Check manually at https://claude.ai/settings — BotDock can't auto-refresh this.",
      );
    } else {
      throw new Error(`auto-refresh not yet implemented for provider "${provider}"`);
    }
    const updated: CreditAccount = {
      ...acc,
      ...patch,
      last_checked_at: new Date().toISOString(),
      last_refresh_error: undefined,
    };
    writeCreditAccount(dir, updated, undefined);
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updated: CreditAccount = {
      ...acc,
      last_checked_at: new Date().toISOString(),
      last_refresh_error: message.slice(0, 500),
    };
    writeCreditAccount(dir, updated, undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------
// Uses the Admin API's cost_report endpoint (requires an admin API key:
// sk-ant-admin…). Regular sk-ant-api… keys will get a 401 back, which we
// pass through as-is so the user can swap creds without guessing.
// Docs: https://docs.anthropic.com/en/api/admin-api/usage-cost/get-cost-report

async function refreshAnthropic(apiKey: string): Promise<Partial<CreditAccount>> {
  const now = new Date();
  const starting = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const params = new URLSearchParams({
    starting_at: starting.toISOString(),
    ending_at: now.toISOString(),
    bucket_width: "1d",
  });
  const url = `https://api.anthropic.com/v1/organizations/cost_report?${params.toString()}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      detail = parsed.error?.message ?? body;
    } catch { /* not JSON, use raw */ }
    throw new Error(
      `Anthropic cost_report ${res.status}: ${detail.slice(0, 300)}`
      + (res.status === 401
        ? " — note: the cost_report endpoint needs an Admin API key (sk-ant-admin…), not a regular sk-ant-api… key."
        : ""),
    );
  }

  const data = await res.json() as {
    data?: Array<{ results?: Array<{ amount_usd?: number | string }> }>;
  };

  let total = 0;
  for (const bucket of data.data ?? []) {
    for (const r of bucket.results ?? []) {
      const n = typeof r.amount_usd === "string" ? parseFloat(r.amount_usd) : r.amount_usd;
      if (typeof n === "number" && !Number.isNaN(n)) total += n;
    }
  }
  return {
    used: Math.round(total * 100) / 100,  // snap to cents
    unit: "usd",
  };
}
