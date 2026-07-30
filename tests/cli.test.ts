import { test, expect } from "bun:test";
import { runCli, parseOpts, type ClientLike, type CliDeps } from "../src/cli";

// Minimal fake client implementing only what the CLI uses (mirrors the old
// mcp-handlers fake — same fixtures so ranking behaviour stays covered).
function fakeClient(over: any = {}): ClientLike {
  return {
    searchAndCollect: async () => [
      { username: "alice", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 500000,
        files: [{ filename: "a.flac", size: 28000000, bitRate: null, length: 245 }] },
      { username: "bob", hasFreeUploadSlot: false, queueLength: 3, uploadSpeed: 1000,
        files: [{ filename: "b.mp3", size: 9800000, bitRate: 320, length: 245 }] },
    ],
    enqueue: async () => "tid-9",
    transferStatus: async () => ({ id: "tid-9", phase: "succeeded", rawState: "Completed, Succeeded",
      size: 100, bytesTransferred: 100, percentComplete: 100, averageSpeed: 5 }),
    cancel: async () => undefined,
    health: async () => ({ healthy: true, connected: true, version: "1.0.0" }),
    ...over,
  } as any;
}

class FailError extends Error {}

function deps(over: Partial<CliDeps> = {}): { d: CliDeps; out: unknown[]; order: string[] } {
  const out: unknown[] = [];
  const order: string[] = [];
  const d: CliDeps = {
    client: fakeClient(),
    ensure: async () => { order.push("ensure"); },
    readStdin: async () => "",
    write: (data) => { out.push(data); },
    fail: (msg) => { throw new FailError(msg); },
    ...over,
  };
  return { d, out, order };
}

test("parseOpts reads --key value pairs", () => {
  expect(parseOpts(["--query", "hi there", "--policy", "lossless-only"]))
    .toEqual({ query: "hi there", policy: "lossless-only" });
});

test("search returns ranked candidates, flac first", async () => {
  const { d, out } = deps();
  await runCli(["search", "--query", "x", "--policy", "lossless-first"], d);
  expect((out[0] as any).candidates[0].format).toBe("flac");
  expect((out[0] as any).candidates[0].username).toBe("alice");
});

test("search defaults policy to lossless-first", async () => {
  const { d, out } = deps();
  await runCli(["search", "--query", "x"], d);
  expect((out[0] as any).candidates[0].format).toBe("flac");
});

test("search requires --query", async () => {
  const { d } = deps();
  await expect(runCli(["search"], d)).rejects.toThrow("--query is required");
});

test("download reads candidate JSON from stdin and returns transferId", async () => {
  const { d, out } = deps({
    readStdin: async () => JSON.stringify({ username: "alice", filename: "a.flac", size: 28000000 }),
  });
  await runCli(["download"], d);
  expect(out[0]).toEqual({ transferId: "tid-9" });
});

test("download rejects malformed stdin", async () => {
  const { d } = deps({ readStdin: async () => "{ not json" });
  await expect(runCli(["download"], d)).rejects.toThrow("not valid JSON");
});

test("download rejects a candidate missing fields", async () => {
  const { d } = deps({ readStdin: async () => JSON.stringify({ username: "alice" }) });
  await expect(runCli(["download"], d)).rejects.toThrow("username");
});

test("status passes through normalized status", async () => {
  const { d, out } = deps();
  await runCli(["status", "--username", "alice", "--transferId", "tid-9"], d);
  expect((out[0] as any).phase).toBe("succeeded");
  expect((out[0] as any).percentComplete).toBe(100);
});

test("cancel cancels with remove=true and reports cancelled", async () => {
  const calls: any[] = [];
  const { d, out } = deps({ client: fakeClient({ cancel: async (...args: any[]) => { calls.push(args); } }) });
  await runCli(["cancel", "--username", "alice", "--transferId", "tid-9"], d);
  expect(out[0]).toEqual({ cancelled: true });
  expect(calls[0]).toEqual(["alice", "tid-9", true]);
});

test("health passes through client.health", async () => {
  const { d, out } = deps({
    client: fakeClient({ health: async () => ({ healthy: true, connected: true, version: "1.2.3" }) }),
  });
  await runCli(["health"], d);
  expect(out[0]).toEqual({ healthy: true, connected: true, version: "1.2.3" });
});

test("ensure runs before the command talks to slskd", async () => {
  const order: string[] = [];
  const { d } = deps({
    ensure: async () => { order.push("ensure"); },
    client: fakeClient({
      health: async () => { order.push("health"); return { healthy: true, connected: true, version: "1" }; },
    }),
  });
  await runCli(["health"], d);
  expect(order).toEqual(["ensure", "health"]);
});

test("unknown command fails with usage", async () => {
  const { d } = deps();
  await expect(runCli(["nope"], d)).rejects.toThrow("unknown command");
});
