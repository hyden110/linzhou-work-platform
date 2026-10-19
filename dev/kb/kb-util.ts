/**
 * Small text helpers ported from base/sa-workbench scripts/lib/kb/util.js.
 * Pure functions only — no I/O, no clocks, fully unit-testable.
 */

/** Collapse whitespace, trim and truncate with an ellipsis marker. */
export function trunc(value: unknown, max: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Keyword snippet: context around the earliest matching term. */
export function snippetOf(text: string, terms: readonly string[], len = 180): string {
  const flat = String(text ?? "").replace(/\s+/g, " ");
  const low = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const index = low.indexOf(term);
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  if (at < 0) return trunc(flat, len);
  const start = Math.max(0, at - Math.floor(len / 3));
  return `${start > 0 ? "…" : ""}${trunc(flat.slice(start), len)}`;
}

/** Lowercased unique whitespace terms of a query (max 8). */
export function terms(query: string): string[] {
  return Array.from(
    new Set(String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean)),
  ).slice(0, 8);
}

/**
 * CLI output often prints warning lines before the JSON body; parse from the
 * first `{` or `[` so noisy adapters keep working.
 */
export function parseJsonPayload(text: string): unknown | undefined {
  const raw = String(text ?? "");
  const start = raw.search(/[{[]/);
  if (start < 0) return undefined;
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return undefined;
  }
}
