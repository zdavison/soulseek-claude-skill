import type { Candidate, Format, Policy, RankedCandidate, SlskdFile, SlskdSearchResponse } from "./types";

const LOSSLESS: ReadonlySet<Format> = new Set(["flac", "wav", "alac", "ape"]);

// Cap on emitted candidates: the top N after ranking. Keeps the context the model
// reads small while leaving enough depth for the fallback loop.
export const DEFAULT_SEARCH_LIMIT = 8;

// Confident floor: below this implied bitrate a "lossless" file cannot be genuine -> drop.
const LOSSLESS_HARD_FLOOR_KBPS = 250;
// Soft floor: plausible but suspicious -> keep, penalize, mark suspectFake.
const LOSSLESS_SOFT_FLOOR_KBPS = 400;

const EXT_TO_FORMAT: Record<string, Format> = {
  flac: "flac", wav: "wav", aif: "wav", aiff: "wav",
  alac: "alac", m4a: "aac", aac: "aac", ape: "ape",
  mp3: "mp3", ogg: "ogg", oga: "ogg", opus: "ogg",
};

export function classifyFormat(filename: string): Format {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return "other";
  // .m4a is AAC unless the name explicitly says ALAC/lossless.
  if (m[1] === "m4a" && /alac|lossless/i.test(filename)) return "alac";
  return EXT_TO_FORMAT[m[1]] ?? "other";
}

// Implied bitrate in kbps from size+length, or null if not computable.
function impliedKbps(file: SlskdFile): number | null {
  if (!file.length || file.length <= 0 || !file.size || file.size <= 0) return null;
  return (file.size * 8) / file.length / 1000;
}

// Effective mp3/lossy bitrate for tiering: declared, else implied, else null.
function lossyKbps(file: SlskdFile): number | null {
  if (file.bitRate && file.bitRate > 0) return file.bitRate;
  return impliedKbps(file);
}

function tierScore(format: Format, file: SlskdFile): number {
  if (LOSSLESS.has(format)) return 1000;
  const br = lossyKbps(file);
  if (format === "mp3" || format === "aac" || format === "ogg") {
    if (br === null) return 450;
    if (br >= 320) return 700;
    if (br >= 256) return 650;
    if (br >= 192) return 600;
    if (br >= 128) return 500;
    return 400;
  }
  return 100;
}

interface Evaluated { candidate: RankedCandidate; drop: boolean; }

function evaluate(file: SlskdFile, r: SlskdSearchResponse): Evaluated {
  const format = classifyFormat(file.filename);
  const lossless = LOSSLESS.has(format);
  let score = tierScore(format, file);
  let suspectFake = false;
  let drop = false;
  const notes: string[] = [`${format}${lossless ? " (lossless)" : ""}`];

  if (lossless) {
    const kbps = impliedKbps(file);
    if (kbps === null) {
      notes.push("size/length unknown — sanity check abstained");
    } else if (kbps < LOSSLESS_HARD_FLOOR_KBPS) {
      drop = true;
      notes.push(`implied ${Math.round(kbps)}kbps — fake lossless, dropped`);
    } else if (kbps < LOSSLESS_SOFT_FLOOR_KBPS) {
      suspectFake = true;
      score -= 400;
      notes.push(`implied ${Math.round(kbps)}kbps — suspiciously low, penalized`);
    } else {
      notes.push(`implied ${Math.round(kbps)}kbps — plausible`);
    }
  } else {
    const br = lossyKbps(file);
    if (br) notes.push(`${Math.round(br)}kbps`);
  }

  // Peer availability adjustments (kept smaller than tier gaps so format dominates).
  if (r.hasFreeUploadSlot) { score += 30; notes.push("free slot"); }
  else { notes.push("no free slot"); }
  score -= Math.min(r.queueLength, 20);                   // up to -20 for long queues
  score += Math.min(r.uploadSpeed / 100_000, 10);         // up to +10 for fast peers
  score += file.size / 1e12;                              // tiny tiebreaker: larger wins

  const candidate: RankedCandidate = {
    username: r.username,
    filename: file.filename,
    size: file.size,
    format,
    lossless,
    bitRate: lossyKbps(file),
    lengthSeconds: file.length ?? null,
    hasFreeUploadSlot: r.hasFreeUploadSlot,
    queueLength: r.queueLength,
    uploadSpeed: r.uploadSpeed,
    score,
    reason: notes.join("; "),
    suspectFake,
  };
  return { candidate, drop };
}

// Full ranking: evaluate every file, drop fakes, apply the policy filter, sort
// best-first. Returns the complete RankedCandidate shape (no cap) — the ranking
// signals stay available internally and to tests.
export function rankCandidates(responses: SlskdSearchResponse[], policy: Policy): RankedCandidate[] {
  const evaluated = responses
    .flatMap((r) => r.files.map((f) => evaluate(f, r)))
    .filter((e) => !e.drop)
    .map((e) => e.candidate);

  const filtered = policy === "lossless-only"
    ? evaluated.filter((c) => c.lossless)
    : evaluated;

  return filtered.sort((a, b) => b.score - a.score);
}

// Project a ranked candidate down to the emitted, token-lean shape.
function project(c: RankedCandidate): Candidate {
  return {
    username: c.username,
    filename: c.filename,
    size: c.size,
    format: c.format,
    bitRate: c.bitRate,
    reason: c.reason,
  };
}

// The emitted top-N candidates: rank, cap, and project to the lean shape.
export function pickBest(
  responses: SlskdSearchResponse[],
  policy: Policy,
  limit: number = DEFAULT_SEARCH_LIMIT,
): Candidate[] {
  return rankCandidates(responses, policy).slice(0, limit).map(project);
}
