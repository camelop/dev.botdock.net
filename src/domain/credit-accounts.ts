import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { DataDir, assertSafeName, readToml, writeToml } from "../storage/index.ts";

/**
 * A credit account — one credentialed login the user wants to track usage /
 * remaining credit for. Today the numeric fields (balance, limit) are
 * manually updated from the UI. A future refresher (likely a small agent
 * per provider) will poll real APIs and write these fields.
 */
export type CreditAccount = {
  nickname: string;
  provider: string;              // free-form: "claude", "openai", "cloudflare", "gcp", …
  description: string;
  added_at: string;
  last_checked_at?: string;
  balance?: number;              // current available
  limit?: number;                // cap / plan allotment
  unit?: string;                 // "usd", "credits", "requests", "GB-month", …
  period?: string;               // "monthly", "one-time", …
  notes?: string;
};

function paths(dir: DataDir, nickname: string) {
  assertSafeName(nickname, "credit account nickname");
  const base = dir.path("private", "credit_accounts", nickname);
  return {
    base,
    meta: join(base, "meta.toml"),
    credential: join(base, "credential"),
  };
}

export function listCreditAccounts(dir: DataDir): CreditAccount[] {
  const root = dir.path("private", "credit_accounts");
  if (!existsSync(root)) return [];
  const out: CreditAccount[] = [];
  for (const name of readdirSync(root)) {
    try { assertSafeName(name, "credit account nickname"); } catch { continue; }
    const metaPath = join(root, name, "meta.toml");
    if (existsSync(metaPath)) out.push(readToml<CreditAccount>(metaPath));
  }
  out.sort((a, b) => a.nickname.localeCompare(b.nickname));
  return out;
}

export function creditAccountExists(dir: DataDir, nickname: string): boolean {
  try { return existsSync(paths(dir, nickname).meta); } catch { return false; }
}

export function readCreditAccount(dir: DataDir, nickname: string): CreditAccount {
  const p = paths(dir, nickname);
  if (!existsSync(p.meta)) throw new Error(`credit account not found: ${nickname}`);
  return readToml<CreditAccount>(p.meta);
}

/** Returns the credential bytes. Never logged anywhere. */
export function readCreditAccountCredential(dir: DataDir, nickname: string): string {
  const p = paths(dir, nickname);
  if (!existsSync(p.credential)) return "";
  return readFileSync(p.credential, "utf8");
}

export function writeCreditAccount(
  dir: DataDir,
  account: CreditAccount,
  credential: string | undefined,
): CreditAccount {
  assertSafeName(account.nickname, "credit account nickname");
  const p = paths(dir, account.nickname);
  mkdirSync(p.base, { recursive: true, mode: 0o700 });
  chmodSync(p.base, 0o700);

  if (credential !== undefined) {
    writeFileSync(p.credential, credential, { mode: 0o600 });
    chmodSync(p.credential, 0o600);
  }

  const meta: Record<string, unknown> = {
    nickname: account.nickname,
    provider: account.provider,
    description: account.description ?? "",
    added_at: account.added_at,
  };
  if (account.last_checked_at) meta.last_checked_at = account.last_checked_at;
  if (account.balance !== undefined) meta.balance = account.balance;
  if (account.limit !== undefined) meta.limit = account.limit;
  if (account.unit) meta.unit = account.unit;
  if (account.period) meta.period = account.period;
  if (account.notes) meta.notes = account.notes;

  writeToml(p.meta, meta);
  return account;
}

export function deleteCreditAccount(dir: DataDir, nickname: string): void {
  const p = paths(dir, nickname);
  if (!existsSync(p.base)) throw new Error(`credit account not found: ${nickname}`);
  rmSync(p.base, { recursive: true, force: true });
}
