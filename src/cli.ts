#!/usr/bin/env bun
// Direct-drive CLI over slskd — the whole skill, no MCP.
//
// Exposes the same logic the (removed) MCP server used — SlskdClient + pickBest +
// ensureSlskd — as plain subcommands the soulseek skill drives via Bash. No MCP
// server process, no `claude mcp add`, no session-lifecycle coupling: the agent
// just runs `bun src/cli.ts <cmd>`. slskd itself is lazy-launched (ensureSlskd) on
// first use, and its binary is resolved/auto-downloaded natively.
//
// I/O contract: every command prints ONE line of JSON to stdout on success, or a
// message to stderr + non-zero exit on failure. `download` reads its candidate as
// JSON on stdin (Soulseek filenames contain backslashes/spaces/unicode — piping the
// object avoids all shell-quoting hazards).
import { SlskdClient } from "./slskd-client";
import { pickBest } from "./pick-best";
import { ensureSlskd } from "./ensure-slskd";
import { toon } from "./toon";
import type { Policy } from "./types";

// The slskd surface the CLI needs — mirrors the client, injectable for tests.
export type ClientLike = Pick<
  SlskdClient,
  "health" | "searchAndCollect" | "enqueue" | "transferStatus" | "cancel"
>;

export interface CliDeps {
  client: ClientLike;
  ensure: () => Promise<void>;
  readStdin: () => Promise<string>;
  write: (data: unknown) => void;
  writeRaw: (text: string) => void;   // raw stdout, no JSON encoding (for `toon`)
  fail: (msg: string) => never;
}

// Minimal `--key value` parser (no external deps).
export function parseOpts(argv: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { o[argv[i].slice(2)] = argv[i + 1] ?? ""; i++; }
  }
  return o;
}

// Routes a command. slskd is ensured up before any call that talks to it.
export async function runCli(argv: string[], d: CliDeps): Promise<void> {
  const [cmd, ...rest] = argv;
  const a = parseOpts(rest);

  switch (cmd) {
    // Preflight: ensure slskd is up + connected, then report.
    case "health": {
      await d.ensure();
      d.write(await d.client.health());
      return;
    }

    // Search + rank. Prints { candidates: [...] } best-first (pickBest applies the
    // policy filter and the fake-lossless sanity floors).
    case "search": {
      if (!a.query) d.fail("--query is required");
      const policy: Policy = (a.policy as Policy) ?? "lossless-first";
      await d.ensure();
      const responses = await d.client.searchAndCollect(a.query, { minResponses: 5, timeoutMs: 8000 });
      d.write({ candidates: pickBest(responses, policy) });
      return;
    }

    // Enqueue a chosen candidate. Reads { username, filename, size } from stdin
    // (pipe candidates[0] straight in). Prints { transferId }.
    case "download": {
      const text = await d.readStdin();
      if (!text.trim()) d.fail('download reads {"username","filename","size"} JSON on stdin');
      let c: any;
      try { c = JSON.parse(text); } catch { d.fail("stdin is not valid JSON"); }
      if (!c.username || !c.filename || typeof c.size !== "number") {
        d.fail('stdin must be {"username","filename","size"} (e.g. candidates[0] from search)');
      }
      await d.ensure();
      d.write({ transferId: await d.client.enqueue(c.username, c.filename, c.size) });
      return;
    }

    // Poll a download. Prints the normalized status (phase, percentComplete, ...).
    case "status": {
      if (!a.username || !a.transferId) d.fail("--username and --transferId are required");
      await d.ensure();
      d.write(await d.client.transferStatus(a.username, a.transferId));
      return;
    }

    // Presentation-only: render JSON from stdin as a compact TOON table for the
    // model to read. Pure formatting — no slskd, so no ensure(). The CLI still
    // emits JSON everywhere else; this is the last-moment view conversion.
    case "toon": {
      const text = await d.readStdin();
      if (!text.trim()) d.fail("toon reads JSON on stdin");
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { d.fail("stdin is not valid JSON"); }
      d.writeRaw(toon(parsed));
      return;
    }

    // Cancel + remove a stalled/rejected transfer before falling back.
    case "cancel": {
      if (!a.username || !a.transferId) d.fail("--username and --transferId are required");
      await d.ensure();
      await d.client.cancel(a.username, a.transferId, true);
      d.write({ cancelled: true });
      return;
    }

    default:
      d.fail(
        "usage: bun src/cli.ts <command>\n" +
        "  health\n" +
        "  search   --query <text> [--policy lossless-first|lossless-only|best-available]\n" +
        "  download   (reads {username,filename,size} JSON on stdin)\n" +
        "  status   --username <u> --transferId <id>\n" +
        "  cancel   --username <u> --transferId <id>\n" +
        "  toon     (reads JSON on stdin, prints a compact TOON table for reading)\n" +
        (cmd ? `unknown command: ${cmd}` : ""),
      );
  }
}

// Entry point: wire real deps only when executed directly.
if (import.meta.main) {
  const fail = (msg: string): never => { process.stderr.write(msg + "\n"); process.exit(1); };
  const baseUrl = process.env.SLSKD_BASE_URL ?? "http://localhost:5030";
  const apiKey = process.env.SLSKD_API_KEY;
  // `toon` is pure formatting — it never touches slskd, so don't demand creds for it.
  const cmd = process.argv[2];
  if (!apiKey && cmd !== "toon") {
    process.stderr.write("SLSKD_API_KEY is required\n");
    process.exit(1);
  }
  const client = new SlskdClient(baseUrl, apiKey ?? "");
  await runCli(process.argv.slice(2), {
    client,
    ensure: () => ensureSlskd(),
    readStdin: () => new Response(Bun.stdin.stream()).text(),
    write: (data) => process.stdout.write(JSON.stringify(data) + "\n"),
    writeRaw: (text) => process.stdout.write(text.endsWith("\n") ? text : text + "\n"),
    fail,
  });
}
