# Soulseek Claude Skill — Design

**Date:** 2026-06-26
**Status:** Approved (design); pending implementation plan

## Goal

A Claude skill that, on request, finds the **highest-quality** copy of a song on
the Soulseek network and downloads it — reliably landing a real file, falling
back through alternatives when peers stall. The skill makes Claude aware that a
Soulseek MCP server exists and encodes the search → rank → download → monitor
workflow, so Claude reaches for it consistently.

## Decisions (locked during brainstorming)

- **Backend:** slskd (headless Soulseek daemon), driven via an slskd MCP server. Not direct-creds.
- **Deployment:** slskd runs in **Docker**; `setup.ts` bootstraps it.
- **Account:** user already has a Soulseek account; `setup.ts` prompts for / reads creds and writes them into slskd config.
- **Quality model:** per-request **configurable policy** (option C), lossless-first default, sanity checks always on.
- **Completion:** **monitor to completion** (option B) — poll, fall back on stall, verify a real file landed.
- **Skill location:** `/Users/z/github/soulseek-claude-skill/`.
- **Download destination:** `~/Music/soulseek/` (default).
- **Language:** if a maintained slskd MCP server exists, use it regardless of language; otherwise build our own in **TypeScript + bun**.

## Architecture

```
soulseek-claude-skill/
├── SKILL.md              # trigger + the quality-ranking workflow
├── setup.ts              # one-time bootstrap: Docker slskd + creds + MCP registration
├── scripts/
│   └── pick-best.ts      # pure ranking/sanity-check logic (testable, no I/O)
├── mcp-server/           # ONLY if no maintained slskd MCP server exists (TS+bun)
└── README.md             # human-facing install/usage
```

Components:
- **slskd** — Docker container (`slskd/slskd`), REST API on `localhost:5030`, logged into Soulseek, downloads bind-mounted to `~/Music/soulseek/`.
- **slskd MCP server** — registered via `claude mcp add`; exposes tools: `search`, `get_results`, `enqueue_download`, `transfer_status`, `cancel`. Reused if a good one exists, else built in TS+bun.
- **SKILL.md** — encodes the workflow and triggers.

## `setup.ts` (one-time bootstrap)

Run via `bun setup.ts` (preferred) / `npx tsx setup.ts`. Idempotent. Flags: `--status`, `--reset`.

1. **Preflight** — verify Docker installed and daemon running; clear error if not.
2. **Credentials** — read `SLSK_USERNAME`/`SLSK_PASSWORD` from env, else prompt interactively. Never echo the password; store only in slskd config.
3. **Generate slskd config** — write `~/.config/slskd/slskd.yml`: Soulseek creds, download dir → `~/Music/soulseek/`, generated REST API key, web UI on `localhost:5030`.
4. **Launch container** — `docker run -d --name slskd --restart unless-stopped` with port `5030` and volumes for config + downloads. Recreate cleanly if a `slskd` container already exists.
5. **Health check** — poll `http://localhost:5030/health` until up and connected to the Soulseek network; timeout with a helpful error.
6. **Register MCP** — `claude mcp add` for the slskd MCP server with slskd URL + API key. Detect existing registration and skip/update.
7. **Report** — container status, network connection, MCP registration, download path, usage hint.

## Ranking & sanity checks (`scripts/pick-best.ts`)

Pure function: `(results, policy) -> ordered candidate list`. No I/O; unit-tested with fixtures.

**Quality policy** (parsed per-request from phrasing):
- `lossless-first` (default) — FLAC/WAV/ALAC, then MP3 320, then lower.
- `lossless-only` — lossless only; fail if none ("FLAC only" / "lossless only").
- `best-available` — top of ranking regardless of format.

**Ranking key** (within the policy's allowed set):
1. **Format tier** — lossless > MP3 320 > MP3 V0/V2 > lower.
2. **Sanity check (drop fakes)** — implied bytes/sec (`fileSize / trackLength`) must fall in a plausible band for the claimed format (e.g. a 3 MB "FLAC" of a 4-min track is fake; real FLAC ≈ 20–40 MB). Hard-fail → drop; soft-suspect → deprioritize. **Abstain when track length / bitrate is missing** — only drop on a confident mismatch.
3. **Bitrate** — higher within a tier.
4. **Peer availability** — free upload slot first, then faster reported speed, then shorter queue.
5. **File size** — larger as tiebreaker (proxy for less re-encoding).

Output: ordered candidate list (enables fallback), each annotated with *why* it ranked there so Claude can explain the pick.

## The skill (`SKILL.md`) — workflow

**Frontmatter:** `name: soulseek`; description triggers on requests to find/download a song, grab a track/FLAC, etc. — so Claude reliably uses the MCP.

**Preflight:** confirm slskd healthy via MCP; if down/unconfigured, tell the user to run `setup.ts` rather than failing cryptically.

**Per request:**
1. **Parse intent** — artist/title + quality policy (default `lossless-first`).
2. **Search** — query MCP; broaden if too few results (drop featured artists, try variants).
3. **Rank** — run results through `pick-best.ts` → ordered candidates.
4. **Enqueue** — start top candidate; report pick + reason.
5. **Monitor loop** — poll `transfer_status` with backoff. Stall = no byte progress for ~60s, or state `Errored`/`Cancelled`/`Rejected`. On stall: cancel, drop to next candidate, retry. Cap attempts (~5 candidates).
6. **Verify landing** — confirm file exists in `~/Music/soulseek/`, non-zero, size matches expected; report final path.
7. **Report** — final file, format/bitrate, number of fallbacks. If exhausted (or `lossless-only` found nothing), report failure clearly with what was tried.

**Guardrails:** never download more than requested track(s) without asking; honor `lossless-only` as hard fail; don't retry the same dead peer twice; surface (don't hide) when it settled for lower quality than requested.

## Open items for the planning phase

- Research existing slskd MCP servers; pick the most maintained, or decide to build (TS+bun). Pin the exact `claude mcp add` command accordingly.
- Confirm slskd config schema / env var names against current slskd release.
- Confirm which result fields slskd actually returns (track length, bitrate, slot status) to finalize the sanity-check heuristics.

## Non-goals

- No direct-creds (non-slskd) backend.
- No bulk/discography scraping by default.
- No metadata tagging / library organization beyond landing the file.
