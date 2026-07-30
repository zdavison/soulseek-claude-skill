import { test, expect } from "bun:test";
import { classifyFormat, pickBest, rankCandidates, DEFAULT_SEARCH_LIMIT } from "../src/pick-best";
import type { SlskdSearchResponse } from "../src/types";

function resp(over: Partial<SlskdSearchResponse> & { files: any[] }): SlskdSearchResponse {
  return { username: "peer", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1000, ...over };
}

test("classifyFormat reads extension case-insensitively", () => {
  expect(classifyFormat("song.FLAC")).toBe("flac");
  expect(classifyFormat("song.mp3")).toBe("mp3");
  expect(classifyFormat("a/b/c.m4a")).toBe("aac");
  expect(classifyFormat("x.txt")).toBe("other");
});

test("lossless ranks above mp3 under lossless-first", () => {
  const r = [resp({ files: [
    { filename: "song.mp3", size: 9_600_000, bitRate: 320, length: 240 },
    { filename: "song.flac", size: 27_000_000, bitRate: null, length: 240 },
  ]})];
  const out = pickBest(r, "lossless-first");
  expect(out[0].format).toBe("flac");
  expect(out[1].format).toBe("mp3");
});

test("fake FLAC (impossibly small) is dropped", () => {
  const r = [resp({ files: [
    { filename: "fake.flac", size: 3_000_000, bitRate: null, length: 240 }, // ~100 kbps -> fake
    { filename: "real.flac", size: 27_000_000, bitRate: null, length: 240 },
  ]})];
  const out = pickBest(r, "lossless-first");
  expect(out.map((c) => c.filename)).toEqual(["real.flac"]);
});

test("sanity check abstains when length is unknown", () => {
  const r = [resp({ files: [
    { filename: "unknown.flac", size: 3_000_000, bitRate: null, length: null },
  ]})];
  const out = rankCandidates(r, "lossless-first");
  expect(out).toHaveLength(1);
  expect(out[0].suspectFake).toBe(false);
});

test("lossless-only returns empty when no lossless present", () => {
  const r = [resp({ files: [{ filename: "song.mp3", size: 9_600_000, bitRate: 320, length: 240 }]})];
  expect(pickBest(r, "lossless-only")).toHaveLength(0);
});

test("best-available keeps mp3 and ranks higher bitrate first", () => {
  const r = [resp({ files: [
    { filename: "lo.mp3", size: 3_840_000, bitRate: 128, length: 240 },
    { filename: "hi.mp3", size: 9_600_000, bitRate: 320, length: 240 },
  ]})];
  const out = pickBest(r, "best-available");
  expect(out[0].filename).toBe("hi.mp3");
});

test("free upload slot beats busy peer at equal format", () => {
  const r = [
    resp({ username: "busy", hasFreeUploadSlot: false, queueLength: 5,
      files: [{ filename: "a.flac", size: 27_000_000, bitRate: null, length: 240 }] }),
    resp({ username: "free", hasFreeUploadSlot: true, queueLength: 0,
      files: [{ filename: "b.flac", size: 27_000_000, bitRate: null, length: 240 }] }),
  ];
  const out = pickBest(r, "lossless-first");
  expect(out[0].username).toBe("free");
});

test("every candidate has a non-empty reason string", () => {
  const r = [resp({ files: [{ filename: "song.flac", size: 27_000_000, bitRate: null, length: 240 }]})];
  expect(pickBest(r, "lossless-first")[0].reason.length).toBeGreaterThan(0);
});

test("soft-floor lossless is kept but flagged suspectFake and penalized", () => {
  const r = [resp({ files: [
    { filename: "suspect.flac", size: 10_500_000, bitRate: null, length: 240 }, // ~350 kbps
  ]})];
  const out = rankCandidates(r, "lossless-first");
  expect(out).toHaveLength(1);
  expect(out[0].suspectFake).toBe(true);
  expect(out[0].score).toBeLessThan(1000);
});

test("sanity check abstains when size is unknown", () => {
  const r = [resp({ files: [
    { filename: "nosize.flac", size: 0, bitRate: null, length: 240 },
  ]})];
  const out = rankCandidates(r, "lossless-first");
  expect(out).toHaveLength(1);
  expect(out[0].suspectFake).toBe(false);
});

test("pickBest caps output at DEFAULT_SEARCH_LIMIT and projects the lean shape", () => {
  const files = Array.from({ length: 20 }, (_, i) => ({
    filename: `t${i}.flac`, size: 27_000_000 + i, bitRate: null, length: 240,
  }));
  const out = pickBest([resp({ files })], "lossless-first");
  expect(DEFAULT_SEARCH_LIMIT).toBe(8);
  expect(out).toHaveLength(8);
  expect(Object.keys(out[0]).sort()).toEqual(
    ["bitRate", "filename", "format", "reason", "size", "username"],
  );
});

test("rankCandidates is uncapped and retains ranking-internal fields", () => {
  const files = Array.from({ length: 20 }, (_, i) => ({
    filename: `t${i}.flac`, size: 27_000_000 + i, bitRate: null, length: 240,
  }));
  const out = rankCandidates([resp({ files })], "lossless-first");
  expect(out).toHaveLength(20);
  expect(out[0]).toHaveProperty("score");
  expect(out[0]).toHaveProperty("suspectFake");
});
