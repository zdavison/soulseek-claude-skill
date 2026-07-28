#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";

// Pinned slskd release used by the Docker-less native path (auto-download
// fallback). Bump this to upgrade the bundled slskd. Override at runtime with
// SLSKD_VERSION.
export const SLSKD_VERSION = process.env.SLSKD_VERSION ?? "0.26.0";

// slskd's `directories.downloads` inside the Docker container (a fixed mount
// target), vs the real host path native mode writes to.
export const DOCKER_DOWNLOADS_DIR = "/downloads";
// Permissive API-key CIDR: slskd in Docker sees requests from the bridge
// gateway IP, and the host port bind (-p 127.0.0.1:PORT:PORT) is the isolation.
export const DOCKER_CIDR = "0.0.0.0/0,::/0";
// Native slskd has NO host-port-bind boundary, so the API-key CIDR is the only
// network boundary — restrict it to localhost.
export const NATIVE_CIDR = "127.0.0.1/32,::1/128";

export function paths(home: string) {
  const configDir = `${home}/.config/slskd`;
  return {
    configDir,
    configFile: `${configDir}/slskd.yml`,
    downloadsDir: `${home}/Music/soulseek`,
    // Native mode: cached binary, pidfile, log, and slskd's app dir (db/logs).
    binDir: `${configDir}/bin`,
    binaryPath: `${configDir}/bin/slskd`,
    pidFile: `${configDir}/slskd.pid`,
    logFile: `${configDir}/slskd.log`,
    appDir: configDir,
    repoRoot: import.meta.dir,
  };
}

export function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildSlskdYml(o: {
  username: string;
  password: string;
  apiKey: string;
  port: number;
  downloadsDir: string;
  cidr: string;
}): string {
  return `soulseek:
  username: ${JSON.stringify(o.username)}
  password: ${JSON.stringify(o.password)}
directories:
  downloads: ${o.downloadsDir}
web:
  port: ${o.port}
  authentication:
    api_keys:
      claude:
        key: ${o.apiKey}
        role: Administrator
        cidr: ${o.cidr}
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

const SLSKD_OS: Record<string, string> = { darwin: "osx", linux: "linux", win32: "win" };
const SLSKD_ARCH: Record<string, string> = { x64: "x64", arm64: "arm64", arm: "arm" };

// slskdAssetName maps a platform/arch (and libc) to the slskd release asset
// filename, e.g. slskd-0.26.0-linux-musl-x64.zip. musl only affects linux.
export function slskdAssetName(o: { version: string; platform: string; arch: string; musl?: boolean }): string {
  const os = SLSKD_OS[o.platform];
  const arch = SLSKD_ARCH[o.arch];
  if (!os) throw new Error(`Unsupported platform for slskd: ${o.platform}`);
  if (!arch) throw new Error(`Unsupported arch for slskd: ${o.arch}`);
  const token = os === "linux" && o.musl ? `linux-musl-${arch}` : `${os}-${arch}`;
  return `slskd-${o.version}-${token}.zip`;
}

export function slskdDownloadUrl(o: { version: string; asset: string }): string {
  return `https://github.com/slskd/slskd/releases/download/${o.version}/${o.asset}`;
}

