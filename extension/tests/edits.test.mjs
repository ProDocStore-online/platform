import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { applyEdits, slugify, branchName, describeOutcomes } = await import(
  await bundle("src/lib/edits.ts")
);

test("applyEdits: single unique match replaces cleanly", () => {
  const r = applyEdits("<p>hello world</p>", [{ find: "world", replace: "there" }]);
  assert.equal(r.content, "<p>hello there</p>");
  assert.equal(r.changed, true);
  assert.equal(r.outcomes[0].applied, true);
});

test("applyEdits: edits apply sequentially, later edits see earlier results", () => {
  const r = applyEdits("A B C", [
    { find: "A", replace: "X" },
    { find: "X B", replace: "Y" },
  ]);
  assert.equal(r.content, "Y C");
  assert.ok(r.outcomes.every((o) => o.applied));
});

test("applyEdits: ambiguous find is skipped, not applied", () => {
  const r = applyEdits("foo bar foo", [{ find: "foo", replace: "baz" }]);
  assert.equal(r.content, "foo bar foo");
  assert.equal(r.changed, false);
  assert.equal(r.outcomes[0].reason, "ambiguous");
});

test("applyEdits: OVERLAPPING repeated find is ambiguous, not applied", () => {
  // "aa" occurs at index 0 AND index 1 in "aaa" (overlapping). The guard must
  // catch this rather than treating it as a unique match at index 0.
  const r = applyEdits("aaa", [{ find: "aa", replace: "b" }]);
  assert.equal(r.content, "aaa");
  assert.equal(r.changed, false);
  assert.equal(r.outcomes[0].reason, "ambiguous");
});

test("applyEdits: not-found find is skipped", () => {
  const r = applyEdits("abc", [{ find: "xyz", replace: "def" }]);
  assert.equal(r.content, "abc");
  assert.equal(r.outcomes[0].reason, "not_found");
});

test("applyEdits: empty find string is rejected", () => {
  const r = applyEdits("abc", [{ find: "", replace: "x" }]);
  assert.equal(r.outcomes[0].reason, "empty_find");
  assert.equal(r.changed, false);
});

test("applyEdits: partial success - one applied, one skipped", () => {
  const r = applyEdits("<h1>Title</h1>", [
    { find: "Title", replace: "New Title" },
    { find: "notThere", replace: "x" },
  ]);
  assert.equal(r.content, "<h1>New Title</h1>");
  assert.equal(r.changed, true);
  assert.equal(r.outcomes[0].applied, true);
  assert.equal(r.outcomes[1].applied, false);
});

test("slugify: lowercases, hyphenates, trims to maxLen", () => {
  assert.equal(slugify("Add Architecture Section"), "add-architecture-section");
  assert.equal(slugify("  leading and trailing  "), "leading-and-trailing");
  assert.equal(slugify("Non-ascii: 'quote' & stuff"), "non-ascii-quote-stuff");
});

test("slugify: empty/whitespace falls back to 'edit'", () => {
  assert.equal(slugify(""), "edit");
  assert.equal(slugify("   "), "edit");
  assert.equal(slugify("!!!"), "edit");
});

test("branchName: includes date prefix and slug", () => {
  const fixed = new Date("2026-04-18T10:00:00Z");
  const b = branchName("Fix broken link", fixed);
  assert.match(b, /^freedocstore\/2026-04-18\/fix-broken-link-[a-z0-9]{4}$/);
});

test("describeOutcomes: formats applied and skipped distinctly", () => {
  const lines = describeOutcomes([
    { op: { find: "x", replace: "y" }, applied: true },
    { op: { find: "missing", replace: "" }, applied: false, reason: "not_found" },
  ]);
  assert.match(lines[0], /applied/);
  assert.match(lines[1], /not found/);
});

test("applyEdits: SECURITY - non-string replace never writes 'undefined'", () => {
  // Untrusted tool-call args: model omits `replace`. Must NOT concatenate
  // the literal string "undefined" into the file.
  const r = applyEdits("keep FOO here", [{ find: "FOO" }]);
  assert.equal(r.changed, false);
  assert.equal(r.content, "keep FOO here");
  assert.equal(r.outcomes[0].applied, false);
  assert.equal(r.outcomes[0].reason, "invalid_replace");
  assert.ok(!r.content.includes("undefined"));
});

test("applyEdits: null replace rejected as invalid_replace", () => {
  const r = applyEdits("x FOO y", [{ find: "FOO", replace: null }]);
  assert.equal(r.changed, false);
  assert.equal(r.outcomes[0].reason, "invalid_replace");
});

test("applyEdits: non-array edits handled gracefully", () => {
  const r = applyEdits("unchanged", {});
  assert.equal(r.changed, false);
  assert.equal(r.content, "unchanged");
  assert.deepEqual(r.outcomes, []);
});

test("applyEdits: malformed op (missing find) is empty_find, not a crash", () => {
  const r = applyEdits("abc", [{ replace: "z" }, null, { find: "abc", replace: "X" }]);
  assert.equal(r.content, "X");
  assert.equal(r.outcomes[0].reason, "empty_find");
  assert.equal(r.outcomes[1].reason, "empty_find");
  assert.equal(r.outcomes[2].applied, true);
});

test("applyEdits: empty replace (valid) deletes the match", () => {
  const r = applyEdits("a REMOVE b", [{ find: "REMOVE ", replace: "" }]);
  assert.equal(r.content, "a b");
  assert.equal(r.changed, true);
  assert.equal(r.outcomes[0].applied, true);
});
