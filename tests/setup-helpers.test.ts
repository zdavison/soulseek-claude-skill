import { test, expect } from "bun:test";
import { paths, buildSlskdYml, buildDockerRunArgs, buildMcpAddArgs, generateApiKey, parseScd1Credentials } from "../setup";

// Build a minimal SoulseekQt .scd1-style entry: <uint32 keyLen><key>, then either a
// string value (<uint32 0x19><uint32 len><bytes>) or an integer-typed value (<uint32 0x38>).
function scd1Entry(key: string, value?: string): Uint8Array {
  const enc = new TextEncoder();
  const kb = enc.encode(key);
  const out: number[] = [];
  const pushU32 = (n: number) => out.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
  pushU32(kb.length);
  out.push(...kb);
  if (value !== undefined) {
    const vb = enc.encode(value);
    pushU32(0x19);
    pushU32(vb.length);
    out.push(...vb);
  } else {
    pushU32(0x38); // integer-typed value with no trailing bytes (mimics how the nick is stored)
  }
  return new Uint8Array(out);
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

test("paths derive from home", () => {
  const p = paths("/Users/z");
  expect(p.configFile).toBe("/Users/z/.config/slskd/slskd.yml");
  expect(p.downloadsDir).toBe("/Users/z/Music/soulseek");
});

test("buildSlskdYml embeds creds, api key, downloads dir, port", () => {
  const yml = buildSlskdYml({ username: "me", password: "pw", apiKey: "SECRET123456789012", port: 5030 });
  expect(yml).toContain('username: "me"');
  expect(yml).toContain('password: "pw"');
  expect(yml).toContain("key: SECRET123456789012");
  expect(yml).toContain("downloads: /downloads");
  expect(yml).toContain("port: 5030");
  // Permissive API-key CIDR is required for Docker bridge networking; host port bind is the isolation.
  expect(yml).toContain("cidr: 0.0.0.0/0,::/0");
});

test("buildSlskdYml safely escapes special characters in credentials", () => {
  const yml = buildSlskdYml({ username: "a:b", password: 'p#"x', apiKey: "K".repeat(16), port: 5030 });
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

test("parseScd1Credentials extracts the plaintext password (incl. special chars)", () => {
  const buf = concatBytes(
    new Uint8Array([0x47, 0, 0, 0]),            // header
    scd1Entry("show_event_buttons"),            // integer-valued setting
    scd1Entry("password", 's3cr3t p@ss:#1'),    // string value with YAML-hostile chars
    scd1Entry("username"),                       // integer-valued -> not the nick
  );
  const c = parseScd1Credentials(buf);
  expect(c.password).toBe("s3cr3t p@ss:#1");
  expect(c.username).toBeNull(); // nick is not stored as text in real .scd1 files
});

test("parseScd1Credentials returns null password when absent", () => {
  const buf = concatBytes(new Uint8Array([0x47, 0, 0, 0]), scd1Entry("download_folder"));
  expect(parseScd1Credentials(buf).password).toBeNull();
});

test("parseScd1Credentials reads username when a variant stores it as a string", () => {
  const buf = concatBytes(new Uint8Array([0x47, 0, 0, 0]), scd1Entry("username", "mynick"));
  expect(parseScd1Credentials(buf).username).toBe("mynick");
});

test("parseScd1Credentials does not match the 'username' substring inside other keys", () => {
  // "chat_username" must not be misread as "username"
  const buf = concatBytes(new Uint8Array([0x47, 0, 0, 0]), scd1Entry("chat_username", "shouldNotMatch"));
  expect(parseScd1Credentials(buf).username).toBeNull();
});
