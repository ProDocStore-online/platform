// URL -> source file resolver tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const {
  resolveContext,
  pathnameToSource,
  sourceToPublishedPath,
  parseNavConfig,
  extractRepoFromMeta,
  extractSourcePathFromMeta,
} = await import(await bundle("src/resolver.ts"));

// ── source path -> published page pathname (edit-card "open page" link) ──

test("sourceToPublishedPath maps MkDocs markdown to directory URLs", () => {
  assert.equal(sourceToPublishedPath("docs/about.md"), "/about/");
  assert.equal(sourceToPublishedPath("docs/credits.md"), "/credits/");
  assert.equal(sourceToPublishedPath("docs/guide/intro.md"), "/guide/intro/");
  assert.equal(sourceToPublishedPath("docs/notes.mdx"), "/notes/");
});

test("sourceToPublishedPath collapses index pages to the directory root", () => {
  assert.equal(sourceToPublishedPath("docs/index.md"), "/");
  assert.equal(sourceToPublishedPath("docs/guide/index.md"), "/guide/");
  assert.equal(sourceToPublishedPath("docs/index.html"), "/");
});

test("sourceToPublishedPath keeps the real filename for HTML sources", () => {
  assert.equal(sourceToPublishedPath("docs/about.html"), "/about.html");
  assert.equal(sourceToPublishedPath("docs/guide/intro.html"), "/guide/intro.html");
});

test("resolveContext decodes percent-encoded clean URLs (no double-encoding)", () => {
  // Non-ASCII: /guía comes through as /gu%C3%ADa; the source must be the decoded
  // docs/guía.html, not docs/gu%C3%ADa.html (which the GitHub client would then
  // re-encode to %25C3%25AD and 404).
  assert.equal(
    resolveContext("https://x.pages.dev/gu%C3%ADa", "", "", "").sourcePath,
    "docs/guía.html",
  );
  // Space: /my%20page -> docs/my page.html.
  assert.equal(
    resolveContext("https://x.pages.dev/my%20page", "", "", "").sourcePath,
    "docs/my page.html",
  );
});

test("sourceToPublishedPath returns null for non-docs paths", () => {
  assert.equal(sourceToPublishedPath("mkdocs.yml"), null);
  assert.equal(sourceToPublishedPath("README.md"), null);
  assert.equal(sourceToPublishedPath("docs/assets/logo.png"), null);
});

// ── source-path meta (generated sites: Zensical/MkDocs build md -> html) ─

test("extractSourcePathFromMeta reads the source-path meta tag", () => {
  const html = `<meta name="source-path" content="docs/architecture.md">`;
  assert.equal(extractSourcePathFromMeta(html), "docs/architecture.md");
});

test("extractSourcePathFromMeta tolerates content-first + single quotes", () => {
  const html = `<meta content='docs/reference/glossary.md' name='source-path'>`;
  assert.equal(extractSourcePathFromMeta(html), "docs/reference/glossary.md");
});

test("extractSourcePathFromMeta rejects traversal and absolute paths", () => {
  assert.equal(extractSourcePathFromMeta(`<meta name="source-path" content="../secrets.md">`), null);
  assert.equal(extractSourcePathFromMeta(`<meta name="source-path" content="/etc/passwd">`), null);
  assert.equal(extractSourcePathFromMeta("<html></html>"), null);
});

test("extractSourcePathFromMeta enforces docs/ scope + source extension (security)", () => {
  // A spoofed page must not be able to point the editor at CI/config files.
  assert.equal(extractSourcePathFromMeta(`<meta name="source-path" content=".github/workflows/deploy.yml">`), null);
  assert.equal(extractSourcePathFromMeta(`<meta name="source-path" content="package.json">`), null);
  assert.equal(extractSourcePathFromMeta(`<meta name="source-path" content="docs/config.yml">`), null); // wrong ext
  assert.equal(extractSourcePathFromMeta(`<meta name="source-path" content="docs/architecture.md">`), "docs/architecture.md");
});

test("extractRepoFromMeta rejects traversal-ish owner/name (security)", () => {
  assert.equal(extractRepoFromMeta(`<meta name="source-repo" content="../orgs">`), null);
  assert.equal(extractRepoFromMeta(`<meta name="source-repo" content="owner/..">`), null);
  assert.equal(extractRepoFromMeta(`<meta name="source-repo" content=".../evil">`), null);
  // A normal owner/name still resolves.
  assert.deepEqual(extractRepoFromMeta(`<meta name="source-repo" content="acme-corp/docs">`), { owner: "acme-corp", name: "docs" });
});

