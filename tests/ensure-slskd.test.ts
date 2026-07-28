import { test, expect, beforeEach } from "bun:test";
import { ensureSlskd, resetEnsureSlskdForTests, type EnsureDeps } from "../src/ensure-slskd";

beforeEach(() => resetEnsureSlskdForTests());

function makeFetch(oks: boolean[]) {
  let i = 0;
  return async () => {
    const ok = oks[Math.min(i, oks.length - 1)];
    i++;
    return { ok } as Response;
  };
}

function deps(over: Partial<EnsureDeps> = {}) {
  const spawned: Array<{ cmd: string[]; env: Record<string, string> }> = [];
  let t = 0;
  const base: EnsureDeps = {
    env: { SLSKD_BASE_URL: "http://localhost:5030", SLSKD_API_KEY: "abc123", SLSKD_BINARY: "slskd" },
    fetch: makeFetch([false]),
    spawn: (cmd, env) => { spawned.push({ cmd, env }); },
    // Hermetic stub: honor SLSKD_BINARY without probing PATH or downloading.
    resolveBinary: async (env) => env.SLSKD_BINARY ?? "slskd",
    sleep: async () => {},
    now: () => (t += 1000),
  };
  return { d: { ...base, ...over }, spawned };
}

test("returns without spawning when slskd is already healthy", async () => {
  const { d, spawned } = deps({ fetch: makeFetch([true]) });
  await ensureSlskd(d);
  expect(spawned.length).toBe(0);
});

test("spawns slskd with a role-formatted primary key, then resolves when healthy", async () => {
  const { d, spawned } = deps({ fetch: makeFetch([false, true]) });
  await ensureSlskd(d);
  expect(spawned.length).toBe(1);
  expect(spawned[0].cmd).toEqual(["slskd"]);
  expect(spawned[0].env.SLSKD_API_KEY).toBe("role=Administrator;cidr=0.0.0.0/0,::/0;abc123");
});

test("spawns the binary chosen by resolveBinary (e.g. an auto-downloaded path)", async () => {
  const { d, spawned } = deps({
    env: { SLSKD_BASE_URL: "http://localhost:5030", SLSKD_API_KEY: "abc123" },
    fetch: makeFetch([false, true]),
    resolveBinary: async () => "/home/u/.config/slskd/bin/slskd",
  });
  await ensureSlskd(d);
  expect(spawned.length).toBe(1);
  expect(spawned[0].cmd).toEqual(["/home/u/.config/slskd/bin/slskd"]);
});

test("memoizes: concurrent callers spawn slskd exactly once", async () => {
  const { d, spawned } = deps({ fetch: makeFetch([false, true]) });
  await Promise.all([ensureSlskd(d), ensureSlskd(d)]);
  expect(spawned.length).toBe(1);
});

test("throws when SLSKD_API_KEY is missing", async () => {
  const { d } = deps({ env: { SLSKD_BASE_URL: "http://localhost:5030" }, fetch: makeFetch([false]) });
  await expect(ensureSlskd(d)).rejects.toThrow("SLSKD_API_KEY");
});

test("rejects when slskd never becomes healthy", async () => {
  const { d } = deps({ fetch: makeFetch([false]) });
  await expect(ensureSlskd(d)).rejects.toThrow("did not become healthy");
});
