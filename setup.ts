#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";

export function paths(home: string) {
  const configDir = `${home}/.config/slskd`;
  return {
    configDir,
    configFile: `${configDir}/slskd.yml`,
    downloadsDir: `${home}/Music/soulseek`,
    repoRoot: import.meta.dir,
  };
}

export function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildSlskdYml(o: { username: string; password: string; apiKey: string; port: number }): string {
  return `soulseek:
  username: ${JSON.stringify(o.username)}
  password: ${JSON.stringify(o.password)}
directories:
  downloads: /downloads
web:
  port: ${o.port}
  authentication:
    api_keys:
      claude:
        key: ${o.apiKey}
        role: Administrator
        cidr: 127.0.0.1/32,::1/128
`;
}

export function buildDockerRunArgs(o: { configFile: string; downloadsDir: string; port: number }): string[] {
  return [
    "run", "-d", "--name", "slskd", "--restart", "unless-stopped",
    "-p", `127.0.0.1:${o.port}:${o.port}`,
    "-v", `${o.configFile}:/app/slskd.yml`,
    "-v", `${o.downloadsDir}:/downloads`,
    "-e", "SLSKD_APP_DIR=/app",
    "slskd/slskd:latest",
  ];
}

export function buildMcpAddArgs(o: { repoRoot: string; baseUrl: string; apiKey: string }): string[] {
  return [
    "mcp", "add", "soulseek", "-s", "user",
    "-e", `SLSKD_BASE_URL=${o.baseUrl}`,
    "-e", `SLSKD_API_KEY=${o.apiKey}`,
    "--", "bun", "run", `${o.repoRoot}/src/mcp-server.ts`,
  ];
}

/**
 * Extract Soulseek credentials from a SoulseekQt `soulseek.scd1` config export.
 *
 * The .scd1 format is a little-endian serialized settings store: each setting is a
 * length-prefixed key (`<uint32 keyLen><key bytes>`) followed by a typed value.
 * String values use type code 0x19: `<uint32 0x19><uint32 strLen><strLen bytes>`.
 * The login password is stored as such a string under the key "password".
 *
 * The login username is NOT stored as text in this format (it is held as an integer
 * reference), so `username` is normally null. We still attempt to read it as a string
 * in case a SoulseekQt variant does store it that way.
 */
export function parseScd1Credentials(buf: Uint8Array): { username: string | null; password: string | null } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (o: number) => dv.getUint32(o, true);

  // Locate a length-prefixed key (`<uint32 keyLen><keyBytes>`); returns the index just
  // after the key bytes (the value position), or -1. The length prefix prevents matching
  // substrings such as "chat_username" or "dont_create_username_folders".
  function valuePosOf(key: string): number {
    const kb = new TextEncoder().encode(key);
    for (let i = 0; i + 4 + kb.length <= buf.length; i++) {
      if (u32(i) !== kb.length) continue;
      let match = true;
      for (let j = 0; j < kb.length; j++) {
        if (buf[i + 4 + j] !== kb[j]) { match = false; break; }
      }
      if (match) return i + 4 + kb.length;
    }
    return -1;
  }

  // Read a string value (type 0x19) at a value position, or null if not a string.
  function readString(vpos: number): string | null {
    if (vpos < 0 || vpos + 8 > buf.length) return null;
    if (u32(vpos) !== 0x19) return null;
    const len = u32(vpos + 4);
    if (len <= 0 || len > 4096 || vpos + 8 + len > buf.length) return null;
    return new TextDecoder().decode(buf.subarray(vpos + 8, vpos + 8 + len));
  }

  return {
    username: readString(valuePosOf("username")),
    password: readString(valuePosOf("password")),
  };
}

// --- side-effecting helpers (not unit-tested; covered by manual verification) ---

