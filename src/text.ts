// Utterance normalization. This is the one place that enforces the contract the
// whole agent side depends on: one utterance is exactly one line.

import { MAX_UTTERANCE_CHARS } from "./protocol";

/**
 * Fold an utterance into a single line of printable text.
 * Returns null when nothing usable is left.
 */
export function normalizeUtterance(raw: string): string | null {
  // Line separators become spaces; a lost newline here would split one thing the
  // user said into several conversation events on the agent side.
  const singleLine = raw.replace(/[\r\n\u2028\u2029\t\v\f]+/g, " ");
  // Remaining control characters carry no meaning in a transcript and can confuse
  // whatever reads the stdout line.
  const printable = singleLine.replace(/[\u0000-\u001f\u007f]/g, "");
  const collapsed = printable.replace(/\s{2,}/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > MAX_UTTERANCE_CHARS ? collapsed.slice(0, MAX_UTTERANCE_CHARS) : collapsed;
}

/** Spoken text keeps its line breaks; only the length is capped. */
export function normalizeSpeech(raw: string): string | null {
  const trimmed = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_UTTERANCE_CHARS ? trimmed.slice(0, MAX_UTTERANCE_CHARS) : trimmed;
}
