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

export type Status = { home: string; version: string; dev: boolean };

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
};
