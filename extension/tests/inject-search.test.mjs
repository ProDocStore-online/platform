// Tests for the inject-search ESM port.
// Covers the surface previously tested by tests/test_inject_search.py.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'templates', 'search', 'scripts', 'inject-search.mjs');

const mod = await import(SCRIPT);
const {
  PAGEFIND_CSS,
  SEARCH_DIV,
  injectCss,
  injectSearchDiv,
  injectScripts,
  process: processPage,
} = mod;

// ── fixture builders ─────────────────────────────────────────────────

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Sample Project - ProDocStore</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>

<header class="topbar">
  <h1>
    <a href="index.html">Home</a>
  </h1>
  <nav class="topbar-links">
    <a href="about.html">About</a>
    <a href="guide.html">Guide</a>
  </nav>
</header>

<main class="content">
  <h1>Home</h1>
  <p>Intro.</p>
</main>

</body>
</html>
`;

const ABOUT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<title>About</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<header class="topbar">
  <nav class="topbar-links">
    <a href="about.html">About</a>
  </nav>
</header>
<main><h1>About</h1></main>
</body>
</html>
`;

const GUIDE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<title>Guide</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<main><h1>Guide</h1></main>
</body>
</html>
`;

const FOUR04_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<title>Not Found</title>
</head>
<body>
<main><h1>404</h1></main>
</body>
</html>
`;

