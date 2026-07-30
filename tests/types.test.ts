import { test, expect } from "bun:test";
import type { Candidate, RankedCandidate, Policy } from "../src/types";

test("types module is importable and the trimmed Candidate shape is usable", () => {
  const policy: Policy = "lossless-first";
  const c: Candidate = {
    username: "u", filename: "a.flac", size: 1, format: "flac",
    bitRate: null, reason: "",
  };
  expect(policy).toBe("lossless-first");
  expect(c.format).toBe("flac");
});

test("RankedCandidate carries the full internal ranking shape", () => {
  const c: RankedCandidate = {
    username: "u", filename: "a.flac", size: 1, format: "flac", lossless: true,
    bitRate: null, lengthSeconds: null, hasFreeUploadSlot: true, queueLength: 0,
    uploadSpeed: 0, score: 0, reason: "", suspectFake: false,
  };
  expect(c.score).toBe(0);
});
