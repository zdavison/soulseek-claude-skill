// Format classification of a file.
export type Format = "flac" | "wav" | "alac" | "ape" | "mp3" | "aac" | "ogg" | "other";
export type Policy = "lossless-first" | "lossless-only" | "best-available";

// A file inside a slskd search response (subset of slskd's Soulseek.File).
export interface SlskdFile {
  filename: string;
  size: number;
  bitRate?: number | null;     // kbps, often null for lossless
  length?: number | null;      // seconds, often null
  bitDepth?: number | null;
  sampleRate?: number | null;
  isVariableBitRate?: boolean | null;
  extension?: string | null;
}

// A search response from one peer (subset of slskd's response object).
export interface SlskdSearchResponse {
  username: string;
  hasFreeUploadSlot: boolean;
  queueLength: number;
  uploadSpeed: number;
  files: SlskdFile[];
}

// A fully-evaluated candidate used internally for ranking. All the signals the
// ranker computes live here; only a projected subset (Candidate) is emitted.
export interface RankedCandidate {
  username: string;
  filename: string;
  size: number;
  format: Format;
  lossless: boolean;
  bitRate: number | null;
  lengthSeconds: number | null;
  hasFreeUploadSlot: boolean;
  queueLength: number;
  uploadSpeed: number;
  score: number;       // higher = better; for ranking
  reason: string;      // human-readable explanation of the ranking
  suspectFake: boolean;// soft-suspect lossless (kept but penalized)
}

// The emitted download candidate — a token-lean projection of RankedCandidate.
// username/filename/size are the download contract (read back on stdin); format,
// bitRate and reason are what the model needs to explain its pick.
export interface Candidate {
  username: string;
  filename: string;
  size: number;
  format: Format;
  bitRate: number | null;
  reason: string;
}

// Normalized transfer state (from slskd's flags string).
export type TransferPhase = "queued" | "in_progress" | "succeeded" | "failed";
export interface TransferStatus {
  id: string;
  phase: TransferPhase;
  rawState: string;
  size: number;
  bytesTransferred: number;
  percentComplete: number;
  averageSpeed: number;
}
