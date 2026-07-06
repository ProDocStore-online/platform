// Unit tests for templates/search/scripts/inject-branding.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const SCRIPT = path.join(REPO_ROOT, "templates", "search", "scripts", "inject-branding.mjs");
const FIXTURES = path.join(REPO_ROOT, "tests", "fixtures");

const mod = await import(SCRIPT);
const {
  START,
  END,
  OPT_OUT,
  VAR_MAP,
  loadBranding,
  hasAnyBranding,
  renderStyleBlock,
  rewriteLogo,
  injectBranding,
  isSafeLogoUrl,
} = mod;

const headed = (bodyExtra = "") => `<!DOCTYPE html>
<html><head><title>x</title></head>
<body>
<header class="topbar">
  <h1>
    <a href="index.html"><img src="logo.svg" alt="ProDocStore" class="topbar-logo"></a>
    <span class="badge">Project</span>
  </h1>
</header>
<main><p>body</p>${bodyExtra}</main>
</body></html>`;

// ── hasAnyBranding ──────────────────────────────────────────────────

test("hasAnyBranding: empty / null / non-object -> false", () => {
  assert.equal(hasAnyBranding(null), false);
  assert.equal(hasAnyBranding(undefined), false);
  assert.equal(hasAnyBranding({}), false);
  assert.equal(hasAnyBranding("string"), false);
});

test("hasAnyBranding: any recognised key with a non-empty string -> true", () => {
  assert.equal(hasAnyBranding({ accent: "#ff0000" }), true);
  assert.equal(hasAnyBranding({ logo: "logo.svg" }), true);
  assert.equal(hasAnyBranding({ logoAlt: "Acme" }), true);
  assert.equal(hasAnyBranding({ lineColor: "#444" }), true);
});

test("hasAnyBranding: unknown keys do NOT count (typo-fail-loud)", () => {
  // Real risk: `accentt: "#ff0000"` (typo) shouldn't trigger an empty
  // <style> injection. Treat as no branding.
  assert.equal(hasAnyBranding({ accentt: "#ff0000" }), false);
  assert.equal(hasAnyBranding({ unknownThing: "x" }), false);
});

test("hasAnyBranding: empty-string values do NOT count", () => {
  // `accent: ""` is just clearing the override - shouldn't trigger
  // an empty :root rule injection.
  assert.equal(hasAnyBranding({ accent: "" }), false);
});

// ── renderStyleBlock ────────────────────────────────────────────────

test("renderStyleBlock: empty branding -> empty string", () => {
  assert.equal(renderStyleBlock({}), "");
  assert.equal(renderStyleBlock({ logo: "x.svg" }), "",
    "logo alone produces no <style> block");
});

