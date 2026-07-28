// Resolve a runnable slskd binary for the Docker-less native launch path.
// Order: an explicit SLSKD_BINARY override, then a `slskd` already on PATH, then
// a previously-cached download, then download the pinned release for this
// platform. The branching is dependency-injected so it is unit-testable without
// touching PATH, the filesystem, or the network.

// Pinned slskd release used when auto-downloading. Bump to upgrade; override at
// runtime with SLSKD_VERSION.
export const SLSKD_VERSION = process.env.SLSKD_VERSION ?? "0.26.0";

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

export interface DownloadArgs {
  url: string;
  asset: string;
  binDir: string;
  binaryPath: string;
}

export interface BinaryResolveDeps {
  env: Record<string, string | undefined>;
  // Returns the resolved path to `name` on PATH, or null when absent.
  which: (name: string) => Promise<string | null>;
  exists: (path: string) => Promise<boolean>;
  // Fetches url, extracts the archive into binDir, and leaves an executable at binaryPath.
  download: (o: DownloadArgs) => Promise<void>;
  platform: string;
  arch: string;
  isMusl: () => Promise<boolean>;
  // Cache dir the downloaded binary lives in (binaryPath = `${binDir}/slskd`).
  binDir: string;
  version: string;
}

export async function resolveSlskdBinary(d: BinaryResolveDeps): Promise<string> {
  const override = d.env.SLSKD_BINARY;
  if (override) return override;

  const onPath = await d.which("slskd");
  if (onPath) return onPath;

  const binaryPath = `${d.binDir}/slskd`;
  if (await d.exists(binaryPath)) return binaryPath;

  const musl = await d.isMusl();
  const asset = slskdAssetName({ version: d.version, platform: d.platform, arch: d.arch, musl });
  const url = slskdDownloadUrl({ version: d.version, asset });
  await d.download({ url, asset, binDir: d.binDir, binaryPath });
  return binaryPath;
}

// --- default (side-effecting) dependency wiring; not unit-tested ---

async function run(cmd: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, stdout };
}

async function whichOnPath(name: string): Promise<string | null> {
  try {
    const r = await run(["which", name]);
    const p = r.stdout.trim();
    return r.code === 0 && p ? p : null;
  } catch {
    return null;
  }
}

async function detectMusl(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  if (await Bun.file("/etc/alpine-release").exists()) return true;
  try {
    const proc = Bun.spawn(["ldd", "--version"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    await proc.exited;
    return /musl/i.test(out);
  } catch {
    return false;
  }
}

// Downloads via fetch (no curl dependency) and extracts with the `unzip` CLI —
// Bun has no built-in zip extractor. The slskd zip roots a `slskd` binary
// alongside its wwwroot, so the whole archive is extracted into binDir.
async function downloadAndExtract(o: DownloadArgs): Promise<void> {
  await Bun.$`mkdir -p ${o.binDir}`.quiet();
  const zipPath = `${o.binDir}/${o.asset}`;
  const res = await fetch(o.url);
  if (!res.ok) throw new Error(`download failed (${o.url}): HTTP ${res.status}`);
  await Bun.write(zipPath, await res.arrayBuffer());
  const unzip = Bun.spawn(["unzip", "-o", zipPath, "-d", o.binDir], { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  if ((await unzip.exited) !== 0) {
    const err = await new Response(unzip.stderr).text();
    throw new Error(`unzip failed (is 'unzip' installed?): ${err.trim()}`);
  }
  await Bun.$`chmod +x ${o.binaryPath}`.quiet();
  if (!(await Bun.file(o.binaryPath).exists())) {
    throw new Error(`slskd binary not found at ${o.binaryPath} after extracting ${o.asset}`);
  }
}

export function defaultBinaryResolveDeps(env: Record<string, string | undefined> = process.env): BinaryResolveDeps {
  const home = env.HOME ?? "";
  return {
    env,
    which: whichOnPath,
    exists: (p) => Bun.file(p).exists(),
    download: downloadAndExtract,
    platform: process.platform,
    arch: process.arch,
    isMusl: detectMusl,
    binDir: `${home}/.config/slskd/bin`,
    version: SLSKD_VERSION,
  };
}

// Convenience for callers that just want a runnable slskd path with the real
// (side-effecting) dependencies.
export function resolveSlskdBinaryDefault(env: Record<string, string | undefined> = process.env): Promise<string> {
  return resolveSlskdBinary(defaultBinaryResolveDeps(env));
}
