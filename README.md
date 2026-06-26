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
