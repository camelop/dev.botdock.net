import { useEffect, useState } from "react";
import { creditsApi, type CreditAccount } from "../api";
import { Modal } from "../components/Modal";
import { relativeTime, fullTime } from "../lib/time";

type ProviderPreset = {
  id: string;
  label: string;
  unitHint?: string;
  /** Shown in the add-account modal so the user knows what to paste. */
  credentialHint?: string;
  guide?: string;
  refreshable?: boolean;
};

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "anthropic-api",
    label: "Anthropic API",
    unitHint: "usd",
    refreshable: true,
    credentialHint: "sk-ant-admin01-… (Admin API key)",
    guide:
      "BotDock fetches usage via the organization cost_report endpoint, which requires an ADMIN API key " +
      "(not a regular sk-ant-api… key). Create one under your Anthropic Console → Admin Keys, paste it below, " +
      "then hit the ↻ button on the card to pull the last 30 days.",
  },
  {
    id: "claude",
    label: "Claude (Pro / Max subscription)",
    unitHint: "usd",
    refreshable: false,
    guide:
      "Monthly subscription accounts don't currently expose a programmatic balance endpoint. You can still " +
      "track them here — BotDock just won't auto-refresh. Drop a rough monthly allotment as a note if you want.",
  },
  {
    id: "openai",
    label: "OpenAI",
    unitHint: "usd",
    guide: "OpenAI auto-refresh is on the roadmap. For now, add the account to track it manually.",
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    unitHint: "requests",
    guide: "Cloudflare auto-refresh is on the roadmap.",
  },
  { id: "gcp",   label: "Google Cloud", unitHint: "usd" },
  { id: "other", label: "Other" },
];

function presetFor(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

export function CreditsPage() {
  const [accounts, setAccounts] = useState<CreditAccount[]>([]);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState<{ mode: "new" } | { mode: "edit"; nickname: string } | null>(null);

  const refresh = () =>
    creditsApi.list().then(setAccounts).catch((e) => setErr(String(e?.message ?? e)));

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, []);

  const onDelete = async (nickname: string) => {
    if (!confirm(`Remove account "${nickname}"?`)) return;
    try { await creditsApi.remove(nickname); await refresh(); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Credits</h1>
        <button onClick={() => setEdit({ mode: "new" })}>+ Add account</button>
      </div>
      {err && <div className="error-banner">{err}</div>}

      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        Track how much credit is left on each of your API / service accounts.
        Balance and limit are entered manually for now — an auto-refresh agent
        per provider is on the roadmap.
      </div>

      {accounts.length === 0 ? (
        <div className="card">
          <div className="empty">
            No accounts yet. Click "+ Add account" to start tracking one.
          </div>
        </div>
      ) : (
        <div style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        }}>
          {accounts.map((a) => (
            <AccountCard
              key={a.nickname}
              account={a}
              onEdit={() => setEdit({ mode: "edit", nickname: a.nickname })}
              onDelete={() => onDelete(a.nickname)}
              onRefreshed={refresh}
            />
          ))}
        </div>
      )}

      {edit && (
        <AccountEditor
          target={edit}
          onClose={() => setEdit(null)}
          onDone={async () => { setEdit(null); await refresh(); }}
        />
      )}
    </div>
  );
}

const REFRESHABLE_PROVIDERS = new Set(["anthropic-api", "claude"]);

