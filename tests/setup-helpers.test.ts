import { test, expect } from "bun:test";
import { paths, buildSlskdYml, buildDockerRunArgs, buildMcpAddArgs, generateApiKey } from "../setup";

test("paths derive from home", () => {
  const p = paths("/Users/z");
  expect(p.configFile).toBe("/Users/z/.config/slskd/slskd.yml");
  expect(p.downloadsDir).toBe("/Users/z/Music/soulseek");
});

test("buildSlskdYml embeds creds, api key, downloads dir, port", () => {
  const yml = buildSlskdYml({ username: "me", password: "pw", apiKey: "SECRET123456789012", port: 5030 });
  expect(yml).toContain("username: me");
  expect(yml).toContain("password: pw");
  expect(yml).toContain("key: SECRET123456789012");
  expect(yml).toContain("downloads: /downloads");
  expect(yml).toContain("port: 5030");
});

test("buildDockerRunArgs mounts config + downloads and maps port", () => {
  const args = buildDockerRunArgs({ configFile: "/c/slskd.yml", downloadsDir: "/d", port: 5030 });
  const joined = args.join(" ");
  expect(joined).toContain("--name slskd");
  expect(joined).toContain("-p 5030:5030");
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
