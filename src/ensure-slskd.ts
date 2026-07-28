// Lazy-launch a local slskd on demand. Memoized: the first caller spawns slskd
// (if not already up) and every caller awaits the same readiness promise.
// Dependencies are injected so this is unit-testable without a real slskd,
// binary, or network.

import { resolveSlskdBinaryDefault } from "./slskd-binary";

export interface EnsureDeps {
  env: Record<string, string | undefined>;
  fetch: (url: string) => Promise<{ ok: boolean }>;
  spawn: (cmd: string[], env: Record<string, string>) => void;
  // Resolves a runnable slskd binary path: SLSKD_BINARY override, else a slskd
  // on PATH, else a cached/auto-downloaded release (see slskd-binary.ts). This
  // is what lets the native launch work in a sandbox with no slskd preinstalled.
  resolveBinary: (env: Record<string, string | undefined>) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const HEALTH_TIMEOUT_MS = 60_000;
const POLL_MS = 1_000;

const defaultDeps: EnsureDeps = {
  env: process.env,
  fetch: (url) => fetch(url),
  spawn: (cmd, env) => {
    Bun.spawn(cmd, { env, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  },
  resolveBinary: (env) => resolveSlskdBinaryDefault(env),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

let readiness: Promise<void> | null = null;

export function resetEnsureSlskdForTests(): void {
  readiness = null;
}

export function ensureSlskd(deps: Partial<EnsureDeps> = {}): Promise<void> {
  const d: EnsureDeps = { ...defaultDeps, ...deps };
  if (!readiness) {
    readiness = launch(d).catch((err) => {
      readiness = null;
      throw err;
    });
  }
  return readiness;
}

async function isHealthy(d: EnsureDeps, baseUrl: string): Promise<boolean> {
  try {
    const res = await d.fetch(`${baseUrl}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function launch(d: EnsureDeps): Promise<void> {
  const baseUrl = (d.env.SLSKD_BASE_URL ?? "http://localhost:5030").replace(/\/$/, "");
  if (await isHealthy(d, baseUrl)) return;

  const bareKey = d.env.SLSKD_API_KEY;
  if (!bareKey) throw new Error("SLSKD_API_KEY is required to launch slskd");
  const binary = await d.resolveBinary(d.env);

  const childEnv = stringEnv(d.env);
  childEnv.SLSKD_API_KEY = `role=Administrator;cidr=0.0.0.0/0,::/0;${bareKey}`;
  d.spawn([binary], childEnv);

  const deadline = d.now() + HEALTH_TIMEOUT_MS;
  while (d.now() < deadline) {
    await d.sleep(POLL_MS);
    if (await isHealthy(d, baseUrl)) return;
  }
  throw new Error("slskd did not become healthy within 60s");
}

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}
