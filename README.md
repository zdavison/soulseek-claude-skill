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
If you omit the env vars, setup prompts for them.

> Lost your password? SoulseekQt stores it in **plaintext** in its `soulseek.scd1`
> config (and on Windows, the `login` value under `HKCU\Software\Soulseek2\config`).
> Tools like Soulseek Password Recovery can read it back.
>
> Security: the generated `~/.config/slskd/slskd.yml` stores your password in plaintext.
> Keep it private; don't commit it.

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
- `src/slskd-binary.ts` — resolve the slskd binary for native launch (PATH first, else auto-download the pinned release)
- `src/pick-best.ts` — pure quality ranking + fake-lossless sanity checks
- `src/mcp-server.ts` — MCP server exposing 5 tools
- `SKILL.md` — the workflow Claude follows