test("resolveContext prefers source-path meta over the .html URL guess", () => {
  // URL would heuristically map to docs/architecture.html, but the build
  // told us the real source is the markdown file.
  const html = `<meta name="source-path" content="docs/architecture.md">`;
  const ctx = resolveContext("https://site.pages.dev/architecture/", html, "text", "Architecture");
  assert.equal(ctx.sourcePath, "docs/architecture.md");
});

test("resolveContext falls back to the URL guess without the meta", () => {
  const ctx = resolveContext("https://site.pages.dev/architecture/", "<html></html>", "t", "A");
  assert.equal(ctx.sourcePath, "docs/architecture/index.html");
});

// ── meta-tag protocol ────────────────────────────────────────────────

test("extractRepoFromMeta reads the docs-repo meta tag", () => {
  const html = `<html><head><meta name="docs-repo" content="acme-corp/example-docs"></head></html>`;
  assert.deepEqual(extractRepoFromMeta(html), { owner: "acme-corp", name: "example-docs" });
});

test("extractRepoFromMeta tolerates content-first attribute order", () => {
  const html = `<meta content="acme/docs" name="docs-repo">`;
  assert.deepEqual(extractRepoFromMeta(html), { owner: "acme", name: "docs" });
});

test("extractRepoFromMeta accepts single-quoted attributes", () => {
  const html = `<meta name='docs-repo' content='acme/docs'>`;
  assert.deepEqual(extractRepoFromMeta(html), { owner: "acme", name: "docs" });
});

test("extractRepoFromMeta reads the generic source-repo meta tag", () => {
  const html = `<html><head><meta name="source-repo" content="FreeDocStore/freedocstore-test"></head></html>`;
  assert.deepEqual(extractRepoFromMeta(html), {
    owner: "FreeDocStore",
    name: "freedocstore-test",
  });
});

test("extractRepoFromMeta reads source-repo with content-first order + single quotes", () => {
  const html = `<meta content='acme/site' name='source-repo'>`;
  assert.deepEqual(extractRepoFromMeta(html), { owner: "acme", name: "site" });
});

test("extractRepoFromMeta returns null when the tag is absent", () => {
  assert.equal(extractRepoFromMeta("<html></html>"), null);
});

test("extractRepoFromMeta ignores unrelated meta tags", () => {
  const html = `<meta name="description" content="acme/docs"><meta name="author" content="someone">`;
  assert.equal(extractRepoFromMeta(html), null);
});

test("extractRepoFromMeta returns null when content is malformed (no slash)", () => {
  const html = `<meta name="docs-repo" content="not-a-valid-spec">`;
  assert.equal(extractRepoFromMeta(html), null);
});

// ── resolveContext ───────────────────────────────────────────────────

test("resolveContext: meta tag populates repo on any host", () => {
  const html = `<html><head><meta name="docs-repo" content="acme/example-docs"></head></html>`;
  const ctx = resolveContext("https://docs.example.com/getting-started", html, "", "");
  assert.deepEqual(ctx.repo, { owner: "acme", name: "example-docs" });
  assert.equal(ctx.sourcePath, "docs/getting-started.html");
});

test("resolveContext: no meta tag returns repo: null", () => {
  const ctx = resolveContext("https://docs.example.com/page.html", "<html></html>", "", "");
  assert.equal(ctx.repo, null);
});

test("resolveContext: malformed meta tag returns repo: null", () => {
  const html = `<meta name="docs-repo" content="not-a-valid-spec">`;
  const ctx = resolveContext("https://docs.example.com/page.html", html, "", "");
  assert.equal(ctx.repo, null);
});

test("resolveContext treats / as docs/index.html", () => {
  const ctx = resolveContext(
    "https://docs.example.com/",
    `<meta name="docs-repo" content="acme/docs">`,
    "",
    ""
  );
  assert.equal(ctx.sourcePath, "docs/index.html");
});

test("resolveContext strips query strings and fragments from the source path", () => {
  const ctx = resolveContext(
    "https://docs.example.com/architecture.html?ref=nav#timeline",
    `<meta name="docs-repo" content="acme/docs">`,
    "",
    ""
  );
  assert.equal(ctx.sourcePath, "docs/architecture.html");
  // Original URL preserved in the context for the adapter to reference.
  assert.ok(ctx.url.includes("#timeline"));
});

test("resolveContext: clean URL on a meta-tagged site", () => {
  const ctx = resolveContext(
    "https://docs.example.com/skills",
    `<meta name="docs-repo" content="acme/example-docs">`,
    "",
    ""
  );
  assert.deepEqual(ctx.repo, { owner: "acme", name: "example-docs" });
  assert.equal(ctx.sourcePath, "docs/skills.html");
});

