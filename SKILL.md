---
name: soulseek
description: Use when the user wants to find and download a song, track, album, or specific file from Soulseek — e.g. "grab the FLAC of X", "download <song> via soulseek", "get me the highest quality version of <track>". Drives a local slskd instance directly over its REST API (via a small bun CLI, no MCP server), ranks results by audio quality, downloads the best one, and monitors it to completion with fallback.
---

# Soulseek: find & download the highest-quality track (direct-drive, no MCP)

You drive slskd directly with a bun CLI over Bash — there are no `soulseek_*` MCP
tools and nothing to register. slskd is lazy-launched by the CLI on first use.

Set the CLI path once at the start of the task (adjust if the skill lives elsewhere):

```bash
SS="bun $SOULSEEK_DIR/src/cli.ts"   # e.g. SOULSEEK_DIR=$HOME/.soulseek-skill
```

Every command prints one line of JSON to stdout. Parse it with `jq`.

## Preflight

1. Run `$SS health`. If it errors or `.connected` is `false`, slskd is not on the
   Soulseek network yet — wait a few seconds and retry once. If it stays
   disconnected, report the raw output and stop; do not proceed to search.
   (Creds come from the environment: `SLSKD_SLSK_USERNAME`, `SLSKD_SLSK_PASSWORD`,
   `SLSKD_API_KEY`. If `SLSKD_API_KEY` is unset the CLI fails fast — surface that.)

## Workflow (per requested track)

1. **Parse intent.** Extract artist + title. Determine the quality policy:
   - "lossless only" / "FLAC only" → `lossless-only`
   - "any quality" / "just get it" / "whatever" → `best-available`
   - otherwise → `lossless-first` (default)

2. **Search.**
   ```bash
   $SS search --query "Artist Title" --policy lossless-first > /tmp/ss.json
   jq '.candidates | length' /tmp/ss.json
   ```
   If `.candidates` is empty:
   - `lossless-only`: tell the user no lossless copy was found; ask whether to retry as `lossless-first`.
   - otherwise: broaden once (drop featured artists, remove punctuation, try "title artist") and search again.

3. **Pick.** Take `candidates[0]`. Tell the user what you chose and why using its
   `.format`, `.bitRate`, and `.reason`. Keep the rest of the list for fallback.
   ```bash
   jq '.candidates[0]' /tmp/ss.json
   ```

4. **Download.** Pipe the chosen candidate straight in; keep the returned `transferId`.
   ```bash
   jq -c '.candidates[0] | {username, filename, size}' /tmp/ss.json | $SS download
   ```

5. **Monitor loop.** Poll every ~5–10s:
   ```bash
   $SS status --username "<username>" --transferId "<transferId>"
   ```
   - `.phase == "succeeded"` → done. Go to step 6.
   - `.phase == "failed"` → `$SS cancel --username <u> --transferId <id>`, then fall back.
   - `.phase == "in_progress"` but `.bytesTransferred` unchanged across ~6 consecutive
     polls (~60s) → treat as stalled: `cancel`, then fall back.
   - `.phase == "queued"` and still queued after ~90s with no progress → `cancel`, then fall back.
   - **Fallback:** move to the next candidate, `download` it, repeat the loop.
     Never retry the same `username` you just abandoned. Cap at 5 candidates total.

6. **Verify & report.** On success, report the file (it lands under `~/Music/soulseek/`),
   its format/bitrate, and how many fallbacks it took. If all candidates are
   exhausted without success, report failure clearly and list what was tried.

## Guardrails

- Download only the track(s) the user asked for. Do not grab whole albums/discographies unless asked.
- Honor `lossless-only` as a hard requirement — never silently substitute a lossy file.
- If you had to settle for lower quality than requested, say so explicitly.
- Don't retry a peer that just failed/stalled.
- `search` already drops fake-lossless files (a "FLAC" whose implied bitrate is below
  the sanity floor) and flags suspicious ones as `suspectFake` — trust that; don't
  second-guess a candidate the ranker already vetted.
