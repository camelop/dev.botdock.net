/**
 * Typed API client for BotDock.
 * Hits the same origin; during dev Vite proxies /api to the backend.
 */

export type KeyMeta = {
  nickname: string;
  created_at: string;
  fingerprint: string;
  comment: string;
  source: "generated" | "imported";
};

export type KeyDetail = { meta: KeyMeta; publicKey: string };

export type JumpHop = {
  host: string;
  user: string;
  port?: number;
  key: string;
};

export type Machine = {
  name: string;
  host: string;
  port?: number;
  user: string;
  key: string;
  tags?: string[];
  notes?: string;
  jump?: JumpHop[];
  /** Set to "local" on the reserved loopback machine. */
  managed?: "local";
  /** Soft-disabled machines still appear in listings but are filtered
   * out of session-create pickers. */
  disabled?: boolean;
};

export type GitRepoResource = {
  name: string;
  url: string;
  ref?: string;
  deploy_key?: string;
  tags?: string[];
  created_at: string;
  updated_at: string;
};

export type MarkdownMeta = {
  name: string;
  tags?: string[];
  bytes: number;
  created_at: string;
  updated_at: string;
};

export type MarkdownResource = { meta: MarkdownMeta; content: string };

export const MARKDOWN_CONTENT_LIMIT = 256 * 1024;

export type FileBundleMeta = {
  name: string;
  tags?: string[];
  file_count: number;
  bytes: number;
  created_at: string;
  updated_at: string;
};

export type FileBundleEntry = { rel_path: string; bytes: number };
export type FileBundleDetail = { meta: FileBundleMeta; entries: FileBundleEntry[] };

export type SecretMeta = {
  name: string;
  created_at: string;
  updated_at: string;
  description: string;
  byte_length: number;
};

export type TestResult = {
  ok: boolean;
  hops: number;
  exit_code: number;
  stdout: string;
  stderr: string;
};

export type Status = {
  home: string;
  version: string;
  dev: boolean;
  /** Random per-process ID. Changes across daemon restarts. */
  instance_id: string;
};

export type UpdateCheckResult = {
  current: string;
  latest: string;
  tag: string;
  published_at: string;
  newer_available: boolean;
  asset_url: string | null;
  checksums_url: string | null;
  notes: string;
};

export type UpdatePhase =
  | "idle" | "downloading" | "verifying" | "preflight"
  | "stopping-forwards" | "swapping" | "restarting" | "done" | "error";

export type UpdateStatus = {
  phase: UpdatePhase;
  message?: string;
  bytes_downloaded?: number;
  bytes_total?: number;
  target_tag?: string;
  error?: string;
  started_at?: string;
  finished_at?: string;
};

export type CcSessionEntry = {
  uuid: string;
  workdir: string;
  mtime: number;   // epoch seconds
  size: number;    // bytes
  preview: string; // first ~160 chars of the opening user message
  has_active_process: boolean;
};