test("resolveContext defaults navConfig to null when absent", () => {
  const ctx = resolveContext("https://docs.example.com/", "", "", "");
  assert.equal(ctx.navConfig, null);
});

test("resolveContext passes navConfig through when provided", () => {
  const nav = parseNavConfig(
    JSON.stringify({ items: [{ href: "a.html", label: "A" }] })
  );
  const ctx = resolveContext(
    "https://docs.example.com/",
    "",
    "",
    "",
    nav
  );
  assert.ok(ctx.navConfig);
  assert.equal(ctx.navConfig.items.length, 1);
});

// ── pathnameToSource ─────────────────────────────────────────────────

test("pathnameToSource: Pages clean URL (no extension) adds .html", () => {
  // Pages serves /architecture as architecture.html.
  assert.equal(pathnameToSource("/architecture"), "docs/architecture.html");
  assert.equal(pathnameToSource("architecture"), "docs/architecture.html");
});

test("pathnameToSource: trailing slash -> index.html of that directory", () => {
  assert.equal(pathnameToSource("/clients/acme/"), "docs/clients/acme/index.html");
});

test("pathnameToSource: nested path with extension stays verbatim", () => {
  assert.equal(pathnameToSource("/clients/acme/sow-v1.html"), "docs/clients/acme/sow-v1.html");
  assert.equal(pathnameToSource("/page.htm"), "docs/page.htm");
});

test("pathnameToSource: dotted clean URL is not mistaken for a file extension", () => {
  // /release-1.0 is a clean URL for release-1.0.html, NOT a file with ext ".0".
  assert.equal(pathnameToSource("/release-1.0"), "docs/release-1.0.html");
  assert.equal(pathnameToSource("/api/v2.0"), "docs/api/v2.0.html");
});

test("pathnameToSource: a stray trailing dot never yields '..' in the path", () => {
  assert.equal(pathnameToSource("/foo."), "docs/foo.html");
  assert.ok(!pathnameToSource("/foo.").includes(".."));
});

test("pathnameToSource: root path resolves to docs/index.html", () => {
  assert.equal(pathnameToSource("/"), "docs/index.html");
  assert.equal(pathnameToSource(""), "docs/index.html");
});

// ── parseNavConfig ───────────────────────────────────────────────────

test("parseNavConfig accepts a flat nav and preserves raw", () => {
  const raw = JSON.stringify({
    items: [
      { href: "a.html", label: "A" },
      { href: "b.html", label: "B" },
    ],
  });
  const cfg = parseNavConfig(raw);
  assert.ok(cfg);
  assert.equal(cfg.items.length, 2);
  assert.equal(cfg.raw, raw);
});

test("parseNavConfig accepts a dropdown with children", () => {
  const cfg = parseNavConfig(
    JSON.stringify({
      items: [
        { href: "a.html", label: "A" },
        {
          label: "Reference",
          children: [
            { href: "i.html", label: "Issues" },
            { href: "d.html", label: "Dashboard" },
          ],
        },
      ],
    })
  );
  assert.ok(cfg);
  assert.equal(cfg.items.length, 2);
  assert.equal(cfg.items[1].children?.length, 2);
});

test("parseNavConfig extracts navSkip when present", () => {
  const cfg = parseNavConfig(
    JSON.stringify({
      items: [{ href: "a.html", label: "A" }],
      navSkip: ["404.html", "index.html"],
    })
  );
  assert.deepEqual(cfg?.navSkip, ["404.html", "index.html"]);
});

test("parseNavConfig returns null for malformed JSON", () => {
  assert.equal(parseNavConfig("{ not json"), null);
});

test("parseNavConfig returns null when items is missing or wrong type", () => {
  assert.equal(parseNavConfig("{}"), null);
  assert.equal(parseNavConfig(JSON.stringify({ items: "nope" })), null);
  assert.equal(parseNavConfig(JSON.stringify({ items: null })), null);
});

test("parseNavConfig rejects items that have neither href nor children", () => {
  // A bare `{label: "X"}` entry is meaningless - neither a link nor a group.
  const cfg = parseNavConfig(
    JSON.stringify({ items: [{ label: "Dangling" }] })
  );
  assert.equal(cfg, null);
});

test("parseNavConfig rejects items missing label", () => {
  const cfg = parseNavConfig(
    JSON.stringify({ items: [{ href: "a.html" }] })
  );
  assert.equal(cfg, null);
});
