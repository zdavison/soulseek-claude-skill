# soulseek-claude-skill

A Claude skill that finds the highest-quality copy of a song on Soulseek and downloads it,
via a local [slskd](https://github.com/slskd/slskd) instance driven **directly over its
REST API** — a small `bun` CLI, no MCP server.

## Requirements

- [bun](https://bun.sh)
- A Soulseek account (username + password)

slskd itself is **not** a prerequisite: the CLI lazy-launches it on first use, resolving
the binary from `$SLSKD_BINARY` → `PATH` → a cached download → an auto-downloaded pinned
release. No Docker.

## Setup

```bash
bun install
```

Then export the runtime config (the CLI reads it from the environment — no config file):

```bash
export SLSKD_SLSK_USERNAME=youruser
export SLSKD_SLSK_PASSWORD=yourpass
export SLSKD_API_KEY="$(openssl rand -hex 24)"
```

- `SLSKD_API_KEY` (required) — the CLI sends it as `X-Api-Key`; `ensureSlskd()` launches
  slskd with the role-formatted primary key derived from the same value.
- `SLSKD_SLSK_USERNAME` / `SLSKD_SLSK_PASSWORD` — Soulseek credentials passed to the
  slskd child.
- `SLSKD_BASE_URL` (default `http://localhost:5030`), `SLSKD_HTTP_PORT`,
  `SLSKD_DOWNLOADS_DIR`, `SLSKD_APP_DIR` — optional overrides.

> Lost your Soulseek password? SoulseekQt stores it in **plaintext** in its `soulseek.scd1`
> config (and on Windows, the `login` value under `HKCU\Software\Soulseek2\config`).
> Keep any file that holds these credentials private; don't commit it.

## Usage

Ask Claude things like:
- "grab the FLAC of Radiohead – Weird Fishes via soulseek"
- "download <song>, lossless only"
- "get me the highest quality <track>"

Claude follows `SKILL.md`, which drives the CLI over Bash. You can also run it directly:

```bash
export SS="bun src/cli.ts"
$SS health
$SS search --query "Radiohead Weird Fishes" --policy lossless-first > /tmp/ss.json
jq -c '.candidates[0] | {username, filename, size}' /tmp/ss.json | $SS download
$SS status --username "<username>" --transferId "<transferId>"
$SS cancel --username "<username>" --transferId "<transferId>"
```

Each command prints one line of JSON to stdout. `download` reads the chosen candidate
(`{username, filename, size}`) as JSON on stdin. Downloads land under `~/Music/soulseek/`.

## Development

```bash
bun test          # run all tests
bun run typecheck # tsc --noEmit
```

## Architecture

- `src/cli.ts` — the CLI: `health | search | download | status | cancel` (the skill's only entrypoint)
- `src/slskd-client.ts` — typed slskd REST client
- `src/ensure-slskd.ts` — lazy-launch slskd before the first call that needs it
- `src/slskd-binary.ts` — resolve the slskd binary for native launch (PATH first, else auto-download the pinned release)
- `src/pick-best.ts` — pure quality ranking + fake-lossless sanity checks
- `SKILL.md` — the workflow Claude follows
