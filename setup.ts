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
  username: ${o.username}
  password: ${o.password}
directories:
  downloads: /downloads
web:
  port: ${o.port}
  authentication:
    api_keys:
      claude:
        key: ${o.apiKey}
        role: Administrator
        cidr: 0.0.0.0/0,::/0
`;
}

export function buildDockerRunArgs(o: { configFile: string; downloadsDir: string; port: number }): string[] {
  return [
    "run", "-d", "--name", "slskd", "--restart", "unless-stopped",
    "-p", `${o.port}:${o.port}`,
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
          if (/connected/i.test(body?.server?.state ?? "")) return true;
        }
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function main() {
  const flag = process.argv[2];
  const home = process.env.HOME!;
  const p = paths(home);
  const port = 5030;
  const baseUrl = `http://localhost:${port}`;

  if (flag === "--reset") {
    await run(["docker", "rm", "-f", "slskd"]);
    console.log("Removed slskd container. Config left in place at", p.configFile);
    return;
  }

  if (flag === "--status") {
    const ps = await run(["docker", "ps", "--filter", "name=slskd", "--format", "{{.Status}}"]);
    console.log("Container:", ps.stdout.trim() || "not running");
    try {
      const h = await fetch(`${baseUrl}/health`);
      console.log("Health endpoint:", h.ok ? "Healthy" : `HTTP ${h.status}`);
    } catch { console.log("Health endpoint: unreachable"); }
    return;
  }

  // 1. Preflight
  if (!(await dockerAvailable())) {
    console.error("Docker is not available. Install Docker Desktop and ensure the daemon is running.");
    process.exit(1);
  }

  // 2. Credentials
  const username = process.env.SLSK_USERNAME ?? prompt("Soulseek username:") ?? "";
  const password = process.env.SLSK_PASSWORD ??
    (console.warn("(SLSK_PASSWORD not set; input will be visible)"), prompt("Soulseek password:") ?? "");
  if (!username || !password) {
    console.error("Username and password are required (set SLSK_USERNAME / SLSK_PASSWORD or enter when prompted).");
    process.exit(1);
  }

  // 3. Generate config
  const apiKey = generateApiKey();
  await mkdir(p.configDir, { recursive: true });
  await mkdir(p.downloadsDir, { recursive: true });
  await Bun.write(p.configFile, buildSlskdYml({ username, password, apiKey, port }));
  console.log("Wrote", p.configFile);

  // 4. Launch container (recreate if present)
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
    console.error("You can register manually with: claude " + buildMcpAddArgs({ repoRoot: p.repoRoot, baseUrl, apiKey }).join(" "));
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
