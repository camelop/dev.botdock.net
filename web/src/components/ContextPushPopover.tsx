import { useEffect, useMemo, useRef, useState } from "react";
import { api, type FileBundleMeta, type GitRepoResource, type MarkdownMeta, type Session } from "../api";

type RepoPicks = Record<string, { selected: boolean; includeKey: boolean }>;
type MarkdownPicks = Record<string, boolean>;
type BundlePicks = Record<string, boolean>;
type SkillStatus = Awaited<ReturnType<typeof api.getSessionSkillStatus>>;

type PushResult = Awaited<ReturnType<typeof api.pushSessionContext>>;

// The global CSS (`input { width: 100% }`) would stretch native checkboxes
// across the whole flex row, pushing their label text to the far right
// with a big empty gap in the middle. Every <input type="checkbox"> in
// this popover uses this style to opt out. Matches the pattern in
// ForwardsPage.
const CHECKBOX_STYLE: React.CSSProperties = {
  width: "auto",
  margin: 0,
  padding: 0,
  flex: "none",
};

// label span { display: block; margin-bottom: 4px } is a site-wide rule
// that would force our direct span children of label to stack vertically.
// Override to inline so our flex layout sticks.
const LABEL_SPAN_STYLE: React.CSSProperties = {
  display: "inline",
  marginBottom: 0,
};

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
  const [markdowns, setMarkdowns] = useState<MarkdownMeta[]>([]);
  const [bundles, setBundles] = useState<FileBundleMeta[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listErr, setListErr] = useState("");

  const [picks, setPicks] = useState<RepoPicks>({});
  const [mdPicks, setMdPicks] = useState<MarkdownPicks>({});
  const [bundlePicks, setBundlePicks] = useState<BundlePicks>({});
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<PushResult | null>(null);

  // Skill install state. "checking" = probe in flight; after that the
  // backend-reported state drives UI. A separate "installing" | "updating"
  // flag rides on top while a POST is in flight so the button can show
  // a spinner.
  const [skillStatus, setSkillStatus] = useState<SkillStatus>({
    state: "checking",
    target_path: "",
  });
  const [skillBusy, setSkillBusy] = useState<"idle" | "installing" | "updating">("idle");
  const [skillErr, setSkillErr] = useState("");

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
    Promise.all([api.listGitRepos(), api.listMarkdowns(), api.listFileBundles()])
      .then(([rs, mds, bs]) => {
        if (cancelled) return;
        setRepos(rs);
        setMarkdowns(mds);
        setBundles(bs);
        setLoadingList(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setListErr(String((e as Error).message ?? e));
          setLoadingList(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  // Probe the skill install state once when the popover opens. We
  // intentionally don't poll — the user is looking at a short-lived
  // affordance and any install action will refresh explicitly.
  useEffect(() => {
    let cancelled = false;
    api.getSessionSkillStatus(session.id)
      .then((s) => { if (!cancelled) setSkillStatus(s); })
      .catch((e) => {
        if (!cancelled) {
          setSkillStatus({
            state: "error",
            target_path: "",
            error: String((e as Error).message ?? e),
          });
        }
      });
    return () => { cancelled = true; };
  }, [session.id]);

  const installOrUpdateSkill = async () => {
    const updating = skillStatus.state === "update_available";
    setSkillBusy(updating ? "updating" : "installing");
    setSkillErr("");
    try {
      const r = await api.installSessionSkill(session.id);
      setSkillStatus({
        state: "installed",
        local_sha: r.local_sha,
        remote_sha: r.remote_sha,
        target_path: r.target_path,
      });
    } catch (e) {
      setSkillErr(String((e as Error).message ?? e));
    } finally {
      setSkillBusy("idle");
    }
  };

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

  const toggleMarkdown = (name: string) => {
    setMdPicks((cur) => ({ ...cur, [name]: !cur[name] }));
  };
  const toggleBundle = (name: string) => {
    setBundlePicks((cur) => ({ ...cur, [name]: !cur[name] }));
  };

  const selectedRepos = useMemo(
    () => repos.filter((r) => picks[r.name]?.selected),
    [repos, picks],
  );
  const selectedMarkdowns = useMemo(
    () => markdowns.filter((m) => mdPicks[m.name]),
    [markdowns, mdPicks],
  );
  const selectedBundles = useMemo(
    () => bundles.filter((b) => bundlePicks[b.name]),
    [bundles, bundlePicks],
  );
  const totalSelected = selectedRepos.length + selectedMarkdowns.length + selectedBundles.length;
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
        markdowns: selectedMarkdowns.map((m) => ({ name: m.name })),
        file_bundles: selectedBundles.map((b) => ({ name: b.name })),
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

      {!result && (
        <SkillBanner
          status={skillStatus}
          busy={skillBusy}
          err={skillErr}
          onInstall={installOrUpdateSkill}
        />
      )}

      {result ? (
        <PushResultView result={result} onClose={onClose} />
      ) : (
        <PickerView
          repos={repos}
          markdowns={markdowns}
          bundles={bundles}
          loadingList={loadingList}
          listErr={listErr}
          picks={picks}
          mdPicks={mdPicks}
          bundlePicks={bundlePicks}
          onToggleRepo={toggleSelected}
          onToggleIncludeKey={toggleIncludeKey}
          onToggleMarkdown={toggleMarkdown}
          onToggleBundle={toggleBundle}
          privateKeyCount={privateKeyCount}
          selectedCount={totalSelected}
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
  markdowns: MarkdownMeta[];
  bundles: FileBundleMeta[];
  loadingList: boolean;
  listErr: string;
  picks: RepoPicks;
  mdPicks: MarkdownPicks;
  bundlePicks: BundlePicks;
  onToggleRepo: (name: string) => void;
  onToggleIncludeKey: (name: string) => void;
  onToggleMarkdown: (name: string) => void;
  onToggleBundle: (name: string) => void;
  privateKeyCount: number;
  selectedCount: number;
  submitting: boolean;
  err: string;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const sectionLabelStyle: React.CSSProperties = {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  };
  return (
    <>
      <div className="scroll-panel" style={{ overflowY: "auto", minHeight: 0, flex: 1 }}>
        <div className="muted" style={sectionLabelStyle}>Git repos</div>
        {props.loadingList ? (
          <div className="muted" style={{ fontSize: 12 }}>Loading…</div>
        ) : props.listErr ? (
          <div className="error-banner" style={{ fontSize: 11 }}>{props.listErr}</div>
        ) : props.repos.length === 0 ? (
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
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

        <div className="muted" style={{ ...sectionLabelStyle, marginTop: 14 }}>Markdown</div>
        {props.loadingList ? null : props.markdowns.length === 0 ? (
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            No markdown chunks yet. Add one under Context → Markdown.
          </div>
        ) : (
          props.markdowns.map((m) => (
            <MarkdownRow
              key={m.name}
              md={m}
              selected={!!props.mdPicks[m.name]}
              onToggle={() => props.onToggleMarkdown(m.name)}
            />
          ))
        )}

        <div className="muted" style={{ ...sectionLabelStyle, marginTop: 14 }}>File bundles</div>
        {props.loadingList ? null : props.bundles.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            No file bundles yet. Add one under Context → File Bundles.
          </div>
        ) : (
          props.bundles.map((b) => (
            <BundleRow
              key={b.name}
              bundle={b}
              selected={!!props.bundlePicks[b.name]}
              onToggle={() => props.onToggleBundle(b.name)}
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

/**
 * Top-of-popover banner advertising the `botdock-context` Claude Agent
 * Skill. Has four display states:
 *   checking → skeleton
 *   not_installed → prominent "Install skill" CTA + explanation
 *   installed → compact "✅ installed (<sha>)" + subtle "Reinstall"
 *   update_available → warn-accented "Update available" + prominent CTA
 *   error → red banner with retry affordance (just re-run install)
 *
 * The skill itself is a one-file repo on an orphan branch of the main
 * BotDock repo; install = `git clone --branch skill/botdock-context`
 * into `<workdir>/.claude/skills/botdock-context/`. Keeping the .git
 * dir in place is what lets us detect "update available" via
 * `git ls-remote`.
 */
function SkillBanner(props: {
  status: SkillStatus;
  busy: "idle" | "installing" | "updating";
  err: string;
  onInstall: () => void;
}) {
  const { status, busy, err } = props;
  const short = (sha?: string) => (sha ? sha.slice(0, 7) : "");

  // Pick the visual tone: neutral grey when absent, success green when
  // installed, warn amber when update available or action in flight.
  const toneBg =
    status.state === "update_available" || busy !== "idle"
      ? "rgba(242,185,75,0.08)"
      : status.state === "installed"
        ? "rgba(111,196,130,0.08)"
        : status.state === "error"
          ? "rgba(228,92,92,0.08)"
          : "rgba(255,255,255,0.02)";
  const toneBorder =
    status.state === "update_available" || busy !== "idle"
      ? "rgba(242,185,75,0.5)"
      : status.state === "installed"
        ? "rgba(111,196,130,0.5)"
        : status.state === "error"
          ? "rgba(228,92,92,0.5)"
          : "var(--border)";

  return (
    <div
      style={{
        marginBottom: 12,
        padding: "10px 12px",
        border: `1px solid ${toneBorder}`,
        background: toneBg,
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.4,
      }}
    >
      <div
        className="row"
        style={{ justifyContent: "space-between", gap: 8, alignItems: "center" }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            botdock-context skill
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            <SkillBody status={status} busy={busy} short={short} />
          </div>
        </div>
        <SkillAction status={status} busy={busy} onInstall={props.onInstall} />
      </div>
      {status.state === "installed" && busy === "idle" && (
        <div
          className="muted"
          style={{ fontSize: 11, marginTop: 8, lineHeight: 1.45 }}
        >
          In the session's Claude Code: run{" "}
          <code className="mono">/reload-plugins</code> to pick up the skill,
          then <code className="mono">/skills</code> to confirm{" "}
          <span className="mono">botdock-context</span> is listed.
        </div>
      )}
      {err && (
        <div
          className="error-banner"
          style={{ marginTop: 8, fontSize: 11 }}
          title={err}
        >{err.slice(0, 160)}</div>
      )}
    </div>
  );
}

function SkillBody(props: {
  status: SkillStatus;
  busy: "idle" | "installing" | "updating";
  short: (sha?: string) => string;
}) {
  const { status, busy, short } = props;
  if (busy === "installing") return <>Installing via git clone…</>;
  if (busy === "updating")   return <>Fetching update…</>;
  if (status.state === "checking") return <>Checking install state…</>;
  if (status.state === "not_installed") {
    return <>Not yet installed. Click Install to git-clone it into <code className="mono">./.claude/skills/</code> — teaches the target agent how to use pushed resources.</>;
  }
  if (status.state === "error") {
    return <>Status check failed. You can still try Install — it's idempotent.</>;
  }
  const localShort = short(status.local_sha);
  const remoteShort = short(status.remote_sha);
  if (status.state === "update_available") {
    return <>Installed @ <span className="mono">{localShort}</span> · update available → <span className="mono">{remoteShort}</span></>;
  }
  // installed
  const note = status.remote_unreachable
    ? " · remote unreachable"
    : localShort ? ` @ ${localShort}` : "";
  return (
    <>
      <span style={{ color: "var(--ok)" }}>✓</span>{" "}
      Installed<span className="mono">{note}</span>
    </>
  );
}

function SkillAction(props: {
  status: SkillStatus;
  busy: "idle" | "installing" | "updating";
  onInstall: () => void;
}) {
  const { status, busy, onInstall } = props;
  if (busy !== "idle") {
    return (
      <button className="secondary action-bar-btn" disabled>
        {busy === "installing" ? "Installing…" : "Updating…"}
      </button>
    );
  }
  if (status.state === "checking") {
    return (
      <button className="secondary action-bar-btn" disabled>Checking…</button>
    );
  }
  if (status.state === "not_installed" || status.state === "error") {
    return <button onClick={onInstall}>Install skill</button>;
  }
  if (status.state === "update_available") {
    return <button onClick={onInstall}>Update</button>;
  }
  // installed
  return (
    <button className="secondary action-bar-btn" onClick={onInstall}>
      Reinstall
    </button>
  );
}

function BundleRow(props: {
  bundle: FileBundleMeta;
  selected: boolean;
  onToggle: () => void;
}) {
  const { bundle, selected } = props;
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
          fontSize: 12,
          color: "var(--fg)",
        }}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={props.onToggle}
          style={CHECKBOX_STYLE}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}>{bundle.name}</div>
          <div
            className="mono muted"
            style={{
              fontSize: 10,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {bundle.file_count} file{bundle.file_count === 1 ? "" : "s"} · {formatBytes(bundle.bytes)}
            {bundle.tags && bundle.tags.length ? ` · ${bundle.tags.join(", ")}` : ""}
          </div>
        </div>
      </label>
    </div>
  );
}

function MarkdownRow(props: {
  md: MarkdownMeta;
  selected: boolean;
  onToggle: () => void;
}) {
  const { md, selected } = props;
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
          fontSize: 12,
          color: "var(--fg)",
        }}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={props.onToggle}
          style={CHECKBOX_STYLE}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}>{md.name}</div>
          <div
            className="mono muted"
            style={{
              fontSize: 10,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {formatBytes(md.bytes)}
            {md.tags && md.tags.length ? ` · ${md.tags.join(", ")}` : ""}
          </div>
        </div>
      </label>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
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
          fontSize: 12,
          color: "var(--fg)",
        }}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={props.onToggle}
          style={CHECKBOX_STYLE}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}>{repo.name}</div>
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
            alignItems: "flex-start",
            gap: 8,
            marginLeft: 24,
            marginTop: 4,
            marginBottom: 0,
            cursor: "pointer",
            fontSize: 11,
            color: "var(--fg)",
          }}
        >
          <input
            type="checkbox"
            checked={includeKey}
            onChange={props.onToggleIncludeKey}
            style={{ ...CHECKBOX_STYLE, marginTop: 2 }}
          />
          <span style={{ ...LABEL_SPAN_STYLE, flex: 1, lineHeight: 1.35 }}>
            Also push deploy key (<span className="mono" style={LABEL_SPAN_STYLE}>{repo.deploy_key}</span>)
            <span className="muted" style={LABEL_SPAN_STYLE}>
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
            {p.file_count !== undefined && (
              <span className="mono muted" style={{ fontSize: 10 }}>
                {p.file_count} file{p.file_count === 1 ? "" : "s"}
              </span>
            )}
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
