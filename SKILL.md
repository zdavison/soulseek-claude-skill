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
   - `phase: "failed"` → stalled/rejected. Call `soulseek_cancel` (removes the terminal entry so it can't collide with a later enqueue), then fall back.
   - `phase: "in_progress"` but `bytesTransferred` unchanged across ~6 consecutive polls (~60s) →
     treat as stalled: call `soulseek_cancel`, then fall back.
   - `phase: "queued"` and still queued after ~90s with no progress → `soulseek_cancel` it, then fall back.
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
