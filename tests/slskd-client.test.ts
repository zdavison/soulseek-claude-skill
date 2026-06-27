import { test, expect, mock, afterEach } from "bun:test";
import { SlskdClient, normalizePhase } from "../src/slskd-client";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(routes: Record<string, () => Response>) {
  globalThis.fetch = mock(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    // Prefer "METHOD substring" keys; fall back to plain substring keys.
    for (const key of Object.keys(routes)) {
      const sp = key.indexOf(" ");
      if (sp > 0 && /^[A-Z]+$/.test(key.slice(0, sp))) {
        const [m, sub] = [key.slice(0, sp), key.slice(sp + 1)];
        if (m === method && url.includes(sub)) return routes[key]();
      } else if (url.includes(key)) {
        return routes[key]();
      }
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
  let posted = false;
  mockFetch({
    "POST /api/v0/downloads/peer": () => { posted = true; return new Response(null, { status: 201 }); },
    "GET /api/v0/downloads/peer": () =>
      Response.json({
        username: "peer",
        directories: [{ files: [{ id: "tid-1", filename: "Song.flac", size: 100 }] }],
      }),
  });
  const c = new SlskdClient("http://localhost:5030", "k");
  const id = await c.enqueue("peer", "Song.flac", 100);
  expect(posted).toBe(true);
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

test("transferStatus falls back to bytesReceived when bytesTransferred is absent", async () => {
  mockFetch({
    "/api/v0/downloads/peer/tid-2": () =>
      Response.json({ id: "tid-2", state: "InProgress", size: 100, bytesReceived: 25, averageSpeed: 10 }),
  });
  const c = new SlskdClient("http://localhost:5030", "k");
  const s = await c.transferStatus("peer", "tid-2");
  expect(s.phase).toBe("in_progress");
  expect(s.percentComplete).toBe(25);
});

test("health returns connected:false for state 'Disconnected'", async () => {
  mockFetch({
    "/health": () => new Response("Healthy", { status: 200 }),
    "/api/v0/application": () =>
      Response.json({ version: "0.21.0", server: { state: "Disconnected" } }),
  });
  const c = new SlskdClient("http://localhost:5030", "k");
  const h = await c.health();
  expect(h.healthy).toBe(true);
  expect(h.connected).toBe(false);
});

test("enqueue disambiguates by size when multiple files share the same filename", async () => {
  let posted = false;
  mockFetch({
    "POST /api/v0/downloads/peer": () => { posted = true; return new Response(null, { status: 201 }); },
    "GET /api/v0/downloads/peer": () =>
      Response.json({
        username: "peer",
        directories: [{
          files: [
            { id: "tid-wrong", filename: "Song.flac", size: 999, state: "Queued" },
            { id: "tid-right", filename: "Song.flac", size: 100, state: "Queued" },
          ],
        }],
      }),
  });
  const c = new SlskdClient("http://localhost:5030", "k");
  const id = await c.enqueue("peer", "Song.flac", 100);
  expect(posted).toBe(true);
  expect(id).toBe("tid-right");
});
