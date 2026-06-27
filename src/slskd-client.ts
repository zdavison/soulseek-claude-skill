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

  /**
   * Makes an authenticated request to slskd. Suppresses 404 (returns the response)
   * so polling callers can check res.ok; callers MUST check res.ok before using the body.
   */
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
      // /health is a public, unauthenticated endpoint; intentionally bypass req() and API key.
      const h = await fetch(`${this.baseUrl}/health`);
      healthy = h.ok;
    } catch { healthy = false; }
    try {
      const a = await this.req("/api/v0/application");
      if (!a.ok) return { healthy, connected: false, version: null };
      const body: any = await a.json();
      const state: string = body?.server?.state ?? "";
      return { healthy, connected: /connected/i.test(state) && !/disconnected/i.test(state), version: body?.version ?? null };
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
    const createRes = await this.req("/api/v0/searches", {
      method: "POST",
      body: JSON.stringify({ id, searchText: query }),
    });
    let searchId = id;
    try {
      const body: any = await createRes.json();
      if (body?.id) searchId = body.id;
    } catch { /* slskd returned a non-JSON/empty body; use the client-generated id */ }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const stateRes = await this.req(`/api/v0/searches/${searchId}`);
      if (stateRes.ok) {
        const st: any = await stateRes.json();
        const count = st?.responseCount ?? 0;
        if (st?.isComplete || count >= minResponses) break;
      }
    }

    const res = await this.req(`/api/v0/searches/${searchId}/responses`);
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
    await this.req(`/api/v0/transfers/downloads/${encodeURIComponent(username)}`, {
      method: "POST",
      body: JSON.stringify([{ filename, size }]),
    });
    // slskd's enqueue response doesn't include the transfer id; look it up with retry
    // to allow async registration, and disambiguate by matching both filename and size.
    const terminalRe = /succeeded|errored|cancelled|canceled|timedout|rejected/i;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(500);
      const res = await this.req(`/api/v0/transfers/downloads/${encodeURIComponent(username)}`);
      if (!res.ok) continue;
      const body: any = await res.json();
      const files = (body?.directories ?? []).flatMap((d: any) => d.files ?? []);
      const matches = files.filter((f: any) => f.filename === filename && f.size === size);
      if (matches.length > 0) {
        // Prefer a non-terminal entry; fall back to the first match if all are terminal.
        const active = matches.find((f: any) => !terminalRe.test(f.state ?? ""));
        const match = active ?? matches[0];
        if (match?.id) return match.id;
      }
    }
    throw new Error(`enqueued file not found in downloads list: ${filename}`);
  }

  async transferStatus(username: string, id: string): Promise<TransferStatus> {
    const res = await this.req(`/api/v0/transfers/downloads/${encodeURIComponent(username)}/${id}`);
    if (!res.ok) throw new Error(`transfer ${id} not found`);
    const t: any = await res.json();
    const size = t.size ?? 0;
    const bytes = t.bytesTransferred ?? t.bytesReceived ?? 0;
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
    await this.req(`/api/v0/transfers/downloads/${encodeURIComponent(username)}/${id}?remove=${remove}`, {
      method: "DELETE",
    });
  }
}
