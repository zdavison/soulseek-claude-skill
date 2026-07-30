import { encode } from "@toon-format/toon";

// Last-moment JSON->TOON conversion for the model's reading. The CLI keeps
// emitting JSON (for jq/pipes); TOON is a presentation layer only. Tab delimiter:
// Soulseek filenames/titles are comma-heavy, so tab avoids per-field quoting.
export function toon(data: unknown): string {
  return encode(data, { delimiter: "\t" });
}
