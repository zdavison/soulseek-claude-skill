import { test, expect } from "bun:test";
import { handleSearch, handleDownload, handleStatus } from "../src/mcp-server";

// Minimal fake client implementing only what each handler uses.
function fakeClient(over: any = {}) {
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
    ...over,
  } as any;
}

test("handleSearch returns ranked candidates, flac first", async () => {
  const out = await handleSearch(fakeClient(), { query: "x", policy: "lossless-first" });
  expect(out.candidates[0].format).toBe("flac");
  expect(out.candidates[0].username).toBe("alice");
});

test("handleSearch defaults policy to lossless-first", async () => {
  const out = await handleSearch(fakeClient(), { query: "x" } as any);
  expect(out.candidates[0].format).toBe("flac");
});

test("handleDownload returns transferId", async () => {
  const out = await handleDownload(fakeClient(), { username: "alice", filename: "a.flac", size: 28000000 });
  expect(out.transferId).toBe("tid-9");
});

test("handleStatus passes through normalized status", async () => {
  const out = await handleStatus(fakeClient(), { username: "alice", transferId: "tid-9" });
  expect(out.phase).toBe("succeeded");
  expect(out.percentComplete).toBe(100);
});
