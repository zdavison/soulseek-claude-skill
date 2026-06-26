# Soulseek Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude skill that finds the highest-quality copy of a song on the Soulseek network (via slskd) and downloads it to completion, falling back through alternatives when peers stall.

**Architecture:** slskd runs in Docker and exposes a REST API on `localhost:5030`. A small, focused MCP server (our own, TS+bun) wraps the slskd API and the ranking logic, exposing 5 tools. The skill (`SKILL.md`) makes Claude aware of the MCP and encodes the search → rank → download → monitor → fall-back workflow. A `setup.ts` script bootstraps everything: Docker container, config, MCP registration.

**Tech Stack:** TypeScript, bun (runtime + test runner), `@modelcontextprotocol/sdk` for the MCP server, slskd (Docker) as the Soulseek backend.

## Global Constraints

- **Language/runtime:** TypeScript run with **bun**. Tests use `bun:test`. No Node-only assumptions.
- **No extra runtime deps** beyond `@modelcontextprotocol/sdk`. Use bun/web built-ins (`fetch`, `crypto`, `Bun.*`) for everything else.
- **slskd backend:** Docker image `slskd/slskd:latest`, REST API base `http://localhost:5030`, auth via `X-Api-Key` header.
- **slskd API paths (exact):** `POST /api/v0/searches`, `GET /api/v0/searches/{id}`, `GET /api/v0/searches/{id}/responses`, `POST /api/v0/downloads/{username}`, `GET /api/v0/downloads/{username}`, `GET /api/v0/downloads/{username}/{id}`, `DELETE /api/v0/downloads/{username}/{id}`, `GET /api/v0/application`, `GET /health`.
- **Download destination:** host `~/Music/soulseek/` → container `/downloads`.
- **Config location:** host `~/.config/slskd/slskd.yml` → container `/app/slskd.yml`.
- **Quality policies:** `lossless-first` (default), `lossless-only`, `best-available`.
- **Skill repo root:** `/Users/z/github/soulseek-claude-skill/` (already a git repo).
- **Commit frequently:** one commit per task minimum.

### File Structure (locked here; minor deviation from spec)

The spec sketched `scripts/pick-best.ts` + `mcp-server/`. Since we build our own server in TS, consolidate all TS into `src/`:

```
soulseek-claude-skill/
├── SKILL.md              # skill: trigger + workflow (Task 6)
├── setup.ts              # Docker + config + MCP registration bootstrap (Task 5)
├── package.json          # bun project + scripts (Task 1)
├── tsconfig.json         # (Task 1)
├── README.md             # human install/usage (Task 6)
├── src/
│   ├── types.ts          # shared types (Task 1)
│   ├── pick-best.ts      # pure ranking + sanity checks (Task 2)
│   ├── slskd-client.ts   # typed slskd REST client (Task 3)
│   └── mcp-server.ts     # MCP server: 5 tools, wires client+pick-best (Task 4)
└── tests/
    ├── pick-best.test.ts
    ├── slskd-client.test.ts
    ├── mcp-handlers.test.ts
    ├── setup-helpers.test.ts
    └── fixtures/
        └── search-responses.json
```

### Shared interfaces (defined in Task 1, consumed everywhere)

```ts
// Format classification of a file.
export type Format = "flac" | "wav" | "alac" | "ape" | "mp3" | "aac" | "ogg" | "other";
export type Policy = "lossless-first" | "lossless-only" | "best-available";

// A file inside a slskd search response (subset of slskd's Soulseek.File).
export interface SlskdFile {
  filename: string;
  size: number;
  bitRate?: number | null;     // kbps, often null for lossless
  length?: number | null;      // seconds, often null
  bitDepth?: number | null;
  sampleRate?: number | null;
  isVariableBitRate?: boolean | null;
  extension?: string | null;
}

// A search response from one peer (subset of slskd's response object).
export interface SlskdSearchResponse {
  username: string;
  hasFreeUploadSlot: boolean;
  queueLength: number;
  uploadSpeed: number;
  files: SlskdFile[];
}

// A ranked download candidate (output of pick-best).
export interface Candidate {
  username: string;
  filename: string;
  size: number;
  format: Format;
  lossless: boolean;
  bitRate: number | null;
  lengthSeconds: number | null;
  hasFreeUploadSlot: boolean;
  queueLength: number;
  uploadSpeed: number;
  score: number;       // higher = better; for ranking
  reason: string;      // human-readable explanation of the ranking
  suspectFake: boolean;// soft-suspect lossless (kept but penalized)
}

// Normalized transfer state (from slskd's flags string).
export type TransferPhase = "queued" | "in_progress" | "succeeded" | "failed";
export interface TransferStatus {
  id: string;
  phase: TransferPhase;
  rawState: string;
  size: number;
  bytesTransferred: number;
  percentComplete: number;
  averageSpeed: number;
}
```

