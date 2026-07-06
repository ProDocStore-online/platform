// Unit tests for templates/search/scripts/inject-docs-repo-meta.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SCRIPT = path.join(
  REPO_ROOT,
  "templates",
  "search",
  "scripts",
  "inject-docs-repo-meta.mjs",
);

const mod = await import(SCRIPT);
const { START, END, isValidDocsRepo, renderMeta, injectDocsRepoMeta } = mod;

const headed = (extraHead = "") => `<!DOCTYPE html>
<html><head>
  <title>x</title>
  ${extraHead}
</head>
<body><p>body</p></body></html>`;

// ── isValidDocsRepo ──────────────────────────────────────────────────

test("isValidDocsRepo accepts standard owner/name", () => {
  assert.equal(isValidDocsRepo("acme/docs"), true);
  assert.equal(isValidDocsRepo("ProDocStore/prodocstore"), true);
});

test("isValidDocsRepo accepts dotted, hyphenated, underscored names", () => {
  assert.equal(isValidDocsRepo("a.b/c-d_e"), true);
});

test("isValidDocsRepo rejects missing slash", () => {
  assert.equal(isValidDocsRepo("acme"), false);
  assert.equal(isValidDocsRepo("acme-docs"), false);
});

test("isValidDocsRepo rejects multiple slashes", () => {
  assert.equal(isValidDocsRepo("acme/docs/extra"), false);
});

test("isValidDocsRepo rejects empty / non-string / characters outside [\\w.-]", () => {
  assert.equal(isValidDocsRepo(""), false);
  assert.equal(isValidDocsRepo(null), false);
  assert.equal(isValidDocsRepo(undefined), false);
  assert.equal(isValidDocsRepo("acme/docs space"), false);
  assert.equal(isValidDocsRepo("acme/docs!"), false);
});

// ── renderMeta ───────────────────────────────────────────────────────

test("renderMeta emits the markered meta tag with escaped content", () => {
  const out = renderMeta("acme/docs");
  assert.ok(out.startsWith(START));
  assert.ok(out.endsWith(END));
  assert.match(out, /<meta name="docs-repo" content="acme\/docs">/);
});

test("renderMeta escapes attribute-unsafe characters", () => {
  // Not a real-world repo name, but we want the escaping to work in
  // case someone passes weird input.
  const out = renderMeta('a"b/c');
  assert.match(out, /content="a&quot;b\/c"/);
});

// ── injectDocsRepoMeta ───────────────────────────────────────────────

test("injectDocsRepoMeta inserts the meta tag before </head>", () => {
  const before = headed();
  const { changed, html } = injectDocsRepoMeta(before, "acme/docs");
  assert.equal(changed, true);
  // The injection lands inside <head>, before </head>.
  const headPattern = /<head>[\s\S]*<meta name="docs-repo" content="acme\/docs">[\s\S]*<\/head>/;
  assert.match(html, headPattern);
});

test("injectDocsRepoMeta is idempotent on rerun (same repo)", () => {
  const before = headed();
  const first = injectDocsRepoMeta(before, "acme/docs").html;
  const second = injectDocsRepoMeta(first, "acme/docs");
  assert.equal(second.changed, false);
  assert.equal(second.html, first);
});

test("injectDocsRepoMeta updates the tag when docs-repo changes", () => {
  const before = headed();
  const first = injectDocsRepoMeta(before, "acme/docs").html;
  const second = injectDocsRepoMeta(first, "acme/different-docs");
  assert.equal(second.changed, true);
  assert.match(second.html, /content="acme\/different-docs"/);
  // Old value gone.
  assert.ok(!second.html.includes('content="acme/docs"'));
});

test("injectDocsRepoMeta returns unchanged when no </head> in document", () => {
  const noHead = `<html><body><p>just body</p></body></html>`;
  const { changed, html } = injectDocsRepoMeta(noHead, "acme/docs");
  assert.equal(changed, false);
  assert.equal(html, noHead);
});
