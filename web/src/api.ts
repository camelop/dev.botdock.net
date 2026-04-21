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
};

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
  remote_transcript_offset?: number;
  last_raw_at?: string;
  last_transcript_at?: string;
  activity?: "running" | "pending";
  cc_skip_trust?: boolean;
  cc_resume_uuid?: string;
  alias?: string;
  alias_color?: string;
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
  }) => request<Session>("/api/sessions", { method: "POST", body: JSON.stringify(body) }),
  stopSession: (id: string) =>
    request<Session>(`/api/sessions/${encodeURIComponent(id)}/stop`, { method: "POST" }),
  updateSessionMeta: (id: string, body: { alias?: string | null; alias_color?: string | null }) =>
    request<Session>(`/api/sessions/${encodeURIComponent(id)}/meta`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  sendSessionInput: (id: string, body: { text?: string; keys?: string[] }) =>
    request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}/input`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteSession: (id: string) =>
    request<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
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
};

export function sessionWatchUrl(id: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/sessions/${encodeURIComponent(id)}/watch`;
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