async function run(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

async function dockerAvailable(): Promise<boolean> {
  try { return (await run(["docker", "info"])).code === 0; } catch { return false; }
}

async function waitHealthy(baseUrl: string, apiKey: string, timeoutMs = 60000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const h = await fetch(`${baseUrl}/health`);
      if (h.ok) {
        const a = await fetch(`${baseUrl}/api/v0/application`, { headers: { "X-Api-Key": apiKey } });
        if (a.ok) {
          const body: any = await a.json();
          const state = body?.server?.state ?? "";
          if (/connected/i.test(state) && !/disconnected/i.test(state)) return true;
        }
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function main() {
  const flag = process.argv[2];
  const scd1Arg = flag && !flag.startsWith("--") ? flag : undefined;
  const home = process.env.HOME!;
  const p = paths(home);
  const port = 5030;
  const baseUrl = `http://localhost:${port}`;

  if (flag === "--reset") {
    const rm = await run(["docker", "rm", "-f", "slskd"]);
    if (rm.code === 0) {
      console.log("Removed slskd container. Config left in place at", p.configFile);
    } else {
      console.error("Could not remove slskd container (is Docker running?).", rm.stderr.trim());
      process.exit(1);
    }
    return;
  }

  if (flag === "--status") {
    if (!(await dockerAvailable())) { console.log("Docker: not available"); return; }
    const ps = await run(["docker", "ps", "--filter", "name=slskd", "--format", "{{.Status}}"]);
    console.log("Container:", ps.stdout.trim() || "not running");
    try {
      const h = await fetch(`${baseUrl}/health`);
      console.log("Health endpoint:", h.ok ? "Healthy" : `HTTP ${h.status}`);
    } catch { console.log("Health endpoint: unreachable"); }
    // Best-effort: read API key from config file and check Soulseek connection
    try {
      const configText = await Bun.file(p.configFile).text();
      const keyMatch = configText.match(/key:\s*(\S+)/);
      if (keyMatch) {
        const storedKey = keyMatch[1];
        const a = await fetch(`${baseUrl}/api/v0/application`, { headers: { "X-Api-Key": storedKey } });
        if (a.ok) {
          const body: any = await a.json();
          const state: string = body?.server?.state ?? "";
          const slskConnected = /connected/i.test(state) && !/disconnected/i.test(state);
          console.log("Soulseek:", slskConnected ? "connected" : "not connected");
        } else {
          console.log("Soulseek: unknown");
        }
      } else {
        console.log("Soulseek: unknown");
      }
    } catch { console.log("Soulseek: unknown"); }
    return;
  }

  // 1. Preflight
  if (!(await dockerAvailable())) {
    console.error("Docker is not available. Install Docker Desktop and ensure the daemon is running.");
    process.exit(1);
  }

  // 2. Credentials — read the password from the user's exported SoulseekQt config (soulseek.scd1)
  console.log("Export: quit SoulseekQt, then copy its `soulseek.scd1` config file (in SoulseekQt's data folder) and pass the path here.");
  const scd1Path = (scd1Arg ?? process.env.SLSK_SCD1 ?? prompt("Path to your soulseek.scd1 file:") ?? "").replace(/^~/, home);
  if (!scd1Path) {
    console.error("A soulseek.scd1 path is required (pass it as an argument, set SLSK_SCD1, or enter when prompted).");
    process.exit(1);
  }
  let scd1Buf: Uint8Array;
  try {
    scd1Buf = new Uint8Array(await Bun.file(scd1Path).arrayBuffer());
  } catch {
    console.error(`Could not read scd1 file at: ${scd1Path}`);
    process.exit(1);
  }
  const creds = parseScd1Credentials(scd1Buf);
  const password = creds.password ?? "";
  if (!password) {
    console.error("Could not extract a password from that file. Is it a SoulseekQt soulseek.scd1 export?");
    process.exit(1);
  }
  // The .scd1 format does not store the login username as text, so fall back to env/prompt.
  const username = creds.username ?? process.env.SLSK_USERNAME ?? prompt("Soulseek username (not stored in scd1):") ?? "";
  if (!username) {
    console.error("A Soulseek username is required (set SLSK_USERNAME or enter when prompted).");
    process.exit(1);
  }

  // 3. Generate config
  const apiKey = generateApiKey();
  await mkdir(p.configDir, { recursive: true });
  await mkdir(p.downloadsDir, { recursive: true });
  await Bun.write(p.configFile, buildSlskdYml({ username, password, apiKey, port }));
  console.log("Wrote", p.configFile);

  // 4. Launch container (recreate if present)
  const existing = await run(["docker", "ps", "-a", "--filter", "name=^/slskd$", "--format", "{{.Names}}"]);
  if (existing.stdout.trim() === "slskd") {
    console.warn("A Docker container named 'slskd' already exists and will be recreated. Its container state will be lost (config/downloads on disk are preserved).");
  }
  await run(["docker", "rm", "-f", "slskd"]);
  const launch = await run(["docker", ...buildDockerRunArgs({ configFile: p.configFile, downloadsDir: p.downloadsDir, port })]);
  if (launch.code !== 0) {
    console.error("docker run failed:", launch.stderr);
    process.exit(1);
  }
  console.log("Started slskd container.");

  // 5. Health check
  process.stdout.write("Waiting for slskd to connect to Soulseek...");
  if (!(await waitHealthy(baseUrl, apiKey))) {
    console.error("\nslskd did not become healthy/connected within timeout. Check `docker logs slskd`.");
    process.exit(1);
  }
  console.log(" connected.");

  // 6. Register MCP
  const mcp = await run(["claude", ...buildMcpAddArgs({ repoRoot: p.repoRoot, baseUrl, apiKey })]);
  if (mcp.code !== 0) {
    console.error("claude mcp add failed:", mcp.stderr);
    const hint = buildMcpAddArgs({ repoRoot: p.repoRoot, baseUrl, apiKey })
      .join(" ")
      .replace(/(SLSKD_API_KEY=)\S+/, "$1***");
    console.error("You can register manually with: claude " + hint);
    process.exit(1);
  }

  // 7. Report
  console.log("\n✅ Soulseek skill ready.");
  console.log("   slskd:      ", baseUrl, "(web UI in browser)");
  console.log("   downloads:  ", p.downloadsDir);
  console.log("   MCP:         registered as 'soulseek' (user scope)");
  console.log('   Try: ask Claude "grab the FLAC of Radiohead - Weird Fishes via soulseek"');
}

if (import.meta.main) await main();