const ORPHAN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<title>Orphan</title>
</head>
<body>
<main><h1>Orphan</h1></main>
</body>
</html>
`;

function makeSite() {
  const root = mkdtempSync(path.join(tmpdir(), 'inject-search-'));
  const docs = path.join(root, 'docs');
  mkdirSync(docs);
  writeFileSync(path.join(docs, 'index.html'), INDEX_HTML);
  writeFileSync(path.join(docs, 'about.html'), ABOUT_HTML);
  writeFileSync(path.join(docs, 'guide.html'), GUIDE_HTML);
  writeFileSync(path.join(docs, '404.html'), FOUR04_HTML);
  writeFileSync(path.join(docs, 'orphan.html'), ORPHAN_HTML);
  return { root, docs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runCli(args, repo) {
  return spawnSync('node', [SCRIPT, '--repo', repo, ...args], { encoding: 'utf8' });
}

// ── injectCss ────────────────────────────────────────────────────────

test('injectCss adds link before styles.css', () => {
  const html = '<html><head><link rel="stylesheet" href="styles.css"></head><body></body></html>';
  const out = injectCss(html);
  assert.ok(out.includes(PAGEFIND_CSS));
  assert.ok(out.indexOf('pagefind-ui.css') < out.indexOf('href="styles.css"'));
});

test('injectCss is idempotent', () => {
  const html = '<html><head><link rel="stylesheet" href="styles.css"></head><body></body></html>';
  const once = injectCss(html);
  const twice = injectCss(once);
  assert.equal(once, twice);
  assert.equal((twice.match(/pagefind-ui\.css/g) ?? []).length, 1);
});

test('injectCss handles root-absolute href (e.g. 404.html)', () => {
  // Regression: the playbook's docs/404.html uses href="/styles.css"
  // intentionally (it's served at any path on a 404). The previous
  // exact-string match silently skipped it - the page deployed with
  // the search bar markup but no pagefind CSS, leaving the dropdown
  // unstyled. Now any href ending in `styles.css` matches.
  const html = '<html><head><link rel="stylesheet" href="/styles.css"></head><body></body></html>';
  const out = injectCss(html);
  assert.ok(out.includes(PAGEFIND_CSS), 'pagefind CSS must be injected for root-absolute paths');
  assert.ok(
    out.indexOf('pagefind-ui.css') < out.indexOf('href="/styles.css"'),
    'pagefind CSS must come before the styles link',
  );
});

test('injectCss tolerates swapped attribute order (href first)', () => {
  // <link href="styles.css" rel="stylesheet"> (different attr order)
  // is valid HTML; previous exact match would skip it.
  const html = '<html><head><link href="styles.css" rel="stylesheet"></head><body></body></html>';
  const out = injectCss(html);
  assert.ok(out.includes(PAGEFIND_CSS));
});

test('injectCss is idempotent for root-absolute href too', () => {
  const html = '<html><head><link rel="stylesheet" href="/styles.css"></head><body></body></html>';
  const once = injectCss(html);
  const twice = injectCss(once);
  assert.equal(once, twice);
  assert.equal((twice.match(/pagefind-ui\.css/g) ?? []).length, 1);
});

test('injectCss without styles link is a no-op', () => {
  const html = '<html><head></head><body></body></html>';
  assert.equal(injectCss(html), html);
});

// ── injectSearchDiv ──────────────────────────────────────────────────

test('injectSearchDiv inserts after </nav> and before </header>', () => {
  const html =
    '<header class="topbar">' +
    '<nav class="topbar-links"><a href="x.html">X</a></nav>' +
    '</header>';
  const out = injectSearchDiv(html);
  assert.ok(out.includes(SEARCH_DIV));
  assert.ok(out.indexOf('</nav>') < out.indexOf('id="search"'));
  assert.ok(out.indexOf('id="search"') < out.indexOf('</header>'));
});

test('injectSearchDiv is idempotent', () => {
  const html =
    '<header class="topbar">' +
    '<nav class="topbar-links"><a href="x.html">X</a></nav>' +
    '</header>';
  const once = injectSearchDiv(html);
  const twice = injectSearchDiv(once);
  assert.equal(once, twice);
  assert.equal((twice.match(/id="search"/g) ?? []).length, 1);
});

test('injectSearchDiv falls back to just before </header>', () => {
  const html = '<header class="topbar"><h1>Title</h1></header>';
  const out = injectSearchDiv(html);
  assert.ok(out.includes(SEARCH_DIV));
  assert.ok(out.indexOf('id="search"') < out.indexOf('</header>'));
});

// ── injectScripts ────────────────────────────────────────────────────

test('injectScripts inserts before </body>', () => {
  const html = '<html><body><main>hi</main></body></html>';
  const out = injectScripts(html);
  assert.ok(out.includes('pagefind-ui.js'));
  assert.ok(out.includes('PagefindUI'));
  assert.ok(out.indexOf('pagefind-ui.js') < out.indexOf('</body>'));
  assert.ok(out.indexOf('PagefindUI') < out.indexOf('</body>'));
});

test('injectScripts is idempotent', () => {
  const html = '<html><body><main>hi</main></body></html>';
  const once = injectScripts(html);
  const twice = injectScripts(once);
  assert.equal(once, twice);
  assert.equal((twice.match(/pagefind-ui\.js/g) ?? []).length, 1);
});

// ── process() ────────────────────────────────────────────────────────

test('process() adds all three pieces on a topbar page', () => {
  const site = makeSite();
  try {
    const page = path.join(site.docs, 'index.html');
    const changed = processPage(page);
    assert.equal(changed, true);
    const html = readFileSync(page, 'utf8');
    assert.ok(html.includes('pagefind-ui.css'));
    assert.ok(html.includes(SEARCH_DIV));
    assert.ok(html.includes('pagefind-ui.js'));
    assert.ok(html.includes('PagefindUI'));
  } finally {
    site.cleanup();
  }
});

test('process() skips pages without a topbar', () => {
  const site = makeSite();
  try {
    for (const name of ['404.html', 'orphan.html', 'guide.html']) {
      const page = path.join(site.docs, name);
      const original = readFileSync(page, 'utf8');
      const changed = processPage(page);
      assert.equal(changed, false, `${name} should have been skipped`);
      assert.equal(readFileSync(page, 'utf8'), original, `${name} must not be modified`);
    }
  } finally {
    site.cleanup();
  }
});

test('process() is idempotent', () => {
  const site = makeSite();
  try {
    const page = path.join(site.docs, 'index.html');
    processPage(page);
    const afterFirst = readFileSync(page, 'utf8');
    processPage(page);
    const afterSecond = readFileSync(page, 'utf8');
    assert.equal(afterFirst, afterSecond);
    assert.equal((afterSecond.match(/pagefind-ui\.css/g) ?? []).length, 1);
    assert.equal((afterSecond.match(/id="search"/g) ?? []).length, 1);
    assert.equal((afterSecond.match(/pagefind-ui\.js/g) ?? []).length, 1);
  } finally {
    site.cleanup();
  }
});

// ── CLI ──────────────────────────────────────────────────────────────

test('CLI updates pages with topbar', () => {
  const site = makeSite();
  try {
    const r = runCli([], site.root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /inject-search:/);
    for (const name of ['index.html', 'about.html']) {
      const html = readFileSync(path.join(site.docs, name), 'utf8');
      assert.ok(html.includes('pagefind-ui.css'), `${name} missing pagefind CSS`);
      assert.ok(html.includes('id="search"'), `${name} missing search div`);
      assert.ok(html.includes('pagefind-ui.js'), `${name} missing pagefind JS`);
    }
    for (const name of ['404.html', 'orphan.html', 'guide.html']) {
      const html = readFileSync(path.join(site.docs, name), 'utf8');
      assert.ok(!html.includes('pagefind-ui.css'), `${name} should not have been changed`);
      assert.ok(!html.includes('id="search"'));
    }
  } finally {
    site.cleanup();
  }
});

test('CLI errors when docs/ is missing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'inject-search-nodocs-'));
  try {
    const r = runCli([], root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /docs\//);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI is idempotent', () => {
  const site = makeSite();
  try {
    const r1 = runCli([], site.root);
    assert.equal(r1.status, 0, r1.stderr);
    const r2 = runCli([], site.root);
    assert.equal(r2.status, 0, r2.stderr);
    for (const name of ['index.html', 'about.html']) {
      const html = readFileSync(path.join(site.docs, name), 'utf8');
      assert.equal((html.match(/pagefind-ui\.css/g) ?? []).length, 1);
      assert.equal((html.match(/id="search"/g) ?? []).length, 1);
      assert.equal((html.match(/pagefind-ui\.js/g) ?? []).length, 1);
    }
  } finally {
    site.cleanup();
  }
});

test('CLI --help prints usage and exits 0', () => {
  const r = spawnSync('node', [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: inject-search/);
});