test("renderStyleBlock: emits :root with the configured CSS vars", () => {
  const out = renderStyleBlock({
    accent: "#ff5722",
    lineColor: "#444",
    text: "#fff",
  });
  assert.match(out, new RegExp(`^${START.replace(/[-/]/g, "\\$&")}`));
  assert.match(out, new RegExp(`${END.replace(/[-/]/g, "\\$&")}$`));
  assert.match(out, /:root\s*\{/);
  assert.match(out, /--accent:\s*#ff5722;/);
  assert.match(out, /--border:\s*#444;/, "lineColor maps to --border");
  assert.match(out, /--text:\s*#fff;/);
});

test("renderStyleBlock: id pin so the cleanup hook can find it", () => {
  // The inline injection uses id="branding-vars" - tests pin this so
  // a future refactor can't silently drop the id and break a JS-side
  // cleanup (e.g. a follow-up theme toggle that wipes prior overrides).
  const out = renderStyleBlock({ accent: "#000" });
  assert.match(out, /<style id="branding-vars">/);
});

test("renderStyleBlock: strips angle/quote chars from values (defensive)", () => {
  // Branding values should be plain CSS colors, but a chat agent
  // mistake or untrusted input shouldn't be able to break out of the
  // <style> context. escapeCss removes <, >, ", ' from VALUES so
  // </style><script> can never escape the css block. The literal
  // values rendered must contain none of those characters.
  const out = renderStyleBlock({ accent: '#fff" /* x */</style><script>alert(1)</script>' });
  // Pull out just the rendered --accent declaration's value.
  const m = out.match(/--accent:\s*([^;]+);/);
  assert.ok(m, "must contain an --accent declaration");
  const value = m[1];
  assert.ok(!value.includes("<"), "value must not contain <");
  assert.ok(!value.includes(">"), "value must not contain >");
  assert.ok(!value.includes('"'), "value must not contain \"");
  assert.ok(!value.includes("'"), "value must not contain '");
  // No tag breakout in the overall output.
  assert.ok(!out.includes("<script"));
  assert.ok(!out.includes("</style><"), "no breakout</style> followed by another tag");
});

test("renderStyleBlock: only known keys produce CSS rules", () => {
  const out = renderStyleBlock({ accent: "#000", unknownKey: "#fff" });
  assert.match(out, /--accent/);
  assert.ok(!out.includes("unknownKey"));
});

test("renderStyleBlock: strips ; and } so a typo can't break out of the declaration (regression)", () => {
  // Real bug we just fixed: escapeCss only stripped <>"' which let a
  // value like "red; color: yellow" inject a second declaration into
  // :root, or "red } body { background: pink" close the rule entirely
  // and inject one for body. Both cascade SITEWIDE because they hit
  // every page's <head>.
  const semi = renderStyleBlock({ accent: "red; color: yellow" });
  // Semicolon stripped; only ONE declaration in the rule. The remaining
  // "color: yellow" text is degraded to part of --accent's value (which
  // CSS will reject as invalid) - never a second declaration.
  const decls = (semi.match(/^\s*--/gm) ?? []).length;
  assert.equal(decls, 1, "exactly one custom-property declaration in :root");
  assert.ok(!semi.includes(";\n  color"), "no injected color declaration");

  const brace = renderStyleBlock({ accent: "red } body { background: pink" });
  // The dangerous chars (} { ;) must not appear inside a VALUE - any
  // surviving brace would close :root and let the rest become a
  // foreign rule. Pull out the --accent value and verify it's clean.
  const m = brace.match(/--accent:\s*([^;\n]+);/);
  assert.ok(m, "must contain an --accent declaration");
  const value = m[1];
  for (const ch of ["{", "}", ";"]) {
    assert.ok(!value.includes(ch), `value must not contain ${ch}`);
  }
  // The rendered block has exactly the :root rule's braces, no foreign
  // rules.
  const ruleOpens = (brace.match(/\{/g) ?? []).length;
  const ruleCloses = (brace.match(/\}/g) ?? []).length;
  assert.equal(ruleOpens, 1, "exactly one open brace (the :root rule)");
  assert.equal(ruleCloses, 1, "exactly one close brace");
});

// ── rewriteLogo ─────────────────────────────────────────────────────

test("rewriteLogo: replaces topbar-logo src", () => {
  const html = headed();
  const r = rewriteLogo(html, { logo: "custom.svg" });
  assert.equal(r.changed, true);
  assert.match(r.html, /<img src="custom\.svg" alt="ProDocStore" class="topbar-logo">/);
});

test("rewriteLogo: replaces topbar-logo alt", () => {
  const html = headed();
  const r = rewriteLogo(html, { logoAlt: "Acme Co" });
  assert.equal(r.changed, true);
  assert.match(r.html, /alt="Acme Co"/);
});

test("rewriteLogo: replaces both src and alt in one pass", () => {
  const html = headed();
  const r = rewriteLogo(html, { logo: "https://acme.com/logo.png", logoAlt: "Acme" });
  assert.equal(r.changed, true);
  assert.match(r.html, /src="https:\/\/acme\.com\/logo\.png"/);
  assert.match(r.html, /alt="Acme"/);
});

test("rewriteLogo: leaves <img> tags WITHOUT topbar-logo class alone", () => {
  // Word-bounded class check - `my-topbar-logo-thing` and other
  // <img> tags must not be rewritten.
  const html = `<header>
<img src="other.png" alt="x" class="my-topbar-logo-thing">
<img src="logo.svg" alt="L" class="topbar-logo">
<img src="favicon.ico" alt="fav">
</header>`;
  const r = rewriteLogo(html, { logo: "new.svg" });
  assert.equal(r.changed, true);
  assert.match(r.html, /src="other\.png"/, "different-class img must stay");
  assert.match(r.html, /src="favicon\.ico"/, "no-class img must stay");
  assert.match(r.html, /src="new\.svg"[^>]*class="topbar-logo"/);
});

test("rewriteLogo: tolerates attribute order (class before src)", () => {
  const html = `<header><img class="topbar-logo" src="old.svg" alt="x"></header>`;
  const r = rewriteLogo(html, { logo: "new.svg" });
  assert.match(r.html, /src="new\.svg"/);
});

test("rewriteLogo: changed=false when neither logo nor logoAlt is set", () => {
  const html = headed();
  const r = rewriteLogo(html, { accent: "#000" });
  assert.equal(r.changed, false);
  assert.equal(r.html, html);
});

test("rewriteLogo: empty-string logo treated as 'not set' (avoids src='' breakage)", () => {
  const html = headed();
  const r = rewriteLogo(html, { logo: "" });
  assert.equal(r.changed, false, "empty string must not blank out the existing src");
});

test("rewriteLogo: escapes attribute values (XSS guard)", () => {
  const html = headed();
  const r = rewriteLogo(html, { logo: '"><script>alert(1)</script>x' });
  assert.ok(!r.html.includes("<script"));
  assert.match(r.html, /src="&quot;&gt;&lt;script&gt;/);
});

test("rewriteLogo: rejects unsafe URL schemes (regression)", () => {
  // Real bug we just fixed: `javascript:` and `data:` URLs were
  // accepted as-is. Browsers won't execute javascript: in <img src>,
  // but data: bypasses the site's CSP img-src and http: warns about
  // mixed content on https deploys. Only relative paths and https://
  // are allowed; everything else is silently dropped.
  const html = headed();
  for (const evil of [
    "javascript:alert(1)",
    "data:image/svg+xml,<svg onload=alert(1)/>",
    "vbscript:msgbox",
    "http://insecure.example/logo.png",
    "file:///etc/passwd",
  ]) {
    const r = rewriteLogo(html, { logo: evil });
    assert.ok(!r.html.includes(evil), `unsafe scheme ${evil} must not land in src`);
    // The original logo.svg must still be there (rewrite was rejected).
    assert.match(r.html, /src="logo\.svg"/, `original src must remain after rejecting ${evil}`);
  }
});

test("isSafeLogoUrl: accepts paths and https, rejects everything else", () => {
  // Pin the validator behaviour so future edits don't accidentally
  // open the door to data: or javascript: URLs.
  for (const safe of [
    "logo.svg",
    "/assets/logo.svg",
    "./logo.svg",
    "../shared/logo.svg",
    "https://acme.com/brand/logo.png",
    "https://cdn.example.com:8443/logo.svg",
  ]) {
    assert.equal(isSafeLogoUrl(safe), true, `${safe} should be allowed`);
  }
  for (const unsafe of [
    "javascript:alert(1)",
    "data:image/svg+xml,abc",
    "vbscript:foo",
    "http://insecure/logo.png",
    "file:///etc/passwd",
    "ftp://files.example/logo.png",
    "",
    "logo with space.svg",
    "logo\nname.svg",
  ]) {
    assert.equal(isSafeLogoUrl(unsafe), false, `${unsafe} should be rejected`);
  }
});

// ── injectBranding (full pipeline) ──────────────────────────────────

test("injectBranding: idempotent on rerun", () => {
  const html = headed();
  const branding = { accent: "#06f4b1", logo: "custom.svg" };
  const r1 = injectBranding(html, branding);
  const r2 = injectBranding(r1.html, branding);
  assert.equal(r2.changed, false, "second run must be a no-op");
  assert.equal(r1.html, r2.html);
});

test("injectBranding: rerun with different accent replaces (no stacking)", () => {
  const html = headed();
  const r1 = injectBranding(html, { accent: "#ff0000" });
  const r2 = injectBranding(r1.html, { accent: "#00ff00" });
  assert.equal(r2.changed, true);
  const starts = r2.html.match(new RegExp(START.replace(/[-/]/g, "\\$&"), "g")) ?? [];
  assert.equal(starts.length, 1, "exactly one branding marker after both runs");
  assert.match(r2.html, /--accent:\s*#00ff00/);
  assert.ok(!/--accent:\s*#ff0000/.test(r2.html), "old accent gone");
});

test("injectBranding: opt-out STRIPS a previously-injected style block", () => {
  const html = headed();
  const r1 = injectBranding(html, { accent: "#ff0000" });
  assert.ok(r1.html.includes(START));
  const v2 = r1.html.replace("<head>", `<head>\n${OPT_OUT}`);
  const r2 = injectBranding(v2, { accent: "#ff0000" });
  assert.equal(r2.changed, true);
  assert.ok(!r2.html.includes(START));
});

test("injectBranding: skips pages with no </head>", () => {
  const html = `<html><body><main>x</main></body></html>`;
  const r = injectBranding(html, { accent: "#000" });
  // No style block injected, but no error either.
  assert.ok(!r.html.includes(START));
});

test("injectBranding: logo-only branding mutates pages but doesn't add a style block", () => {
  const html = headed();
  const r = injectBranding(html, { logo: "custom.svg" });
  assert.equal(r.changed, true);
  assert.match(r.html, /src="custom\.svg"/);
  assert.ok(!r.html.includes(START), "no style block for logo-only branding");
});

test("injectBranding: removes stale style block when colors are dropped", () => {
  // Realistic flow: agent set accent then user reverted; branding now
  // has only logo. The previously-injected style block must be removed.
  const html = headed();
  const r1 = injectBranding(html, { accent: "#ff0000", logo: "custom.svg" });
  assert.ok(r1.html.includes(START));
  const r2 = injectBranding(r1.html, { logo: "custom.svg" }); // accent dropped
  assert.equal(r2.changed, true);
  assert.ok(!r2.html.includes(START), "style block must be removed when no colors are set");
});

// ── loadBranding (file IO) ──────────────────────────────────────────

test("loadBranding: missing features.json -> {}", () => {
  const root = mkdtempSync(path.join(tmpdir(), "br-no-feat-"));
  try {
    const docs = path.join(root, "docs");
    cpSync(path.join(FIXTURES, "sample_site", "docs"), docs, { recursive: true });
    rmSync(path.join(docs, "features.json"), { force: true });
    assert.deepEqual(loadBranding(docs), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadBranding: features.json without branding key -> {}", () => {
  const root = mkdtempSync(path.join(tmpdir(), "br-no-block-"));
  try {
    const docs = path.join(root, "docs");
    cpSync(path.join(FIXTURES, "sample_site", "docs"), docs, { recursive: true });
    writeFileSync(path.join(docs, "features.json"), JSON.stringify({ search: true }));
    assert.deepEqual(loadBranding(docs), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadBranding: returns the branding object verbatim", () => {
  const root = mkdtempSync(path.join(tmpdir(), "br-yes-"));
  try {
    const docs = path.join(root, "docs");
    cpSync(path.join(FIXTURES, "sample_site", "docs"), docs, { recursive: true });
    const branding = { accent: "#ff5722", logo: "acme.svg" };
    writeFileSync(path.join(docs, "features.json"),
      JSON.stringify({ branding }));
    assert.deepEqual(loadBranding(docs), branding);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadBranding: malformed features.json -> {} (no crash)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "br-bad-"));
  try {
    const docs = path.join(root, "docs");
    cpSync(path.join(FIXTURES, "sample_site", "docs"), docs, { recursive: true });
    writeFileSync(path.join(docs, "features.json"), "{not valid json");
    assert.deepEqual(loadBranding(docs), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── VAR_MAP exposed for system-prompt + UI uses ─────────────────────

test("VAR_MAP exposes branding-key -> CSS-var-name pairs", () => {
  // Future code (e.g. the chat agent's natural-language branding form
  // in the side panel) may want to enumerate the supported keys.
  assert.equal(VAR_MAP.accent, "--accent");
  assert.equal(VAR_MAP.lineColor, "--border");
  assert.equal(VAR_MAP.text, "--text");
  assert.equal(VAR_MAP.bg, "--bg");
  assert.equal(VAR_MAP.textMuted, "--text-muted");
});

// ── CLI smoke ───────────────────────────────────────────────────────

test("CLI: with branding configured, mutates docs and exits 0", () => {
  const root = mkdtempSync(path.join(tmpdir(), "br-cli-"));
  try {
    const docs = path.join(root, "docs");
    cpSync(path.join(FIXTURES, "sample_site", "docs"), docs, { recursive: true });
    writeFileSync(
      path.join(docs, "features.json"),
      JSON.stringify({ branding: { accent: "#ff5722", logo: "acme.svg" } }),
    );
    // sample_site doesn't have topbar-logo by default; add one.
    const target = path.join(docs, "about.html");
    const before = readFileSync(target, "utf8")
      .replace(/<head>/, `<head>`)
      .replace(/<body>/, `<body>\n<header><img src="old.svg" alt="x" class="topbar-logo"></header>`);
    writeFileSync(target, before);

    const r = spawnSync("node", [SCRIPT, "--repo", root], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const after = readFileSync(target, "utf8");
    assert.match(after, /<style id="branding-vars">/);
    assert.match(after, /src="acme\.svg"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: no branding config -> graceful no-op (not a deploy failure)", () => {
  // Sites that haven't configured branding shouldn't fail just because
  // the workflow runs the step unconditionally.
  const root = mkdtempSync(path.join(tmpdir(), "br-no-cli-"));
  try {
    const docs = path.join(root, "docs");
    cpSync(path.join(FIXTURES, "sample_site", "docs"), docs, { recursive: true });
    rmSync(path.join(docs, "features.json"), { force: true });
    const r = spawnSync("node", [SCRIPT, "--repo", root], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No branding configured/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
