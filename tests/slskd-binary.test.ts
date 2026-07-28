import { test, expect } from "bun:test";
import {
  slskdAssetName,
  slskdDownloadUrl,
  resolveSlskdBinary,
  SLSKD_VERSION,
  type BinaryResolveDeps,
} from "../src/slskd-binary";

test("slskdAssetName maps platform/arch (and musl) to the release asset", () => {
  expect(slskdAssetName({ version: "0.26.0", platform: "darwin", arch: "arm64" }))
    .toBe("slskd-0.26.0-osx-arm64.zip");
  expect(slskdAssetName({ version: "0.26.0", platform: "darwin", arch: "x64" }))
    .toBe("slskd-0.26.0-osx-x64.zip");
  expect(slskdAssetName({ version: "0.26.0", platform: "linux", arch: "x64" }))
    .toBe("slskd-0.26.0-linux-x64.zip");
  expect(slskdAssetName({ version: "0.26.0", platform: "linux", arch: "arm64" }))
    .toBe("slskd-0.26.0-linux-arm64.zip");
  // musl (Alpine-based sandboxes) selects the musl asset — linux only.
  expect(slskdAssetName({ version: "0.26.0", platform: "linux", arch: "x64", musl: true }))
    .toBe("slskd-0.26.0-linux-musl-x64.zip");
  expect(slskdAssetName({ version: "0.26.0", platform: "darwin", arch: "arm64", musl: true }))
    .toBe("slskd-0.26.0-osx-arm64.zip");
});

test("slskdAssetName rejects unsupported platform/arch", () => {
  expect(() => slskdAssetName({ version: "0.26.0", platform: "sunos", arch: "x64" })).toThrow();
  expect(() => slskdAssetName({ version: "0.26.0", platform: "linux", arch: "mips" })).toThrow();
});

test("slskdDownloadUrl points at the slskd release asset", () => {
  expect(slskdDownloadUrl({ version: "0.26.0", asset: "slskd-0.26.0-linux-x64.zip" }))
    .toBe("https://github.com/slskd/slskd/releases/download/0.26.0/slskd-0.26.0-linux-x64.zip");
});

test("SLSKD_VERSION is a concrete version string", () => {
  expect(SLSKD_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

// --- resolveSlskdBinary branching (PATH-first, then cache, then download) ---

function makeDeps(over: Partial<BinaryResolveDeps> = {}) {
  const calls = { which: 0, exists: 0, download: [] as Array<{ url: string; binaryPath: string }> };
  const base: BinaryResolveDeps = {
    env: {},
    which: async () => { calls.which++; return null; },
    exists: async () => { calls.exists++; return false; },
    download: async (o) => { calls.download.push({ url: o.url, binaryPath: o.binaryPath }); },
    platform: "linux",
    arch: "x64",
    isMusl: async () => false,
    binDir: "/home/u/.config/slskd/bin",
    version: "0.26.0",
  };
  return { d: { ...base, ...over }, calls };
}

test("resolveSlskdBinary honors SLSKD_BINARY override without probing PATH or downloading", async () => {
  const { d, calls } = makeDeps({ env: { SLSKD_BINARY: "/opt/slskd" } });
  expect(await resolveSlskdBinary(d)).toBe("/opt/slskd");
  expect(calls.which).toBe(0);
  expect(calls.download.length).toBe(0);
});

test("resolveSlskdBinary uses a slskd already on PATH before downloading", async () => {
  const { d, calls } = makeDeps({ which: async () => "/usr/bin/slskd" });
  expect(await resolveSlskdBinary(d)).toBe("/usr/bin/slskd");
  expect(calls.download.length).toBe(0);
});

test("resolveSlskdBinary uses a previously-cached binary before downloading", async () => {
  const { d, calls } = makeDeps({ exists: async () => true });
  expect(await resolveSlskdBinary(d)).toBe("/home/u/.config/slskd/bin/slskd");
  expect(calls.download.length).toBe(0);
});

test("resolveSlskdBinary downloads the platform release when slskd is absent", async () => {
  const { d, calls } = makeDeps({ platform: "linux", arch: "x64", isMusl: async () => true });
  const path = await resolveSlskdBinary(d);
  expect(path).toBe("/home/u/.config/slskd/bin/slskd");
  expect(calls.download.length).toBe(1);
  expect(calls.download[0].url).toBe(
    "https://github.com/slskd/slskd/releases/download/0.26.0/slskd-0.26.0-linux-musl-x64.zip",
  );
  expect(calls.download[0].binaryPath).toBe("/home/u/.config/slskd/bin/slskd");
});
