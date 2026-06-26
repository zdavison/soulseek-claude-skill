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