---

### Task 1: Project scaffold + shared types

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/types.ts`
- Create: `.gitignore`
- Test: `tests/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: all types in the "Shared interfaces" block above, importable from `src/types.ts`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "soulseek-claude-skill",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "mcp": "bun run src/mcp-server.ts",
    "setup": "bun run setup.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true
  },
  "include": ["src", "tests", "setup.ts"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
*.log
.DS_Store
```

- [ ] **Step 4: Create `src/types.ts`** — paste the entire "Shared interfaces" block above verbatim into this file.

- [ ] **Step 5: Write the failing test** in `tests/types.test.ts`

```ts
import { test, expect } from "bun:test";
import type { Candidate, Policy } from "../src/types";

test("types module is importable and Candidate shape is usable", () => {
  const policy: Policy = "lossless-first";
  const c: Candidate = {
    username: "u", filename: "a.flac", size: 1, format: "flac", lossless: true,
    bitRate: null, lengthSeconds: null, hasFreeUploadSlot: true, queueLength: 0,
    uploadSpeed: 0, score: 0, reason: "", suspectFake: false,
  };
  expect(policy).toBe("lossless-first");
  expect(c.format).toBe("flac");
});
```

- [ ] **Step 6: Install deps and run**

Run: `cd /Users/z/github/soulseek-claude-skill && bun install && bun test tests/types.test.ts`
Expected: PASS (1 test). If `bun install` fails on the SDK version, run `bun add @modelcontextprotocol/sdk` to resolve the latest 1.x.

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json .gitignore src/types.ts tests/types.test.ts bun.lockb
git commit -m "chore: scaffold bun project and shared types"
```

---

### Task 2: Ranking + sanity checks (`pick-best.ts`)

This is the core algorithm. Pure functions, no I/O, exhaustively unit-tested.

**Files:**
- Create: `src/pick-best.ts`
- Create: `tests/pick-best.test.ts`
- Create: `tests/fixtures/search-responses.json`

**Interfaces:**
- Consumes: `SlskdSearchResponse`, `SlskdFile`, `Candidate`, `Format`, `Policy` from `src/types.ts`.
- Produces:
  - `classifyFormat(filename: string): Format`
  - `pickBest(responses: SlskdSearchResponse[], policy: Policy): Candidate[]` — returns candidates ordered best-first (already filtered per policy, hard-fakes dropped).

- [ ] **Step 1: Write failing tests** in `tests/pick-best.test.ts`

```ts
import { test, expect } from "bun:test";
import { classifyFormat, pickBest } from "../src/pick-best";
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
  const out = pickBest(r, "lossless-first");
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/pick-best.test.ts`
Expected: FAIL — `classifyFormat`/`pickBest` not exported.

- [ ] **Step 3: Implement `src/pick-best.ts`**

```ts
import type { Candidate, Format, Policy, SlskdFile, SlskdSearchResponse } from "./types";

const LOSSLESS: ReadonlySet<Format> = new Set(["flac", "wav", "alac", "ape"]);

// Confident floor: below this implied bitrate a "lossless" file cannot be genuine -> drop.
const LOSSLESS_HARD_FLOOR_KBPS = 250;
// Soft floor: plausible but suspicious -> keep, penalize, mark suspectFake.
const LOSSLESS_SOFT_FLOOR_KBPS = 400;

const EXT_TO_FORMAT: Record<string, Format> = {
  flac: "flac", wav: "wav", aif: "wav", aiff: "wav",
  alac: "alac", m4a: "aac", aac: "aac", ape: "ape",
  mp3: "mp3", ogg: "ogg", oga: "ogg", opus: "ogg",
};

export function classifyFormat(filename: string): Format {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return "other";
  // .m4a is AAC unless the name explicitly says ALAC/lossless.
  if (m[1] === "m4a" && /alac|lossless/i.test(filename)) return "alac";
  return EXT_TO_FORMAT[m[1]] ?? "other";
}

// Implied bitrate in kbps from size+length, or null if not computable.
function impliedKbps(file: SlskdFile): number | null {
  if (!file.length || file.length <= 0 || !file.size || file.size <= 0) return null;
  return (file.size * 8) / file.length / 1000;
}

// Effective mp3/lossy bitrate for tiering: declared, else implied, else null.
function lossyKbps(file: SlskdFile): number | null {
  if (file.bitRate && file.bitRate > 0) return file.bitRate;
  return impliedKbps(file);
}

function tierScore(format: Format, file: SlskdFile): number {
  if (LOSSLESS.has(format)) return 1000;
  const br = lossyKbps(file);
  if (format === "mp3" || format === "aac" || format === "ogg") {
    if (br === null) return 450;
    if (br >= 320) return 700;
    if (br >= 256) return 650;
    if (br >= 192) return 600;
    if (br >= 128) return 500;
    return 400;
  }
  return 100;
}

interface Evaluated { candidate: Candidate; drop: boolean; }

function evaluate(file: SlskdFile, r: SlskdSearchResponse): Evaluated {
  const format = classifyFormat(file.filename);
  const lossless = LOSSLESS.has(format);
  let score = tierScore(format, file);
  let suspectFake = false;
  let drop = false;
  const notes: string[] = [`${format}${lossless ? " (lossless)" : ""}`];

  if (lossless) {
    const kbps = impliedKbps(file);
    if (kbps === null) {
      notes.push("size/length unknown — sanity check abstained");
    } else if (kbps < LOSSLESS_HARD_FLOOR_KBPS) {
      drop = true;
      notes.push(`implied ${Math.round(kbps)}kbps — fake lossless, dropped`);
    } else if (kbps < LOSSLESS_SOFT_FLOOR_KBPS) {
      suspectFake = true;
      score -= 400;
      notes.push(`implied ${Math.round(kbps)}kbps — suspiciously low, penalized`);
    } else {
      notes.push(`implied ${Math.round(kbps)}kbps — plausible`);
    }
  } else {
    const br = lossyKbps(file);
    if (br) notes.push(`${Math.round(br)}kbps`);
  }

  // Peer availability adjustments (kept smaller than tier gaps so format dominates).
  if (r.hasFreeUploadSlot) { score += 30; notes.push("free slot"); }
  else { notes.push("no free slot"); }
  score -= Math.min(r.queueLength, 20);                   // up to -20 for long queues
  score += Math.min(r.uploadSpeed / 100_000, 10);         // up to +10 for fast peers
  score += file.size / 1e12;                              // tiny tiebreaker: larger wins

  const candidate: Candidate = {
    username: r.username,
    filename: file.filename,
    size: file.size,
    format,
    lossless,
    bitRate: lossyKbps(file),
    lengthSeconds: file.length ?? null,
    hasFreeUploadSlot: r.hasFreeUploadSlot,
    queueLength: r.queueLength,
    uploadSpeed: r.uploadSpeed,
    score,
    reason: notes.join("; "),
    suspectFake,
  };
  return { candidate, drop };
}

export function pickBest(responses: SlskdSearchResponse[], policy: Policy): Candidate[] {
  const evaluated = responses
    .flatMap((r) => r.files.map((f) => evaluate(f, r)))
    .filter((e) => !e.drop)
    .map((e) => e.candidate);

  const filtered = policy === "lossless-only"
    ? evaluated.filter((c) => c.lossless)
    : evaluated;

  return filtered.sort((a, b) => b.score - a.score);
}
```

- [ ] **Step 4: Create fixture** `tests/fixtures/search-responses.json` (used by later tasks; realistic slskd shape)

```json
[
  {
    "username": "alice",
    "hasFreeUploadSlot": true,
    "queueLength": 0,
    "uploadSpeed": 500000,
    "files": [
      { "filename": "Artist\\Album\\01 - Song.flac", "size": 28000000, "bitRate": null, "length": 245 }
    ]
  },
  {
    "username": "bob",
    "hasFreeUploadSlot": false,
    "queueLength": 3,
    "uploadSpeed": 120000,
    "files": [
      { "filename": "Music\\Song.mp3", "size": 9800000, "bitRate": 320, "length": 245 }
    ]
  }
]
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/pick-best.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/pick-best.ts tests/pick-best.test.ts tests/fixtures/search-responses.json
git commit -m "feat: quality ranking and fake-lossless sanity checks"
```

---

### Task 3: slskd REST client (`slskd-client.ts`)

**Files:**
- Create: `src/slskd-client.ts`
- Test: `tests/slskd-client.test.ts`

**Interfaces:**
- Consumes: `SlskdSearchResponse`, `TransferStatus`, `TransferPhase` from `src/types.ts`.
- Produces a class:
  - `new SlskdClient(baseUrl: string, apiKey: string)`
  - `health(): Promise<{ healthy: boolean; connected: boolean; version: string | null }>`
  - `searchAndCollect(query: string, opts?: { timeoutMs?: number; minResponses?: number; pollMs?: number }): Promise<SlskdSearchResponse[]>`
  - `enqueue(username: string, filename: string, size: number): Promise<string>` — returns the transfer `id` (looked up after enqueue)
  - `transferStatus(username: string, id: string): Promise<TransferStatus>`
  - `cancel(username: string, id: string, remove?: boolean): Promise<void>`
- Helper exported for testing: `normalizePhase(rawState: string): TransferPhase`

- [ ] **Step 1: Write failing tests** in `tests/slskd-client.test.ts`

```ts
import { test, expect, mock, afterEach } from "bun:test";
import { SlskdClient, normalizePhase } from "../src/slskd-client";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockFetch(routes: Record<string, () => Response>) {
  globalThis.fetch = mock(async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    for (const key of Object.keys(routes)) {
      if (url.includes(key)) return routes[key]();
    }
    return new Response("not found", { status: 404 });
  }) as any;
}

test("normalizePhase maps slskd flag strings", () => {
  expect(normalizePhase("Completed, Succeeded")).toBe("succeeded");
  expect(normalizePhase("InProgress")).toBe("in_progress");
  expect(normalizePhase("Queued, Remotely")).toBe("queued");
  expect(normalizePhase("Completed, Errored")).toBe("failed");
  expect(normalizePhase("Completed, Cancelled")).toBe("failed");
  expect(normalizePhase("Completed, TimedOut")).toBe("failed");
  expect(normalizePhase("Completed, Rejected")).toBe("failed");
});

test("health reports connected from /api/v0/application", async () => {
  mockFetch({
    "/health": () => new Response("Healthy", { status: 200 }),
    "/api/v0/application": () =>
      Response.json({ version: "0.21.0", server: { state: "Connected, LoggedIn" } }),
  });
  const c = new SlskdClient("http://localhost:5030", "k");
  const h = await c.health();
  expect(h.healthy).toBe(true);
  expect(h.connected).toBe(true);
  expect(h.version).toBe("0.21.0");
});

test("searchAndCollect creates search, polls, returns responses", async () => {
  let polls = 0;
  mockFetch({
    "/api/v0/searches/abc/responses": () =>
      Response.json([{ username: "u", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 1, files: [] }]),
    "/api/v0/searches/abc": () => {
      polls++;
      return Response.json({ id: "abc", isComplete: polls >= 2, responseCount: polls });
    },
    "/api/v0/searches": () => Response.json({ id: "abc" }),
  });
  const c = new SlskdClient("http://localhost:5030", "k");
  const out = await c.searchAndCollect("query", { timeoutMs: 2000, minResponses: 1, pollMs: 1 });
  expect(out).toHaveLength(1);
  expect(out[0].username).toBe("u");
});

test("enqueue posts files and looks up the transfer id", async () => {
  mockFetch({
    "/api/v0/downloads/peer/": () => new Response(null, { status: 201 }), // POST enqueue
    "/api/v0/downloads/peer": () =>
      Response.json({
        username: "peer",
        directories: [{ files: [{ id: "tid-1", filename: "Song.flac", size: 100 }] }],
      }),
  });
  const c = new SlskdClient("http://localhost:5030", "k");
  const id = await c.enqueue("peer", "Song.flac", 100);
  expect(id).toBe("tid-1");
});

test("transferStatus computes percentComplete", async () => {
  mockFetch({
    "/api/v0/downloads/peer/tid-1": () =>
      Response.json({ id: "tid-1", state: "InProgress", size: 100, bytesTransferred: 25, averageSpeed: 10 }),
  });
  const c = new SlskdClient("http://localhost:5030", "k");
  const s = await c.transferStatus("peer", "tid-1");
  expect(s.phase).toBe("in_progress");
  expect(s.percentComplete).toBe(25);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/slskd-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/slskd-client.ts`**

```ts
import type { SlskdSearchResponse, TransferPhase, TransferStatus } from "./types";

export function normalizePhase(rawState: string): TransferPhase {
  const s = rawState.toLowerCase();
  if (s.includes("succeeded")) return "succeeded";
  if (s.includes("errored") || s.includes("cancelled") || s.includes("canceled") ||
      s.includes("timedout") || s.includes("rejected")) return "failed";
  if (s.includes("inprogress")) return "in_progress";
  return "queued";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SlskdClient {
  constructor(private baseUrl: string, private apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async req(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "X-Api-Key": this.apiKey,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`slskd ${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    }
    return res;
  }

  async health(): Promise<{ healthy: boolean; connected: boolean; version: string | null }> {
    let healthy = false;
    try {
      const h = await fetch(`${this.baseUrl}/health`);
      healthy = h.ok;
    } catch { healthy = false; }
    try {
      const a = await this.req("/api/v0/application");
      if (!a.ok) return { healthy, connected: false, version: null };
      const body: any = await a.json();
      const state: string = body?.server?.state ?? "";
      return { healthy, connected: /connected/i.test(state), version: body?.version ?? null };
    } catch {
      return { healthy, connected: false, version: null };
    }
  }

  async searchAndCollect(
    query: string,
    opts: { timeoutMs?: number; minResponses?: number; pollMs?: number } = {},
  ): Promise<SlskdSearchResponse[]> {
    const timeoutMs = opts.timeoutMs ?? 8000;
    const minResponses = opts.minResponses ?? 5;
    const pollMs = opts.pollMs ?? 500;

    const id = crypto.randomUUID();
    await this.req("/api/v0/searches", {
      method: "POST",
      body: JSON.stringify({ id, searchText: query }),
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const stateRes = await this.req(`/api/v0/searches/${id}`);
      if (stateRes.ok) {
        const st: any = await stateRes.json();
        const count = st?.responseCount ?? 0;
        if (st?.isComplete || count >= minResponses) break;
      }
    }

    const res = await this.req(`/api/v0/searches/${id}/responses`);
    if (!res.ok) return [];
    const raw: any[] = await res.json();
    return raw.map((r) => ({
      username: r.username,
      hasFreeUploadSlot: !!r.hasFreeUploadSlot,
      queueLength: r.queueLength ?? 0,
      uploadSpeed: r.uploadSpeed ?? 0,
      files: (r.files ?? []).map((f: any) => ({
        filename: f.filename,
        size: f.size,
        bitRate: f.bitRate ?? null,
        length: f.length ?? null,
        bitDepth: f.bitDepth ?? null,
        sampleRate: f.sampleRate ?? null,
        isVariableBitRate: f.isVariableBitRate ?? null,
        extension: f.extension ?? null,
      })),
    }));
  }

  async enqueue(username: string, filename: string, size: number): Promise<string> {
    await this.req(`/api/v0/downloads/${encodeURIComponent(username)}`, {
      method: "POST",
      body: JSON.stringify([{ filename, size }]),
    });
    // slskd's enqueue response doesn't include the transfer id; look it up.
    const res = await this.req(`/api/v0/downloads/${encodeURIComponent(username)}`);
    if (!res.ok) throw new Error(`enqueue succeeded but could not locate transfer for ${filename}`);
    const body: any = await res.json();
    const files = (body?.directories ?? []).flatMap((d: any) => d.files ?? []);
    const match = files.find((f: any) => f.filename === filename);
    if (!match?.id) throw new Error(`enqueued file not found in downloads list: ${filename}`);
    return match.id;
  }

  async transferStatus(username: string, id: string): Promise<TransferStatus> {
    const res = await this.req(`/api/v0/downloads/${encodeURIComponent(username)}/${id}`);
    if (!res.ok) throw new Error(`transfer ${id} not found`);
    const t: any = await res.json();
    const size = t.size ?? 0;
    const bytes = t.bytesTransferred ?? 0;
    return {
      id: t.id,
      phase: normalizePhase(t.state ?? ""),
      rawState: t.state ?? "",
      size,
      bytesTransferred: bytes,
      percentComplete: size > 0 ? Math.round((bytes / size) * 100) : 0,
      averageSpeed: t.averageSpeed ?? 0,
    };
  }

  async cancel(username: string, id: string, remove = true): Promise<void> {
    await this.req(`/api/v0/downloads/${encodeURIComponent(username)}/${id}?remove=${remove}`, {
      method: "DELETE",
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/slskd-client.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/slskd-client.ts tests/slskd-client.test.ts
git commit -m "feat: typed slskd REST client"
```

---

### Task 4: MCP server with 5 tools (`mcp-server.ts`)

Exposes a focused toolset. Tool handlers are exported as pure functions (client injected) so they're testable without a transport.

**Files:**
- Create: `src/mcp-server.ts`
- Test: `tests/mcp-handlers.test.ts`

**Interfaces:**
- Consumes: `SlskdClient` (Task 3), `pickBest` (Task 2), types (Task 1).
- Produces exported handlers (each takes `client` + parsed args):
  - `handleHealth(client): Promise<object>`
  - `handleSearch(client, { query, policy }): Promise<{ candidates: Candidate[] }>`
  - `handleDownload(client, { username, filename, size }): Promise<{ transferId: string }>`
  - `handleStatus(client, { username, transferId }): Promise<TransferStatus>`
  - `handleCancel(client, { username, transferId }): Promise<{ cancelled: true }>`
- Tool names exposed over MCP: `soulseek_health`, `soulseek_search`, `soulseek_download`, `soulseek_transfer_status`, `soulseek_cancel`.

- [ ] **Step 1: Write failing tests** in `tests/mcp-handlers.test.ts`

```ts
import { test, expect } from "bun:test";
import { handleSearch, handleDownload, handleStatus } from "../src/mcp-server";

// Minimal fake client implementing only what each handler uses.
function fakeClient(over: any = {}) {
  return {
    searchAndCollect: async () => [
      { username: "alice", hasFreeUploadSlot: true, queueLength: 0, uploadSpeed: 500000,
        files: [{ filename: "a.flac", size: 28000000, bitRate: null, length: 245 }] },
      { username: "bob", hasFreeUploadSlot: false, queueLength: 3, uploadSpeed: 1000,
        files: [{ filename: "b.mp3", size: 9800000, bitRate: 320, length: 245 }] },
    ],
    enqueue: async () => "tid-9",
    transferStatus: async () => ({ id: "tid-9", phase: "succeeded", rawState: "Completed, Succeeded",
      size: 100, bytesTransferred: 100, percentComplete: 100, averageSpeed: 5 }),
    ...over,
  } as any;
}

test("handleSearch returns ranked candidates, flac first", async () => {
  const out = await handleSearch(fakeClient(), { query: "x", policy: "lossless-first" });
  expect(out.candidates[0].format).toBe("flac");
  expect(out.candidates[0].username).toBe("alice");
});

test("handleSearch defaults policy to lossless-first", async () => {
  const out = await handleSearch(fakeClient(), { query: "x" } as any);
  expect(out.candidates[0].format).toBe("flac");
});

test("handleDownload returns transferId", async () => {
  const out = await handleDownload(fakeClient(), { username: "alice", filename: "a.flac", size: 28000000 });
  expect(out.transferId).toBe("tid-9");
});

test("handleStatus passes through normalized status", async () => {
  const out = await handleStatus(fakeClient(), { username: "alice", transferId: "tid-9" });
  expect(out.phase).toBe("succeeded");
  expect(out.percentComplete).toBe(100);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/mcp-handlers.test.ts`
Expected: FAIL — handlers not exported.

- [ ] **Step 3: Implement `src/mcp-server.ts`**

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SlskdClient } from "./slskd-client";
import { pickBest } from "./pick-best";
import type { Candidate, Policy, TransferStatus } from "./types";

type ClientLike = Pick<SlskdClient, "health" | "searchAndCollect" | "enqueue" | "transferStatus" | "cancel">;

export async function handleHealth(client: ClientLike) {
  return await client.health();
}

export async function handleSearch(
  client: ClientLike,
  args: { query: string; policy?: Policy },
): Promise<{ candidates: Candidate[] }> {
  const policy: Policy = args.policy ?? "lossless-first";
  const responses = await client.searchAndCollect(args.query, { minResponses: 5, timeoutMs: 8000 });
  return { candidates: pickBest(responses, policy) };
}

export async function handleDownload(
  client: ClientLike,
  args: { username: string; filename: string; size: number },
): Promise<{ transferId: string }> {
  const transferId = await client.enqueue(args.username, args.filename, args.size);
  return { transferId };
}

export async function handleStatus(
  client: ClientLike,
  args: { username: string; transferId: string },
): Promise<TransferStatus> {
  return await client.transferStatus(args.username, args.transferId);
}

export async function handleCancel(
  client: ClientLike,
  args: { username: string; transferId: string },
): Promise<{ cancelled: true }> {
  await client.cancel(args.username, args.transferId, true);
  return { cancelled: true };
}

const TOOLS = [
  {
    name: "soulseek_health",
    description: "Check that slskd is up and connected to the Soulseek network. Call before searching.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "soulseek_search",
    description:
      "Search Soulseek for a track and return download candidates RANKED best-first. " +
      "policy: 'lossless-first' (default), 'lossless-only' (fail if no lossless), or 'best-available'. " +
      "Each candidate includes format, bitrate, peer availability, a score, and a 'reason'. " +
      "Pick candidates[0]; fall back to the next on stall.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text, e.g. 'Radiohead Weird Fishes'" },
        policy: { type: "string", enum: ["lossless-first", "lossless-only", "best-available"] },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "soulseek_download",
    description: "Enqueue a download for a chosen candidate. Returns transferId for status polling.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string" },
        filename: { type: "string" },
        size: { type: "number" },
      },
      required: ["username", "filename", "size"],
      additionalProperties: false,
    },
  },
  {
    name: "soulseek_transfer_status",
    description:
      "Get a download's status: phase (queued|in_progress|succeeded|failed), percentComplete, bytesTransferred, averageSpeed. Poll this to monitor progress.",
    inputSchema: {
      type: "object",
      properties: { username: { type: "string" }, transferId: { type: "string" } },
      required: ["username", "transferId"],
      additionalProperties: false,
    },
  },
  {
    name: "soulseek_cancel",
    description: "Cancel/remove a stalled or unwanted download before falling back to another candidate.",
    inputSchema: {
      type: "object",
      properties: { username: { type: "string" }, transferId: { type: "string" } },
      required: ["username", "transferId"],
      additionalProperties: false,
    },
  },
];

function ok(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function createServer(client: ClientLike): Server {
  const server = new Server(
    { name: "soulseek", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: a = {} } = req.params as any;
    switch (name) {
      case "soulseek_health": return ok(await handleHealth(client));
      case "soulseek_search": return ok(await handleSearch(client, a));
      case "soulseek_download": return ok(await handleDownload(client, a));
      case "soulseek_transfer_status": return ok(await handleStatus(client, a));
      case "soulseek_cancel": return ok(await handleCancel(client, a));
      default: throw new Error(`unknown tool: ${name}`);
    }
  });

  return server;
}

// Entry point: only run the stdio transport when executed directly.
if (import.meta.main) {
  const baseUrl = process.env.SLSKD_BASE_URL ?? "http://localhost:5030";
  const apiKey = process.env.SLSKD_API_KEY;
  if (!apiKey) {
    console.error("SLSKD_API_KEY is required");
    process.exit(1);
  }
  const client = new SlskdClient(baseUrl, apiKey);
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/mcp-handlers.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Smoke-test the MCP server starts**

Run: `SLSKD_API_KEY=dummy bun run src/mcp-server.ts < /dev/null`
Expected: starts, waits on stdio, exits cleanly on EOF with no stack trace. (It will not connect to slskd; we only assert it boots.)

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/mcp-server.ts tests/mcp-handlers.test.ts
git commit -m "feat: focused slskd MCP server (search/download/status/cancel/health)"
```

---

### Task 5: Bootstrap script (`setup.ts`)

Side-effecting orchestration with pure, tested helpers.

**Files:**
- Create: `setup.ts`
- Test: `tests/setup-helpers.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (standalone).
- Produces exported pure helpers (the rest is `main()`):
  - `paths(home: string): { configDir: string; configFile: string; downloadsDir: string; repoRoot: string }`
  - `buildSlskdYml(o: { username: string; password: string; apiKey: string; port: number }): string`
  - `buildDockerRunArgs(o: { configFile: string; downloadsDir: string; port: number }): string[]`
  - `buildMcpAddArgs(o: { repoRoot: string; baseUrl: string; apiKey: string }): string[]`
  - `generateApiKey(): string`

- [ ] **Step 1: Write failing tests** in `tests/setup-helpers.test.ts`

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/setup-helpers.test.ts`
Expected: FAIL — `setup.ts` not found / not exporting.

- [ ] **Step 3: Implement `setup.ts`**

```ts
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
```

- [ ] **Step 4: Run helper tests to verify they pass**

Run: `bun test tests/setup-helpers.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Verify `--status` runs without throwing (no Docker side effects)**

Run: `bun run setup.ts --status`
Expected: prints "Container: not running" (or current status) and a health line; exits 0. No stack trace.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add setup.ts tests/setup-helpers.test.ts
git commit -m "feat: setup.ts bootstrap (docker slskd + config + mcp registration)"
```

---

### Task 6: SKILL.md + README

**Files:**
- Create: `SKILL.md`
- Create: `README.md`

**Interfaces:**
- Consumes: tool names from Task 4 (`soulseek_health`, `soulseek_search`, `soulseek_download`, `soulseek_transfer_status`, `soulseek_cancel`).
- Produces: the skill Claude loads.

- [ ] **Step 1: Create `SKILL.md`**

```markdown
---
name: soulseek
description: Use when the user wants to find and download a song, track, album, or specific file from Soulseek — e.g. "grab the FLAC of X", "download <song> via soulseek", "get me the highest quality version of <track>". Searches Soulseek via the slskd MCP server, ranks results by audio quality, downloads the best one, and monitors it to completion with fallback.
---

# Soulseek: find & download the highest-quality track

Use the `soulseek_*` MCP tools (backed by a local slskd instance) to find and download music.

## Preflight

1. Call `soulseek_health`. If it errors or returns `connected: false`, tell the user to run
   `bun run setup.ts` in the soulseek-claude-skill repo (or `bun run setup.ts --status` to diagnose).
   Do not proceed until healthy.

## Workflow (per requested track)

1. **Parse intent.** Extract artist + title. Determine the quality policy from the user's words:
   - "lossless only" / "FLAC only" → `lossless-only`
   - "any quality" / "just get it" / "whatever" → `best-available`
   - otherwise → `lossless-first` (default)

2. **Search.** Call `soulseek_search` with `{ query, policy }`. Use a clean query
   ("Artist Title"). If `candidates` is empty:
   - For `lossless-only`: tell the user no lossless copy was found; ask whether to retry as `lossless-first`.
   - Otherwise broaden once (drop featured artists, remove punctuation, try "title artist") and search again.

3. **Pick.** Take `candidates[0]`. Briefly tell the user what you chose and why (use its `format`,
   `bitRate`, and `reason`). Keep a pointer to the remaining candidates for fallback.

4. **Download.** Call `soulseek_download` with the candidate's `username`, `filename`, `size`.
   Keep the returned `transferId`.

5. **Monitor loop.** Poll `soulseek_transfer_status` with `{ username, transferId }` every ~5–10s:
   - `phase: "succeeded"` → done. Go to step 6.
   - `phase: "failed"` → stalled/rejected. Cancel is unnecessary (already terminal); go to fallback.
   - `phase: "in_progress"` but `bytesTransferred` unchanged across ~6 consecutive polls (~60s) →
     treat as stalled: call `soulseek_cancel`, then fall back.
   - `phase: "queued"` for a long time (no movement in ~90s) → fall back.
   - **Fallback:** move to the next candidate in the list, download it, and repeat the loop.
     Never retry the same `username` you just abandoned. Cap at 5 candidates total.

6. **Verify & report.** On success, report: the file (it lands under `~/Music/soulseek/`),
   its format/bitrate, and how many fallbacks it took. If all candidates are exhausted without
   success, report failure clearly and list what was tried.

## Guardrails

- Download only the track(s) the user asked for. Do not grab whole albums/discographies unless asked.
- Honor `lossless-only` as a hard requirement — never silently substitute a lossy file.
- If you had to settle for lower quality than requested, say so explicitly.
- Don't retry a peer that just failed/stalled.
```

- [ ] **Step 2: Create `README.md`**

```markdown
# soulseek-claude-skill

A Claude skill that finds the highest-quality copy of a song on Soulseek and downloads it,
via a local [slskd](https://github.com/slskd/slskd) instance and a focused MCP server.

## Requirements

- [bun](https://bun.sh)
- Docker (Desktop, running)
- A Soulseek account (username + password)

## Setup

```bash
bun install
SLSK_USERNAME=youruser SLSK_PASSWORD=yourpass bun run setup.ts
```

This bootstraps slskd in Docker, writes `~/.config/slskd/slskd.yml`, downloads to
`~/Music/soulseek/`, and registers the `soulseek` MCP server with Claude (user scope).

- `bun run setup.ts --status` — check container + health
- `bun run setup.ts --reset` — remove the container (keeps config)

## Usage

Ask Claude things like:
- "grab the FLAC of Radiohead – Weird Fishes via soulseek"
- "download <song>, lossless only"
- "get me the highest quality <track>"

## Development

```bash
bun test          # run all tests
bun run typecheck # tsc --noEmit
```

## Architecture

- `setup.ts` — Docker/slskd/MCP bootstrap
- `src/slskd-client.ts` — typed slskd REST client
- `src/pick-best.ts` — pure quality ranking + fake-lossless sanity checks
- `src/mcp-server.ts` — MCP server exposing 5 tools
- `SKILL.md` — the workflow Claude follows
```

- [ ] **Step 3: Verify SKILL.md frontmatter parses**

Run: `bun -e "const t=await Bun.file('SKILL.md').text(); const m=t.match(/^---\n([\s\S]*?)\n---/); if(!m) throw new Error('no frontmatter'); if(!/name: soulseek/.test(m[1])) throw new Error('bad name'); if(!/description:/.test(m[1])) throw new Error('no description'); console.log('frontmatter ok')"`
Expected: prints "frontmatter ok".

- [ ] **Step 4: Run the full test suite**

Run: `bun test`
Expected: all tests across all files PASS.

- [ ] **Step 5: Commit**

```bash
git add SKILL.md README.md
git commit -m "feat: SKILL.md workflow and README"
```

---

## Manual end-to-end verification (after all tasks)

These require Docker + a real Soulseek account and can't be unit-tested:

1. `SLSK_USERNAME=... SLSK_PASSWORD=... bun run setup.ts` → reaches "✅ Soulseek skill ready."
2. `bun run setup.ts --status` → container running, Health "Healthy".
3. In a new Claude Code session: confirm the `soulseek` MCP tools are listed.
4. Ask Claude to "grab the FLAC of <a well-seeded track> via soulseek" → a `.flac` lands in `~/Music/soulseek/` and Claude reports the path.
5. Ask for a `lossless-only` track that has no FLAC → Claude reports no lossless copy rather than grabbing MP3.

---

## Self-Review notes

- **Spec coverage:** Docker bootstrap (Task 5), creds into config (Task 5), per-request policy + lossless-first default (Tasks 2, 4, 6), always-on sanity checks with abstain-on-missing-data (Task 2), monitor-to-completion + fallback (Task 6 SKILL), verify landing in `~/Music/soulseek/` (Task 6 SKILL + Task 5 mount), skill triggers (Task 6), our own TS+bun MCP server (Tasks 3–4). All spec sections map to a task.
- **Deviations from spec (intentional):** (a) consolidated `scripts/`+`mcp-server/` into `src/`; (b) ranking runs *inside* the `soulseek_search` tool (server-side) rather than as a separate step Claude invokes, so candidates come back already ranked — more reliable than Claude hand-ranking; (c) the monitor loop is driven by the skill (Claude) via repeated `soulseek_transfer_status` calls, as approved.
- **Type consistency:** `Candidate`, `TransferStatus`, `Policy` defined in Task 1 and used unchanged in Tasks 2–4. Tool names consistent between Task 4 (definitions) and Task 6 (SKILL usage).
```
