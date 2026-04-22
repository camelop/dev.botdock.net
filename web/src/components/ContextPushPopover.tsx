import { useEffect, useMemo, useRef, useState } from "react";
import { api, type GitRepoResource, type Session } from "../api";

type Picks = Record<string, { selected: boolean; includeKey: boolean }>;

type PushResult = Awaited<ReturnType<typeof api.pushSessionContext>>;

/**
 * Popover for pushing curated context resources from the root-folder
 * registry into a running session's remote workdir. Anchored to the
 * `＋ Context` button via an absolutely-positioned container.
 *
 * Intentionally NOT a Modal: the button lives inside the SessionView,
 * which is also mounted inside the SessionsPage detail modal — a nested
 * full-screen modal on top of that one tends to race on backdrop /
 * Escape handling. A popover dodges that entirely.
 */
export function ContextPushPopover(props: {
  session: Session;
  anchorEl: HTMLElement | null;
  onClose: () => void;
}) {
  const { session, anchorEl, onClose } = props;
  const [repos, setRepos] = useState<GitRepoResource[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listErr, setListErr] = useState("");

  const [picks, setPicks] = useState<Picks>({});
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<PushResult | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);

  // Dismissal: outside-click + Escape. Mirrors the UpdatePopover pattern
  // in App.tsx. While the push is in flight we block dismissal so the
  // user doesn't accidentally close mid-ssh.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (submitting) return;
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      if (anchorEl && anchorEl.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (submitting) return;
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDocClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorEl, submitting]);

  useEffect(() => {
    let cancelled = false;
    api.listGitRepos()
      .then((rs) => { if (!cancelled) { setRepos(rs); setLoadingList(false); } })
      .catch((e) => {
        if (!cancelled) {
          setListErr(String((e as Error).message ?? e));
          setLoadingList(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  const toggleSelected = (name: string) => {
    setPicks((cur) => {
      const next = { ...cur };
      const prev = next[name] ?? { selected: false, includeKey: false };
      const flipping = !prev.selected;
      next[name] = {
        selected: flipping,
        // Un-selecting a repo also clears its include-key flag so a later
        // re-select doesn't silently re-arm private-material push.
        includeKey: flipping ? prev.includeKey : false,
      };
      return next;
    });
  };
  const toggleIncludeKey = (name: string) => {
    setPicks((cur) => {
      const prev = cur[name] ?? { selected: false, includeKey: false };
      return { ...cur, [name]: { ...prev, includeKey: !prev.includeKey } };
    });
  };

  const selectedRepos = useMemo(
    () => repos.filter((r) => picks[r.name]?.selected),
    [repos, picks],
  );
  const privateKeyCount = useMemo(
    () => selectedRepos.filter((r) => r.deploy_key && picks[r.name]?.includeKey).length,
    [selectedRepos, picks],
  );

  const submit = async () => {
    setErr(""); setSubmitting(true);
    try {
      const r = await api.pushSessionContext(session.id, {
        git_repos: selectedRepos.map((r) => ({
          name: r.name,
          include_deploy_key: !!(r.deploy_key && picks[r.name]?.includeKey),
        })),
      });
      setResult(r);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  // Label used in the header so the user confirms which session they're
  // pushing INTO (sometimes this button is clicked from a modal that
  // obscures the session list).
  const sessionLabel = session.alias || session.cmd?.slice(0, 40) || session.id;

  return (
    <div
      ref={rootRef}
      style={{
        position: "absolute",
        top: "calc(100% + 8px)",
        left: 0,
        width: 420,
        maxHeight: "min(70vh, 640px)",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 14,
        boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
        // Stack above SessionsPage's detail modal backdrop (z-index 100 in
        // the app's CSS). 200 is well clear of everything except the
        // server-down overlay at 1000.
        zIndex: 200,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
        Push context → {sessionLabel}
      </div>
      <div className="mono muted" style={{ fontSize: 11, marginBottom: 10 }}>
        {session.workdir}/.botdock/context/
      </div>

      {result ? (
        <PushResultView result={result} onClose={onClose} />
      ) : (
        <PickerView
          repos={repos}
          loadingList={loadingList}
          listErr={listErr}
          picks={picks}
          onToggleRepo={toggleSelected}
          onToggleIncludeKey={toggleIncludeKey}
          privateKeyCount={privateKeyCount}
          selectedCount={selectedRepos.length}
          submitting={submitting}
          err={err}
          onCancel={onClose}
          onSubmit={submit}
        />
      )}
    </div>
  );
}

function PickerView(props: {
  repos: GitRepoResource[];
  loadingList: boolean;
  listErr: string;
  picks: Picks;
  onToggleRepo: (name: string) => void;
  onToggleIncludeKey: (name: string) => void;
  privateKeyCount: number;
  selectedCount: number;
  submitting: boolean;
  err: string;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <>
      <div className="scroll-panel" style={{ overflowY: "auto", minHeight: 0, flex: 1 }}>
        <div
          className="muted"
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            marginBottom: 6,
          }}
        >Git repos</div>
        {props.loadingList ? (
          <div className="muted" style={{ fontSize: 12 }}>Loading…</div>
        ) : props.listErr ? (
          <div className="error-banner" style={{ fontSize: 11 }}>{props.listErr}</div>
        ) : props.repos.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            No git-repos registered yet. Add one under Context → Git Repos.
          </div>
        ) : (
          props.repos.map((r) => (
            <RepoRow
              key={r.name}
              repo={r}
              selected={!!props.picks[r.name]?.selected}
              includeKey={!!props.picks[r.name]?.includeKey}
              onToggle={() => props.onToggleRepo(r.name)}
              onToggleIncludeKey={() => props.onToggleIncludeKey(r.name)}
            />
          ))
        )}
      </div>

      {props.privateKeyCount > 0 && (
        <div
          style={{
            marginTop: 10,
            padding: "8px 10px",
            border: "1px solid rgba(242,185,75,0.5)",
            background: "rgba(242,185,75,0.08)",
            borderRadius: 6,
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          ⚠ {props.privateKeyCount} item{props.privateKeyCount === 1 ? "" : "s"} will
          ship private key material to the remote — make sure this session's
          machine is one you trust.
        </div>
      )}

      {props.err && (
        <div className="error-banner" style={{ marginTop: 8, fontSize: 11 }}>{props.err}</div>
      )}

      <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
        <button className="secondary" onClick={props.onCancel} disabled={props.submitting}>Cancel</button>
        <button
          onClick={props.onSubmit}
          disabled={props.submitting || props.selectedCount === 0}
        >
          {props.submitting
            ? "Pushing…"
            : props.selectedCount === 0
              ? "Push"
              : `Push ${props.selectedCount} item${props.selectedCount === 1 ? "" : "s"}`}
        </button>
      </div>
    </>
  );
}

function RepoRow(props: {
  repo: GitRepoResource;
  selected: boolean;
  includeKey: boolean;
  onToggle: () => void;
  onToggleIncludeKey: () => void;
}) {
  const { repo, selected, includeKey } = props;
  return (
    <div
      style={{
        padding: "6px 8px",
        borderRadius: 6,
        marginBottom: 4,
        background: selected ? "rgba(106,164,255,0.08)" : "transparent",
        border: selected ? "1px solid rgba(106,164,255,0.35)" : "1px solid transparent",
      }}
    >
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          margin: 0,
        }}
      >
        <input type="checkbox" checked={selected} onChange={props.onToggle} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{repo.name}</div>
          <div
            className="mono muted"
            style={{
              fontSize: 10,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={repo.url}
          >
            {repo.url}{repo.ref ? ` · ${repo.ref}` : ""}
          </div>
        </div>
      </label>
      {selected && repo.deploy_key && (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginLeft: 24,
            marginTop: 4,
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          <input
            type="checkbox"
            checked={includeKey}
            onChange={props.onToggleIncludeKey}
          />
          <span>
            Also push deploy key (<span className="mono">{repo.deploy_key}</span>)
            <span className="muted">
              {" "}— without this, the agent will need its own credentials to clone
            </span>
          </span>
        </label>
      )}
    </div>
  );
}

function PushResultView(props: { result: PushResult; onClose: () => void }) {
  const { result } = props;
  const hasPrivate = result.pushed.some((p) => p.wrote_private_key);
  return (
    <>
      <div
        style={{
          padding: "8px 10px",
          border: "1px solid rgba(111,196,130,0.5)",
          background: "rgba(111,196,130,0.08)",
          borderRadius: 6,
          fontSize: 12,
          marginBottom: 10,
        }}
      >
        Pushed {result.pushed.length} item{result.pushed.length === 1 ? "" : "s"} to
        <div className="mono" style={{ fontSize: 11, marginTop: 4, wordBreak: "break-all" }}>
          {result.remote_base}
        </div>
      </div>

      <div className="scroll-panel" style={{ overflowY: "auto", flex: 1, fontSize: 12 }}>
        {result.pushed.map((p) => (
          <div
            key={`${p.kind}:${p.name}`}
            style={{
              padding: "4px 0",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              gap: 8,
              alignItems: "baseline",
            }}
          >
            <span className="pill" style={{ fontSize: 10 }}>{p.kind}</span>
            <span className="mono">{p.name}</span>
            {p.wrote_private_key && (
              <span className="mono" style={{ fontSize: 10, color: "var(--warn)" }}>
                + private key
              </span>
            )}
          </div>
        ))}
      </div>

      {hasPrivate && (
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          Private key material was written at mode 600. An audit entry is in the
          session's Events log.
        </div>
      )}

      <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
        <button onClick={props.onClose}>Done</button>
      </div>
    </>
  );
}