export type SessionStatus = "provisioning" | "active" | "exited" | "failed_to_start";
export type AgentKind = "generic-cmd" | "claude-code";
export type Session = {
  id: string;
  machine: string;
  workdir: string;
  agent_kind: AgentKind;
  cmd: string;
  tmux_session: string;
  status: SessionStatus;
  created_at: string;
  started_at?: string;
  exited_at?: string;
  exit_code?: number;
  remote_events_offset?: number;
  remote_raw_offset?: number;
  cc_session_file?: string;
  cc_session_uuid?: string;
  terminal_local_port?: number;
  terminal_remote_port?: number;
  filebrowser_local_port?: number;
  filebrowser_remote_port?: number;
  codeserver_local_port?: number;
  codeserver_remote_port?: number;
  codeserver_workdir?: string;
  remote_transcript_offset?: number;
  remote_transcript_size?: number;
  last_raw_at?: string;
  last_transcript_at?: string;
  activity?: "running" | "pending" | "syncing";
  cc_skip_trust?: boolean;
  cc_resume_uuid?: string;
  launch_command?: string;
  cc_agent_teams?: boolean;
  alias?: string;
  alias_color?: string;
  tags?: string[];
};
export type SessionEventRecord = {
  ts: string;
  kind: string;
  [k: string]: unknown;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let msg: string;
    try {
      const body = (await res.json()) as { error?: string };
      msg = body.error ?? `${res.status} ${res.statusText}`;
    } catch {
      msg = `${res.status} ${res.statusText}`;
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export const api = {
  status: () => request<Status>("/api/status"),
  checkUpdate: () => request<UpdateCheckResult>("/api/update/check"),

  // --- resources / git-repo ---
  listGitRepos: () => request<GitRepoResource[]>("/api/resources/git-repo"),
  getGitRepo: (name: string) =>
    request<GitRepoResource>(`/api/resources/git-repo/${encodeURIComponent(name)}`),
  createGitRepo: (body: Pick<GitRepoResource, "name" | "url"> & Partial<GitRepoResource>) =>
    request<GitRepoResource>("/api/resources/git-repo", { method: "POST", body: JSON.stringify(body) }),
  updateGitRepo: (name: string, body: Partial<GitRepoResource>) =>
    request<GitRepoResource>(`/api/resources/git-repo/${encodeURIComponent(name)}`, {
      method: "PUT", body: JSON.stringify(body),
    }),
  deleteGitRepo: (name: string) =>
    request<{ ok: true }>(`/api/resources/git-repo/${encodeURIComponent(name)}`, { method: "DELETE" }),
  probeGitRepo: (body: { url: string; deploy_key?: string }) =>
    request<{ default_branch: string | null; branches: string[] }>(
      "/api/resources/git-repo/probe",
      { method: "POST", body: JSON.stringify(body) },
    ),

  // --- resources / markdown ---
  listMarkdowns: () => request<MarkdownMeta[]>("/api/resources/markdown"),
  getMarkdown: (name: string) =>
    request<MarkdownResource>(`/api/resources/markdown/${encodeURIComponent(name)}`),
  createMarkdown: (body: { name: string; tags?: string[]; content?: string }) =>
    request<MarkdownMeta>("/api/resources/markdown", { method: "POST", body: JSON.stringify(body) }),
  updateMarkdown: (name: string, body: { tags?: string[]; content?: string }) =>
    request<MarkdownMeta>(`/api/resources/markdown/${encodeURIComponent(name)}`, {
      method: "PUT", body: JSON.stringify(body),
    }),
  deleteMarkdown: (name: string) =>
    request<{ ok: true }>(`/api/resources/markdown/${encodeURIComponent(name)}`, { method: "DELETE" }),

  // --- resources / file-bundle ---
  listFileBundles: () => request<FileBundleMeta[]>("/api/resources/file-bundle"),
  getFileBundle: (name: string) =>
    request<FileBundleDetail>(`/api/resources/file-bundle/${encodeURIComponent(name)}`),
  /** Mode (a): multipart upload of many files + a paths JSON array. */
  createFileBundleFromFiles: async (body: {
    name: string;
    tags?: string;
    files: Array<{ file: File; rel_path: string }>;
  }) => {
    const fd = new FormData();
    fd.append("name", body.name);
    if (body.tags) fd.append("tags", body.tags);
    const paths: string[] = [];
    for (const f of body.files) {
      paths.push(f.rel_path);
      fd.append("files", f.file);
    }
    fd.append("paths", JSON.stringify(paths));
    const res = await fetch("/api/resources/file-bundle/files", { method: "POST", body: fd });
    if (!res.ok) {
      let msg: string;
      try { msg = ((await res.json()) as { error?: string }).error ?? `${res.status} ${res.statusText}`; }
      catch { msg = `${res.status} ${res.statusText}`; }
      throw new Error(msg);
    }
    return (await res.json()) as FileBundleMeta;
  },
  /** Mode (c): multipart upload of a single archive file. */
  createFileBundleFromArchive: async (body: {
    name: string;
    tags?: string;
    archive: File;
  }) => {
    const fd = new FormData();
    fd.append("name", body.name);
    if (body.tags) fd.append("tags", body.tags);
    fd.append("archive", body.archive);
    const res = await fetch("/api/resources/file-bundle/archive", { method: "POST", body: fd });
    if (!res.ok) {
      let msg: string;
      try { msg = ((await res.json()) as { error?: string }).error ?? `${res.status} ${res.statusText}`; }
      catch { msg = `${res.status} ${res.statusText}`; }
      throw new Error(msg);
    }
    return (await res.json()) as FileBundleMeta;
  },
  deleteFileBundle: (name: string) =>
    request<{ ok: true }>(`/api/resources/file-bundle/${encodeURIComponent(name)}`, { method: "DELETE" }),
  updateStatus: () => request<UpdateStatus>("/api/update/status"),
  installUpdate: () =>
    request<{ accepted: true; target: string }>("/api/update/install", { method: "POST" }),

  listKeys: () => request<KeyMeta[]>("/api/keys"),
  getKey: (nickname: string) => request<KeyDetail>(`/api/keys/${encodeURIComponent(nickname)}`),
  createKey: (body: { nickname: string; comment?: string; private_key?: string }) =>
    request<KeyMeta>("/api/keys", { method: "POST", body: JSON.stringify(body) }),
  deleteKey: (nickname: string) =>
    request<{ ok: true }>(`/api/keys/${encodeURIComponent(nickname)}`, { method: "DELETE" }),

  listMachines: () => request<Machine[]>("/api/machines"),
  getMachine: (name: string) => request<Machine>(`/api/machines/${encodeURIComponent(name)}`),
  createMachine: (m: Machine) =>
    request<Machine>("/api/machines", { method: "POST", body: JSON.stringify(m) }),
  updateMachine: (name: string, m: Machine) =>
    request<Machine>(`/api/machines/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify(m),
    }),
  deleteMachine: (name: string) =>
    request<{ ok: true }>(`/api/machines/${encodeURIComponent(name)}`, { method: "DELETE" }),
  enableLocalMachine: () =>
    request<Machine>("/api/machines/local/enable", { method: "POST" }),
  disableLocalMachine: () =>
    request<Machine>("/api/machines/local/disable", { method: "POST" }),
  testMachine: (name: string) =>
    request<TestResult>(`/api/machines/${encodeURIComponent(name)}/test`, { method: "POST" }),
  browseMachine: (name: string, path: string) =>
    request<{ expanded: string; dir: string; entries: Array<{ name: string; kind: "dir" | "file" }>; error?: string }>(
      `/api/machines/${encodeURIComponent(name)}/browse?path=${encodeURIComponent(path)}`,
    ),
  listCcSessions: (name: string) =>
    request<{ sessions: CcSessionEntry[]; error?: string }>(
      `/api/machines/${encodeURIComponent(name)}/cc-sessions`,
    ),
  startMachineTerminal: (name: string) =>
    request<{ forward: Forward; status: ForwardWithStatus["status"]; url: string }>(
      `/api/machines/${encodeURIComponent(name)}/terminal/start`, { method: "POST" },
    ),
  stopMachineTerminal: (name: string) =>
    request<{ ok: true }>(`/api/machines/${encodeURIComponent(name)}/terminal/stop`, { method: "POST" }),

  listSecrets: () => request<SecretMeta[]>("/api/secrets"),
  getSecret: (name: string) => request<SecretMeta>(`/api/secrets/${encodeURIComponent(name)}`),
  getSecretValue: (name: string) =>
    request<{ value: string }>(`/api/secrets/${encodeURIComponent(name)}/value`),
  createSecret: (body: { name: string; value: string; description?: string }) =>
    request<SecretMeta>("/api/secrets", { method: "POST", body: JSON.stringify(body) }),
  updateSecret: (name: string, body: { value: string; description?: string }) =>
    request<SecretMeta>(`/api/secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteSecret: (name: string) =>
    request<{ ok: true }>(`/api/secrets/${encodeURIComponent(name)}`, { method: "DELETE" }),

  listSessions: () => request<Session[]>("/api/sessions"),
  getSession: (id: string) => request<Session>(`/api/sessions/${encodeURIComponent(id)}`),
  createSession: (body: {
    machine: string;
    workdir: string;
    agent_kind: AgentKind;
    cmd: string;
    cc_skip_trust?: boolean;
    cc_resume_uuid?: string;
    launch_command?: string;
    cc_agent_teams?: boolean;
  }) => request<Session>("/api/sessions", { method: "POST", body: JSON.stringify(body) }),
  stopSession: (id: string) =>
    request<Session>(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: "POST" }),
  updateSessionMeta: (id: string, body: { alias?: string | null; alias_color?: string | null; tags?: string[] | null }) =>
    request<Session>(`/api/sessions/${encodeURIComponent(id)}/meta`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  sendSessionInput: (id: string, body: { text?: string; keys?: string[]; press_enter?: boolean }) =>
    request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/input`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteSession: (id: string) =>
    request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  getSessionNotes: (id: string) =>
    request<{ text: string }>(`/api/sessions/${encodeURIComponent(id)}/notes`),
  putSessionNotes: (id: string, text: string) =>
    request<{ ok: true; bytes: number }>(
      `/api/sessions/${encodeURIComponent(id)}/notes`,
      { method: "PUT", body: JSON.stringify({ text }) },
    ),
  startSessionFilebrowser: (id: string) =>
    request<{ ok: true; url: string; local_port: number; remote_port: number }>(
      `/api/sessions/${encodeURIComponent(id)}/filebrowser/start`, { method: "POST" },
    ),
  stopSessionFilebrowser: (id: string) =>
    request<{ ok: true }>(
      `/api/sessions/${encodeURIComponent(id)}/filebrowser/stop`, { method: "POST" },
    ),
  startSessionCodeServer: (id: string) =>
    request<{ ok: true; url: string; local_port: number; remote_port: number; workdir: string }>(
      `/api/sessions/${encodeURIComponent(id)}/code-server/start`, { method: "POST" },
    ),
  stopSessionCodeServer: (id: string) =>
    request<{ ok: true }>(
      `/api/sessions/${encodeURIComponent(id)}/code-server/stop`, { method: "POST" },
    ),
  getSessionTranscriptPage: (id: string, page: number, size = 20) =>
    request<{
      line_count: number;
      total_pages: number;
      page_index: number;
      page_size: number;
      start: number;
      end: number;
      text: string;
    }>(`/api/sessions/${encodeURIComponent(id)}/transcript/page?page=${page}&size=${size}`),
  getSessionEvents: (id: string, offset = 0) =>
    request<{ records: SessionEventRecord[]; nextOffset: number }>(
      `/api/sessions/${encodeURIComponent(id)}/events?offset=${offset}`,
    ),
  getSessionRaw: (id: string, offset = 0, max = 65536) =>
    request<{ data: string; nextOffset: number; size: number }>(
      `/api/sessions/${encodeURIComponent(id)}/raw?offset=${offset}&max=${max}`,
    ),
  getSessionTranscript: (id: string, offset = 0, max = 262144) =>
    request<{ data: string; nextOffset: number; size: number }>(
      `/api/sessions/${encodeURIComponent(id)}/transcript?offset=${offset}&max=${max}`,
    ),
  getSessionRecentTurns: (id: string, limit = 12) =>
    request<{ turns: Array<Record<string, unknown>> }>(
      `/api/sessions/${encodeURIComponent(id)}/recent-turns?limit=${limit}`,
    ),
  pushSessionContext: (id: string, body: {
    git_repos: Array<{ name: string; include_deploy_key: boolean }>;
    markdowns: Array<{ name: string }>;
    file_bundles: Array<{ name: string }>;
  }) => request<{
    pushed: Array<{
      kind: "git-repo" | "keys" | "markdown" | "file-bundle";
      name: string;
      path: string;
      wrote_private_key?: boolean;
      file_count?: number;
    }>;
    remote_base: string;
  }>(`/api/sessions/${encodeURIComponent(id)}/context/push`, {
    method: "POST",
    body: JSON.stringify(body),
  }),
};

export function sessionWatchUrl(id: string, offsets?: {
  events?: number; raw?: number; transcript?: number;
}): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams();
  if (offsets?.events)     params.set("events_offset", String(offsets.events));
  if (offsets?.raw)        params.set("raw_offset",    String(offsets.raw));
  if (offsets?.transcript) params.set("tx_offset",     String(offsets.transcript));
  const q = params.toString();
  return `${proto}//${window.location.host}/api/sessions/${encodeURIComponent(id)}/watch${q ? "?" + q : ""}`;
}

export type ForwardDirection = "local" | "remote" | "dynamic";
export type ForwardState = "idle" | "stopped" | "starting" | "running" | "failed";
export type Forward = {
  name: string;
  machine: string;
  direction: ForwardDirection;
  local_port: number;
  remote_host?: string;
  remote_port?: number;
  local_host?: string;
  auto_start?: boolean;
  description?: string;
  managed_by?: string;
};
export type ForwardWithStatus = Forward & {
  description_line: string;
  status: {
    name: string;
    state: ForwardState;
    pid?: number;
    started_at?: string;
    stopped_at?: string;
    exit_code?: number | null;
    exit_signal?: string | null;
    last_error?: string;
    last_args?: string[];
  };
};

export type CreditAccount = {
  nickname: string;
  provider: string;
  description: string;
  added_at: string;
  last_checked_at?: string;
  balance?: number;
  used?: number;
  limit?: number;
  unit?: string;
  period?: string;
  notes?: string;
  last_refresh_error?: string;
};

export const creditsApi = {
  list: () => request<CreditAccount[]>("/api/credits"),
  get: (nickname: string) => request<CreditAccount>(`/api/credits/${encodeURIComponent(nickname)}`),
  create: (body: CreditAccount & { credential?: string }) =>
    request<CreditAccount>("/api/credits", { method: "POST", body: JSON.stringify(body) }),
  update: (nickname: string, body: Partial<CreditAccount> & { credential?: string }) =>
    request<CreditAccount>(`/api/credits/${encodeURIComponent(nickname)}`, {
      method: "PUT", body: JSON.stringify(body),
    }),
  remove: (nickname: string) =>
    request<{ ok: true }>(`/api/credits/${encodeURIComponent(nickname)}`, { method: "DELETE" }),
  getCredential: (nickname: string) =>
    request<{ credential: string }>(`/api/credits/${encodeURIComponent(nickname)}/credential`),
  refresh: (nickname: string) =>
    request<CreditAccount>(`/api/credits/${encodeURIComponent(nickname)}/refresh`, { method: "POST" }),
};

export const forwardsApi = {
  list: () => request<ForwardWithStatus[]>("/api/forwards"),
  get: (name: string) => request<ForwardWithStatus>(`/api/forwards/${encodeURIComponent(name)}`),
  create: (f: Forward) => request<ForwardWithStatus>("/api/forwards", { method: "POST", body: JSON.stringify(f) }),
  update: (name: string, f: Forward) =>
    request<ForwardWithStatus>(`/api/forwards/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(f) }),
  remove: (name: string) => request<{ ok: true }>(`/api/forwards/${encodeURIComponent(name)}`, { method: "DELETE" }),
  start:  (name: string) => request<unknown>(`/api/forwards/${encodeURIComponent(name)}/start`, { method: "POST" }),
  stop:   (name: string) => request<unknown>(`/api/forwards/${encodeURIComponent(name)}/stop`,  { method: "POST" }),
};