function AccountCard(props: {
  account: CreditAccount;
  onEdit: () => void;
  onDelete: () => void;
  onRefreshed: () => void;
}) {
  const { account: a } = props;

  // Derive a "remaining" + "pct" for the progress bar. Prefer an explicit
  // balance; otherwise compute from limit - used when both present.
  const remaining = a.balance !== undefined
    ? a.balance
    : (a.limit !== undefined && a.used !== undefined ? a.limit - a.used : undefined);
  const pct = (remaining !== undefined && a.limit && a.limit > 0)
    ? Math.min(100, Math.max(0, (remaining / a.limit) * 100))
    : undefined;
  const low = pct !== undefined && pct < 20;

  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState("");
  const canRefresh = REFRESHABLE_PROVIDERS.has(a.provider);

  const onRefresh = async () => {
    setRefreshing(true); setRefreshErr("");
    try { await creditsApi.refresh(a.nickname); props.onRefreshed(); }
    catch (e) { setRefreshErr(String((e as Error).message ?? e)); }
    finally { setRefreshing(false); }
  };

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontWeight: 600 }}>{a.nickname}</div>
          <div className="muted" style={{ fontSize: 11 }}>{a.provider}{a.period ? ` · ${a.period}` : ""}</div>
        </div>
        <div className="actions">
          {canRefresh && (
            <button
              className="secondary"
              style={{ padding: "3px 8px", fontSize: 12 }}
              onClick={onRefresh}
              disabled={refreshing}
              title="fetch usage from the provider API"
            >{refreshing ? "…" : "↻"}</button>
          )}
          <button className="secondary" style={{ padding: "3px 8px", fontSize: 12 }} onClick={props.onEdit}>Edit</button>
          <button className="secondary" style={{ padding: "3px 8px", fontSize: 12 }} onClick={props.onDelete}>×</button>
        </div>
      </div>
      {a.description && <div className="muted" style={{ fontSize: 12 }}>{a.description}</div>}

      {remaining !== undefined || a.used !== undefined || a.limit !== undefined ? (
        <>
          <div className="row" style={{ alignItems: "baseline", gap: 6, marginTop: 4 }}>
            <span style={{ fontSize: 22, fontWeight: 600, color: low ? "var(--danger)" : undefined }}>
              {remaining !== undefined ? remaining.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              {a.limit !== undefined ? `/ ${a.limit.toLocaleString()}` : ""} {a.unit ?? ""}
            </span>
          </div>
          {pct !== undefined && (
            <div style={{
              height: 6, width: "100%", background: "rgba(255,255,255,0.07)", borderRadius: 3, overflow: "hidden",
            }}>
              <div style={{
                height: "100%", width: `${pct}%`,
                background: low ? "var(--danger)" : pct < 50 ? "var(--warn)" : "var(--ok)",
                transition: "width .3s ease",
              }} />
            </div>
          )}
          {a.used !== undefined && (
            <div className="muted" style={{ fontSize: 11 }}>
              used {a.used.toLocaleString(undefined, { maximumFractionDigits: 2 })} {a.unit ?? ""}
              {a.period ? ` in the last ${a.period === "monthly" ? "30d" : a.period}` : " in the last 30d"}
            </div>
          )}
        </>
      ) : (
        <div className="muted" style={{ fontSize: 12, fontStyle: "italic" }}>
          No balance recorded yet — Edit to set one{canRefresh ? ", or hit ↻ to fetch from the API." : "."}
        </div>
      )}

      {(refreshErr || a.last_refresh_error) && (
        <div className="error-banner" style={{ fontSize: 11, padding: 6, margin: 0 }}>
          {refreshErr || a.last_refresh_error}
        </div>
      )}

      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
        {a.last_checked_at
          ? <>updated <span title={fullTime(a.last_checked_at)}>{relativeTime(a.last_checked_at)}</span></>
          : <>added <span title={fullTime(a.added_at)}>{relativeTime(a.added_at)}</span></>}
      </div>
    </div>
  );
}

function AccountEditor(props: {
  target: { mode: "new" } | { mode: "edit"; nickname: string };
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const isNew = props.target.mode === "new";
  const [nickname, setNickname] = useState(isNew ? "" : (props.target as { nickname: string }).nickname);
  const [provider, setProvider] = useState(isNew ? "anthropic-api" : "");
  const [credential, setCredential] = useState("");
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isNew) {
      creditsApi.get((props.target as { nickname: string }).nickname).then((a) => {
        setProvider(a.provider);
        setNotes(a.notes ?? "");
      }).catch((e) => setErr(String(e.message ?? e)));
    }
  }, []);

  const preset = presetFor(provider);

  const submit = async () => {
    setErr(""); setSubmitting(true);
    try {
      // description intentionally omitted — we don't ask the user for it
      // anymore; the provider label is enough context on the card.
      const payload = {
        nickname,
        provider,
        description: "",
        added_at: new Date().toISOString(),
        notes: notes || undefined,
        credential: credential || undefined,
      };
      if (isNew) await creditsApi.create(payload);
      else await creditsApi.update(nickname, payload);
      await props.onDone();
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    finally { setSubmitting(false); }
  };

  return (
    <Modal title={isNew ? "Add account" : `Edit: ${nickname}`} onClose={props.onClose}>
      <label>
        <span>Nickname</span>
        <input value={nickname} disabled={!isNew} onChange={(e) => setNickname(e.target.value)} autoFocus={isNew} />
      </label>
      <label>
        <span>Provider</span>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          {PROVIDER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>

      {preset?.guide && (
        <div
          className="card"
          style={{
            background: "rgba(106,164,255,0.08)",
            borderColor: "rgba(106,164,255,0.3)",
            padding: 10,
            fontSize: 12.5,
            lineHeight: 1.45,
            marginBottom: 10,
          }}
        >
          <div className="muted" style={{ fontSize: 11, marginBottom: 4, textTransform: "uppercase" }}>
            How this connects
          </div>
          {preset.guide}
          {preset.refreshable === false && (
            <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
              (No auto-refresh — this account is tracked as a placeholder.)
            </div>
          )}
        </div>
      )}

      <label>
        <span>Credential {preset?.credentialHint ? `(${preset.credentialHint})` : "(API key / token)"}</span>
        <textarea rows={2} value={credential} onChange={(e) => setCredential(e.target.value)}
          placeholder={isNew ? preset?.credentialHint ?? "paste the API key / token" : "leave blank to keep existing"} />
        <span className="muted" style={{ fontSize: 11 }}>
          Stored locally under <span className="mono">private/credit_accounts/{nickname || "…"}/credential</span> with
          0600 perms. Never leaves your machine except to hit the provider's API on refresh.
        </span>
      </label>

      <label>
        <span>Notes (optional)</span>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      {err && <div className="error-banner">{err}</div>}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
        <button className="secondary" onClick={props.onClose}>Cancel</button>
        <button disabled={submitting || !nickname || !provider} onClick={submit}>
          {isNew ? "Add" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