// buildSlskdRunArgs launches a native slskd against our generated config and a
// dedicated app dir (where slskd keeps its db/logs).
export function buildSlskdRunArgs(o: { binaryPath: string; configFile: string; appDir: string }): string[] {
  return [o.binaryPath, "--config", o.configFile, "--app-dir", o.appDir];
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

async function slskdOnPath(): Promise<string | null> {
  try {
    const r = await run(["which", "slskd"]);
    const path = r.stdout.trim();
    return r.code === 0 && path ? path : null;
  } catch { return null; }
}

async function isMusl(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  if (await Bun.file("/etc/alpine-release").exists()) return true;
  try {
    const r = await run(["ldd", "--version"]);
    return /musl/i.test(r.stdout + r.stderr);
  } catch { return false; }
}

// resolveSlskdBinary prefers a PATH slskd, then a previously-cached download,
// then downloads the pinned release for this platform.
async function resolveSlskdBinary(p: ReturnType<typeof paths>): Promise<string> {
  const onPath = await slskdOnPath();
  if (onPath) { console.log("Using slskd from PATH:", onPath); return onPath; }
  if (await Bun.file(p.binaryPath).exists()) { console.log("Using cached slskd:", p.binaryPath); return p.binaryPath; }

  const musl = await isMusl();
  const asset = slskdAssetName({ version: SLSKD_VERSION, platform: process.platform, arch: process.arch, musl });
  const url = slskdDownloadUrl({ version: SLSKD_VERSION, asset });
  await mkdir(p.binDir, { recursive: true });
  const zipPath = `${p.binDir}/${asset}`;
  console.log(`Downloading ${asset} ...`);
  const dl = await run(["curl", "-fSL", "-o", zipPath, url]);
  if (dl.code !== 0) throw new Error(`download failed (${url}): ${dl.stderr.trim()}`);
  // The zip roots a `slskd` binary alongside wwwroot; extract it all into binDir
  // so the web assets sit next to the binary.
  const unzip = await run(["unzip", "-o", zipPath, "-d", p.binDir]);
  if (unzip.code !== 0) throw new Error(`unzip failed: ${unzip.stderr.trim()}`);
  await run(["chmod", "+x", p.binaryPath]);
  if (!(await Bun.file(p.binaryPath).exists())) {
    throw new Error(`slskd binary not found at ${p.binaryPath} after extracting ${asset}`);
  }
  console.log("Installed slskd to", p.binaryPath);
  return p.binaryPath;
}

async function nativePid(p: ReturnType<typeof paths>): Promise<number | null> {
  try {
    const pid = parseInt((await Bun.file(p.pidFile).text()).trim(), 10);
    if (!pid) return null;
    try { process.kill(pid, 0); return pid; } catch { return null; }
  } catch { return null; }
}

async function stopNative(p: ReturnType<typeof paths>): Promise<boolean> {
  const pid = await nativePid(p);
  if (pid) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  try { await Bun.write(p.pidFile, ""); } catch { /* ignore */ }
  return pid !== null;
}

async function launchNative(p: ReturnType<typeof paths>, binaryPath: string): Promise<void> {
  await mkdir(p.appDir, { recursive: true });
  const log = Bun.file(p.logFile);
  const proc = Bun.spawn(buildSlskdRunArgs({ binaryPath, configFile: p.configFile, appDir: p.appDir }), {
    stdout: log,
    stderr: log,
    stdin: "ignore",
  });
  // Detach so slskd keeps running after setup exits.
  proc.unref();
  await Bun.write(p.pidFile, String(proc.pid));
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

// resolveMode decides docker vs native. Explicit flags win; otherwise use
// Docker when its daemon is reachable, else fall back to the native binary.
async function resolveMode(flag: string | undefined): Promise<"docker" | "native"> {
  if (flag === "--native") return "native";
  if (flag === "--docker") {
    if (!(await dockerAvailable())) {
      console.error("--docker was requested but Docker is not available.");
      process.exit(1);
    }
    return "docker";
  }
  return (await dockerAvailable()) ? "docker" : "native";
}

async function main() {
  const flag = process.argv[2];
  const home = process.env.HOME!;
  const p = paths(home);
  const port = 5030;
  const baseUrl = `http://localhost:${port}`;

  if (flag === "--reset") {
    let removed = false;
    if (await dockerAvailable()) {
      const rm = await run(["docker", "rm", "-f", "slskd"]);
      if (rm.code === 0 && rm.stdout.trim()) { console.log("Removed slskd Docker container."); removed = true; }
    }
    if (await stopNative(p)) { console.log("Stopped native slskd process."); removed = true; }
    console.log(removed ? "Reset complete. Config left in place at" : "Nothing running. Config left in place at", p.configFile);
    return;
  }

  if (flag === "--status") {
    if (await dockerAvailable()) {
      const ps = await run(["docker", "ps", "--filter", "name=slskd", "--format", "{{.Status}}"]);
      console.log("Docker container:", ps.stdout.trim() || "not running");
    } else {
      console.log("Docker: not available");
    }
    const pid = await nativePid(p);
    console.log("Native process:", pid ? `running (pid ${pid})` : "not running");
    try {
      const h = await fetch(`${baseUrl}/health`);
      console.log("Health endpoint:", h.ok ? "Healthy" : `HTTP ${h.status}`);
    } catch { console.log("Health endpoint: unreachable"); }
    try {
      const configText = await Bun.file(p.configFile).text();
      const keyMatch = configText.match(/key:\s*(\S+)/);
      if (keyMatch) {
        const a = await fetch(`${baseUrl}/api/v0/application`, { headers: { "X-Api-Key": keyMatch[1] } });
        if (a.ok) {
          const body: any = await a.json();
          const state: string = body?.server?.state ?? "";
          const slskConnected = /connected/i.test(state) && !/disconnected/i.test(state);
          console.log("Soulseek:", slskConnected ? "connected" : "not connected");
        } else { console.log("Soulseek: unknown"); }
      } else { console.log("Soulseek: unknown"); }
    } catch { console.log("Soulseek: unknown"); }
    return;
  }

  // 1. Choose provisioning mode
  const mode = await resolveMode(flag);
  console.log(`Provisioning slskd via ${mode === "docker" ? "Docker" : "native binary (no Docker)"}.`);

  // 2. Credentials
  const username = process.env.SLSK_USERNAME ?? prompt("Soulseek username:") ?? "";
  const password = process.env.SLSK_PASSWORD ??
    (console.warn("(SLSK_PASSWORD not set; input will be visible)"), prompt("Soulseek password:") ?? "");
  if (!username || !password) {
    console.error("Username and password are required (set SLSK_USERNAME / SLSK_PASSWORD or enter when prompted).");
    process.exit(1);
  }

  // 3. Generate config (downloads path + CIDR differ per mode)
  const apiKey = generateApiKey();
  await mkdir(p.configDir, { recursive: true });
  await mkdir(p.downloadsDir, { recursive: true });
  const downloadsDir = mode === "docker" ? DOCKER_DOWNLOADS_DIR : p.downloadsDir;
  const cidr = mode === "docker" ? DOCKER_CIDR : NATIVE_CIDR;
  await Bun.write(p.configFile, buildSlskdYml({ username, password, apiKey, port, downloadsDir, cidr }));
  console.log("Wrote", p.configFile);

  // 4. Launch slskd
  if (mode === "docker") {
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
  } else {
    const binaryPath = await resolveSlskdBinary(p);
    await stopNative(p); // recreate cleanly if one is already running
    await launchNative(p, binaryPath);
    console.log("Started native slskd. Logs:", p.logFile);
  }

  // 5. Health check
  process.stdout.write("Waiting for slskd to connect to Soulseek...");
  if (!(await waitHealthy(baseUrl, apiKey))) {
    const where = mode === "docker" ? "`docker logs slskd`" : p.logFile;
    console.error(`\nslskd did not become healthy/connected within timeout. Check ${where}.`);
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
  console.log(`   mode:        ${mode === "docker" ? "Docker" : "native binary"}`);
  console.log("   slskd:      ", baseUrl, "(web UI in browser)");
  console.log("   downloads:  ", p.downloadsDir);
  console.log("   MCP:         registered as 'soulseek' (user scope)");
  console.log('   Try: ask Claude "grab the FLAC of Radiohead - Weird Fishes via soulseek"');
}

export function buildMcpAddArgs(o: { repoRoot: string; baseUrl: string; apiKey: string }): string[] {
  return [
    "mcp", "add", "soulseek", "-s", "user",
    "-e", `SLSKD_BASE_URL=${o.baseUrl}`,
    "-e", `SLSKD_API_KEY=${o.apiKey}`,
    "--", "bun", "run", `${o.repoRoot}/src/mcp-server.ts`,
  ];
}

if (import.meta.main) await main();
