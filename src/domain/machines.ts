import { existsSync, readdirSync, rmSync } from "node:fs";
import { DataDir, assertSafeName, readToml, writeToml } from "../storage/index.ts";
import { keyExists } from "./keys.ts";

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

export function listMachines(dir: DataDir): Machine[] {
  const root = dir.machinesDir();
  if (!existsSync(root)) return [];
  const out: Machine[] = [];
  for (const file of readdirSync(root)) {
    if (!file.endsWith(".toml")) continue;
    const name = file.slice(0, -5);
    try { assertSafeName(name, "machine name"); } catch { continue; }
    out.push(readToml<Machine>(`${root}/${file}`));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function readMachine(dir: DataDir, name: string): Machine {
  const path = dir.machineFile(name);
  if (!existsSync(path)) throw new Error(`machine not found: ${name}`);
  return readToml<Machine>(path);
}

export function writeMachine(dir: DataDir, machine: Machine): void {
  assertSafeName(machine.name, "machine name");
  validateKeyRefs(dir, machine);
  const data: Record<string, unknown> = {
    name: machine.name,
    host: machine.host,
    user: machine.user,
    key: machine.key,
  };
  if (machine.port !== undefined) data.port = machine.port;
  if (machine.tags && machine.tags.length) data.tags = machine.tags;
  if (machine.notes) data.notes = machine.notes;
  if (machine.jump && machine.jump.length) {
    data.jump = machine.jump.map((j) => {
      const hop: Record<string, unknown> = { host: j.host, user: j.user, key: j.key };
      if (j.port !== undefined) hop.port = j.port;
      return hop;
    });
  }
  writeToml(dir.machineFile(machine.name), data);
}

export function deleteMachine(dir: DataDir, name: string): void {
  const path = dir.machineFile(name);
  if (!existsSync(path)) throw new Error(`machine not found: ${name}`);
  rmSync(path);
}

function validateKeyRefs(dir: DataDir, machine: Machine): void {
  const refs = [machine.key, ...(machine.jump?.map((j) => j.key) ?? [])];
  for (const k of refs) {
    if (!keyExists(dir, k)) {
      throw new Error(`referenced key nickname not found: ${k}`);
    }
  }
}
