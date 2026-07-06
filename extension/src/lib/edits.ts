// Apply find/replace edits to a source file in memory.
//
// Rules:
//   - Each `find` must occur exactly once in the file. Zero or multiple
//     matches reject - the model has to be more specific.
//   - Edits apply sequentially; later edits see the result of earlier
//     edits. The model is told this.
//   - Returns the edited string and per-edit results so the caller can
//     surface which edits were skipped.

export interface EditOp {
  find: string;
  replace: string;
}

export interface EditOutcome {
  op: EditOp;
  applied: boolean;
  reason?: "not_found" | "ambiguous" | "empty_find" | "invalid_replace";
}

export interface ApplyEditsResult {
  content: string;
  outcomes: EditOutcome[];
  /** True only if at least one edit applied. */
  changed: boolean;
}

export function applyEdits(original: string, edits: EditOp[]): ApplyEditsResult {
  let content = original;
  const outcomes: EditOutcome[] = [];
  // Tool-call args are UNTRUSTED: even though the schema marks find/replace
  // as required strings, the model can omit them or return the wrong type.
  // Normalize each op and reject malformed ones rather than concatenating a
  // literal "undefined" into the file (which would then get committed).
  const ops = Array.isArray(edits) ? edits : [];
  for (const raw of ops) {
    const op: EditOp = {
      find: typeof raw?.find === "string" ? raw.find : "",
      replace: typeof raw?.replace === "string" ? raw.replace : "",
    };
    if (op.find === "") {
      outcomes.push({ op, applied: false, reason: "empty_find" });
      continue;
    }
    if (typeof raw?.replace !== "string") {
      outcomes.push({ op, applied: false, reason: "invalid_replace" });
      continue;
    }
    const first = content.indexOf(op.find);
    if (first === -1) {
      outcomes.push({ op, applied: false, reason: "not_found" });
      continue;
    }
    // Search from first + 1, not first + find.length, so OVERLAPPING repeats
    // are still caught as ambiguous (e.g. "aa" occurs twice in "aaa"). A find
    // that overlaps itself is ambiguous about which occurrence was meant.
    const second = content.indexOf(op.find, first + 1);
    if (second !== -1) {
      outcomes.push({ op, applied: false, reason: "ambiguous" });
      continue;
    }
    content =
      content.slice(0, first) + op.replace + content.slice(first + op.find.length);
    outcomes.push({ op, applied: true });
  }
  return { content, outcomes, changed: content !== original };
}

/**
 * Build a short git branch slug from a PR title. Keeps the output
 * alphanumeric with hyphens so it works in refs/heads/ without quoting.
 */
export function slugify(input: string, maxLen = 48): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return base || "edit";
}

/**
 * Unique branch name: `prodocstore/YYYY-MM-DD/<slug>-<rand>`.
 * The random suffix avoids collisions when the same edit is proposed twice
 * in one day.
 */
export function branchName(summary: string, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 6);
  return `prodocstore/${date}/${slugify(summary)}-${rand}`;
}

/**
 * Human-readable one-liner for each edit outcome. Used to surface
 * partial-success and partial-failure in the chat.
 */
export function describeOutcomes(outcomes: EditOutcome[]): string[] {
  return outcomes.map((o) => {
    const preview = o.op.find.slice(0, 80).replace(/\s+/g, " ");
    if (o.applied) return `\u2713 applied: "${preview}\u2026"`;
    const label = {
      not_found: "not found",
      ambiguous: "ambiguous (multiple matches)",
      empty_find: "empty find string",
      invalid_replace: "invalid replacement (not a string)",
    }[o.reason ?? "not_found"];
    return `\u2717 ${label}: "${preview}\u2026"`;
  });
}
