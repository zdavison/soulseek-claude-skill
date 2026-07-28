import { test, expect } from "bun:test";
import {
  paths,
  buildSlskdYml,
  buildDockerRunArgs,
  buildMcpAddArgs,
  generateApiKey,
  slskdAssetName,
  slskdDownloadUrl,
  buildSlskdRunArgs,
  SLSKD_VERSION,
  DOCKER_DOWNLOADS_DIR,
  DOCKER_CIDR,
  NATIVE_CIDR,
} from "../setup";

test("paths derive from home, including native binary/pid/app-dir", () => {
  const p = paths("/Users/z");
  expect(p.configFile).toBe("/Users/z/.config/slskd/slskd.yml");
  expect(p.downloadsDir).toBe("/Users/z/Music/soulseek");
  // Native mode needs a cached binary location, a pidfile, and an app dir.
  expect(p.binaryPath).toBe("/Users/z/.config/slskd/bin/slskd");
  expect(p.pidFile).toBe("/Users/z/.config/slskd/slskd.pid");
  expect(p.appDir).toBe("/Users/z/.config/slskd");
});

test("buildSlskdYml (Docker) uses container downloads path + permissive CIDR", () => {
  const yml = buildSlskdYml({
    username: "me",
    password: "pw",
    apiKey: "SECRET123456789012",
    port: 5030,
    downloadsDir: DOCKER_DOWNLOADS_DIR,
    cidr: DOCKER_CIDR,
  });
  expect(yml).toContain('username: "me"');
  expect(yml).toContain('password: "pw"');
  expect(yml).toContain("key: SECRET123456789012");
  expect(yml).toContain("downloads: /downloads");
  expect(yml).toContain("port: 5030");
  // Permissive API-key CIDR is required for Docker bridge networking; host port bind is the isolation.
  expect(yml).toContain("cidr: 0.0.0.0/0,::/0");
});

test("buildSlskdYml (native) uses the real downloads dir + localhost-only CIDR", () => {
  const yml = buildSlskdYml({
    username: "me",
    password: "pw",
    apiKey: "SECRET123456789012",
    port: 5030,
    downloadsDir: "/Users/z/Music/soulseek",
    cidr: NATIVE_CIDR,
  });
  expect(yml).toContain("downloads: /Users/z/Music/soulseek");
  // Native slskd is not behind a Docker host-port bind, so the API key CIDR is
  // the only network boundary — it must be localhost-only.
  expect(yml).toContain("cidr: 127.0.0.1/32,::1/128");
  expect(yml).not.toContain("cidr: 0.0.0.0/0");
});

test("buildSlskdYml safely escapes special characters in credentials", () => {
  const yml = buildSlskdYml({
    username: "a:b",
    password: 'p#"x',
    apiKey: "K".repeat(16),
    port: 5030,
    downloadsDir: DOCKER_DOWNLOADS_DIR,
    cidr: DOCKER_CIDR,
  });
  expect(yml).toContain('username: "a:b"');
  expect(yml).toContain('password: "p#\\"x"');
});

test("buildDockerRunArgs mounts config + downloads and maps port", () => {
  const args = buildDockerRunArgs({ configFile: "/c/slskd.yml", downloadsDir: "/d", port: 5030 });
  const joined = args.join(" ");
  expect(joined).toContain("--name slskd");
  expect(joined).toContain("-p 127.0.0.1:5030:5030");
  expect(joined).toContain("/c/slskd.yml:/app/slskd.yml");
  expect(joined).toContain("/d:/downloads");
  expect(joined).toContain("slskd/slskd:latest");
});

test("buildMcpAddArgs wires bun command + env", () => {
  const args = buildMcpAddArgs({ repoRoot: "/r", baseUrl: "http://localhost:5030", apiKey: "K" });
  const joined = args.join(" ");
  expect(joined).toContain("soulseek");
  expect(joined).toContain("SLSKD_BASE_URL=http://localhost:5030");
  expect(joined).toContain("SLSKD_API_KEY=K");
  expect(joined).toContain("/r/src/mcp-server.ts");
});

test("generateApiKey is long enough for slskd (>=16 chars)", () => {
  expect(generateApiKey().length).toBeGreaterThanOrEqual(16);
});

test("slskdAssetName maps platform/arch (and musl) to the release asset", () => {
  expect(slskdAssetName({ version: SLSKD_VERSION, platform: "darwin", arch: "arm64" }))
    .toBe(`slskd-${SLSKD_VERSION}-osx-arm64.zip`);
  expect(slskdAssetName({ version: SLSKD_VERSION, platform: "darwin", arch: "x64" }))
    .toBe(`slskd-${SLSKD_VERSION}-osx-x64.zip`);
  expect(slskdAssetName({ version: SLSKD_VERSION, platform: "linux", arch: "x64" }))
    .toBe(`slskd-${SLSKD_VERSION}-linux-x64.zip`);
  expect(slskdAssetName({ version: SLSKD_VERSION, platform: "linux", arch: "arm64" }))
    .toBe(`slskd-${SLSKD_VERSION}-linux-arm64.zip`);
  // musl (Alpine-based sandboxes) selects the musl asset — only on linux.
  expect(slskdAssetName({ version: SLSKD_VERSION, platform: "linux", arch: "x64", musl: true }))
    .toBe(`slskd-${SLSKD_VERSION}-linux-musl-x64.zip`);
  expect(slskdAssetName({ version: SLSKD_VERSION, platform: "darwin", arch: "arm64", musl: true }))
    .toBe(`slskd-${SLSKD_VERSION}-osx-arm64.zip`);
});

test("slskdAssetName rejects unsupported platform/arch", () => {
  expect(() => slskdAssetName({ version: SLSKD_VERSION, platform: "sunos" as any, arch: "x64" })).toThrow();
  expect(() => slskdAssetName({ version: SLSKD_VERSION, platform: "linux", arch: "mips" as any })).toThrow();
});

test("slskdDownloadUrl points at the slskd release asset", () => {
  const url = slskdDownloadUrl({ version: SLSKD_VERSION, asset: `slskd-${SLSKD_VERSION}-linux-x64.zip` });
  expect(url).toBe(
    `https://github.com/slskd/slskd/releases/download/${SLSKD_VERSION}/slskd-${SLSKD_VERSION}-linux-x64.zip`,
  );
});

test("buildSlskdRunArgs points slskd at the config file and app dir", () => {
  const args = buildSlskdRunArgs({ binaryPath: "/b/slskd", configFile: "/c/slskd.yml", appDir: "/a" });
  expect(args).toEqual(["/b/slskd", "--config", "/c/slskd.yml", "--app-dir", "/a"]);
});
