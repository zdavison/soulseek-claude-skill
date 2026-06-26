import { test, expect, mock, afterEach } from "bun:test";
import { SlskdClient, normalizePhase } from "../src/slskd-client";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(routes: Record<string, () => Response>) {
  globalThis.fetch = mock(async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    for (const key of Object.keys(routes)) {
      if (url.includes(key)) return routes[key]();
    }
    return new Response("not found", { status: 404 });
  }) as any;
}

test("normalizePhase maps slskd flag strings", () => {
  expect(normalizePhase("Completed, Succeeded")).toBe("succeeded");
  expect(normalizePhase("InProgress")).toBe("in_progress");
  expect(normalizePhase("Queued, Remotely")).toBe("queued");
  expect(normalizePhase("Completed, Errored")).toBe("failed");
  expect(normalizePhase("Completed, Cancelled")).toBe("failed");
  expect(normalizePhase("Completed, TimedOut")).toBe("failed");
  expect(normalizePhase("Completed, Rejected")).toBe("failed");
});

test("health reports connected from /api/v0/application", async () => {
  mockFetch({
    "/health": () => new Response("Healthy", { status: 200 }),
    "/api/v0/application": () =>
      Response.json({ version: "0.21.0", server: { state: "Connected, LoggedIn" } }),
  });
  const c = new SlskdClient("http://localhost:5030", "k");
  const h = await c.health();
  expect(h.healthy).toBe(true);
  expect(h.connected).toBe(true);
  expect(h.version).toBe("0.21.0");
});

test("searchAndCollect creates search, polls, returns responses", async () => {
  let polls = 0;
  mockFetch({
    "/api/v0/searches/abc/responses": () =>
      Response.json([{ username: "u", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1, files: [] }]),
    "/api/v0/searches/abc": () => {
      polls++;
      return Response.json({ id: "abc", isComplete: polls >= 2, responseCount: polls });
    },
    "/api/v0/searches": () => Response.json({ id: "abc" }),
  });
  const c = new SlskdClient("http://localhost:5030", "k");
  const out = await c.searchAndCollect("query", { timeoutMs: 2000, minResponses: 1, pollMs: 1 });
  expect(out).toHaveLength(1);
  expect(out[0].username).toBe("u");
});

test("enqueue posts files and looks up the transfer id", async () => {
  mockFetch({
    "/api/v0/downloads/peer/": () => new Response(null, { status: 201 }), // POST enqueue
    "/api/v0/downloads/peer": () =>
      Response.json({
        username: "peer",
        directories: [{ files: [{ id: "tid-1", filename: "Song.flac", size: 100 }] }],
      }),
  });
  const c = new SlskdClient("http://localhost:5030", "k");
  const id = await c.enqueue("peer", "Song.flac", 100);
  expect(id).toBe("tid-1");
});

test("transferStatus computes percentComplete", async () => {
  mockFetch({
    "/api/v0/downloads/peer/tid-1": () =>
      Response.json({ id: "tid-1", state: "InProgress", size: 100, bytesTransferred: 25, averageSpeed: 10 }),
  });
  const c = new SlskdClient("http://localhost:5030", "k");
  const s = await c.transferStatus("peer", "tid-1");
  expect(s.phase).toBe("in_progress");
  expect(s.percentComplete).toBe(25);
});
