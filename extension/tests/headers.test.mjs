// Regression tests for the deploy-time HTTP headers + CSP. These are
// the headers Cloudflare Pages applies to every response on every
// ProDocStore-derived site.
//
// Why this file exists: a stale CSP missing 'wasm-unsafe-eval' shipped
// on the playbook for an unknown amount of time, silently blocking
// Pagefind's WASM and breaking search. The browser was honest about
// it (CSP error in console) but no automated test caught the drift -
// the deploy was green and the search step output looked normal. These
// tests are the guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const TEMPLATE_HEADERS = path.join(REPO_ROOT, "templates", "_headers");
const PLAYBOOK_HEADERS = path.join(REPO_ROOT, "docs", "_headers");

function readHeaders(filePath) {
  return readFileSync(filePath, "utf8");
}

function extractCspDirectives(headersText) {
  // _headers format: rule line "/*", then indented headers. Find the
  // CSP line and return its value as a directive map for assertions
  // that don't care about whitespace or directive order.
  const m = headersText.match(/Content-Security-Policy:\s*(.*)/);
  if (!m) return null;
  const map = new Map();
  for (const directive of m[1].split(";")) {
    const trimmed = directive.trim();
    if (!trimmed) continue;
    const [name, ...sources] = trimmed.split(/\s+/);
    map.set(name, new Set(sources));
  }
  return map;
}

// ── template _headers (canonical) ───────────────────────────────────

test("templates/_headers exists at the documented location", () => {
  assert.ok(existsSync(TEMPLATE_HEADERS),
    "templates/_headers is the canonical security header set; deploy copies it into every site");
});

test("templates/_headers carries the CSP directives Pagefind WASM requires", () => {
  // Real bug: the CSP shipped without 'wasm-unsafe-eval'. Pagefind's
  // worker tried to instantiate WebAssembly and the browser blocked it,
  // leaving search hung on "Searching for index...". This test would
  // have failed BEFORE the deploy if it had existed.
  const csp = extractCspDirectives(readHeaders(TEMPLATE_HEADERS));
  assert.ok(csp, "templates/_headers must contain a Content-Security-Policy header");

  const scriptSrc = csp.get("script-src") ?? new Set();
  assert.ok(scriptSrc.has("'self'"), "script-src must allow 'self'");
  // Pagefind needs WASM. Modern CSP uses 'wasm-unsafe-eval'; older
  // browsers need the broader 'unsafe-eval'. Either is acceptable.
  assert.ok(
    scriptSrc.has("'wasm-unsafe-eval'") || scriptSrc.has("'unsafe-eval'"),
    "script-src must allow Pagefind's WebAssembly via 'wasm-unsafe-eval' or 'unsafe-eval'",
  );

  // Pagefind spawns a Worker. Default-src 'self' covers same-origin
  // workers but pagefind 1.5 spins up a blob: worker for the WASM
  // wrapper too - worker-src must explicitly allow blob:.
  const workerSrc = csp.get("worker-src") ?? new Set();
  assert.ok(workerSrc.has("'self'"), "worker-src must allow 'self' for /pagefind/pagefind-worker.js");
  assert.ok(workerSrc.has("blob:"), "worker-src must allow blob: for the Pagefind WASM wrapper");
});

test("templates/_headers keeps the universal hardening headers", () => {
  // These are non-negotiable for any ProDocStore site. Catches the
  // case where someone trims the headers file thinking they're unused.
  const text = readHeaders(TEMPLATE_HEADERS);
  for (const required of [
    "X-Frame-Options: DENY",
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy:",
    "Permissions-Policy:",
  ]) {
    assert.ok(text.includes(required), `templates/_headers must contain "${required}"`);
  }
});

// ── playbook docs/_headers (own deploy) ─────────────────────────────

test("playbook's docs/_headers byte-matches the template (no drift)", () => {
  // Real bug: docs/_headers had drifted from templates/_headers, but
  // the playbook uses fetch-brand-assets:false so the deploy didn't
  // overwrite it. Both files now must stay in sync. The deploy
  // workflow always copies the template (separate from brand assets),
  // so this test guards against pre-deploy drift only - but that's
  // what the original bug was.
  if (!existsSync(PLAYBOOK_HEADERS)) {
    // Acceptable shape: caller repos may not have their own docs/_headers
    // (the deploy will copy templates/_headers in). Skip silently.
    return;
  }
  const template = readHeaders(TEMPLATE_HEADERS);
  const playbook = readHeaders(PLAYBOOK_HEADERS);
  assert.equal(playbook, template,
    "docs/_headers has drifted from templates/_headers - resync them or remove docs/_headers and let the deploy step copy it");
});
