# soulseek-claude-skill

A Claude skill that finds the highest-quality copy of a song on Soulseek and downloads it,
via a local [slskd](https://github.com/slskd/slskd) instance and a focused MCP server.

## Requirements

- [bun](https://bun.sh)
- Docker (Desktop, running)
- A Soulseek account, configured in [SoulseekQt](https://www.slsknet.org/) (its `soulseek.scd1` config holds your password)

## Setup

```bash
bun install
bun run setup.ts ~/Desktop/soulseek.scd1
```

`setup.ts` reads your **password** from the SoulseekQt config file you point it at
(`soulseek.scd1`). To get that file: quit SoulseekQt and copy the `soulseek.scd1` from its
data folder. You can also pass the path via `SLSK_SCD1=...` or let setup prompt for it.

> The `.scd1` format does not store your login **username**, so setup still needs it —
> set `SLSK_USERNAME=yournick` (or enter it when prompted).

```bash
SLSK_USERNAME=yournick bun run setup.ts ~/Desktop/soulseek.scd1
```

This bootstraps slskd in Docker, writes `~/.config/slskd/slskd.yml`, downloads to
`~/Music/soulseek/`, and registers the `soulseek` MCP server with Claude (user scope).

> Security: `soulseek.scd1` contains your password in plaintext, and the generated
> `~/.config/slskd/slskd.yml` stores it too. Keep both private; don't commit them.

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
