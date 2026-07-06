// Tests for inject-page-meta.mjs - mirrors the surface previously
// covered by tests/test_inject_page_meta.py.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SCRIPTS_DIR, initGitRepo, gitCommit } from './_helpers.mjs';

const SCRIPT = path.join(SCRIPTS_DIR, 'inject-page-meta.mjs');

const mod = await import(SCRIPT);
const {
  START,
  END,
  detectGithubRepo,
  formatAest,
  lastUpdated,
  renderMeta,
  inject,
} = mod;

// ── site fixture ─────────────────────────────────────────────────────

const SAMPLE_PAGE = (title) => `<!DOCTYPE html>
<html><head><title>${title}</title></head>
<body>
<header class="topbar"><nav class="topbar-links"></nav></header>
<main><h1>${title}</h1><p>Body.</p></main>
<footer><p>site</p></footer>
</body></html>`;

function makeSite() {
  const root = mkdtempSync(path.join(tmpdir(), 'inject-page-meta-'));
  const docs = path.join(root, 'docs');
  mkdirSync(docs);
  writeFileSync(path.join(docs, 'index.html'), SAMPLE_PAGE('Home'));
  writeFileSync(path.join(docs, 'about.html'), SAMPLE_PAGE('About'));
  writeFileSync(path.join(docs, 'guide.html'), SAMPLE_PAGE('Guide'));
  return {
    root,
    docs,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runCli(args, repo) {
  return spawnSync('node', [SCRIPT, '--repo', repo, ...args], {
    encoding: 'utf8',
  });
}

// ── detectGithubRepo (pure parsing via a fake repo with a real remote) ───

test('detectGithubRepo parses common remote URL formats', () => {
  const cases = [
    ['git@github.com:Owner/Repo.git', 'Owner/Repo'],
    ['git@github.com:Owner/Repo', 'Owner/Repo'],
    ['https://github.com/Owner/Repo.git', 'Owner/Repo'],
    ['https://github.com/Owner/Repo', 'Owner/Repo'],
    ['https://github.com/ProDocStore-online/prodocstore.git', 'ProDocStore-online/prodocstore'],
    ['ssh://git@github.com/Owner/Repo.git', 'Owner/Repo'],
  ];
  for (const [url, expected] of cases) {
    const root = mkdtempSync(path.join(tmpdir(), 'detect-'));
    try {
      initGitRepo(root, url);
      assert.equal(detectGithubRepo(root), expected, `url=${url}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('detectGithubRepo returns null when there is no origin remote', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'detect-noremote-'));
  try {
    initGitRepo(root); // no remote
    assert.equal(detectGithubRepo(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('detectGithubRepo returns null for non-github hosts', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'detect-gitlab-'));
  try {
    initGitRepo(root, 'git@gitlab.com:Owner/Repo.git');
    assert.equal(detectGithubRepo(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── formatAest: timestamp parsing, including the Z-suffix regression ─────

test('formatAest formats UTC input in AEST (UTC+11)', () => {
  // Midnight UTC on 1 Jan shifts to 11:00 AEST on the same date.
  assert.equal(formatAest('2024-01-01T00:00:00+00:00'), '01 Jan 2024');
});

test('formatAest handles a Z suffix (regression: Python < 3.11 bug class)', () => {
  // The Python source-of-truth had a real bug here - fromisoformat()
  // on older Pythons rejected the trailing 'Z'. The Node port must not
  // regress: a Z-suffixed ISO timestamp must format to the same AEST
  // stamp as the explicit-offset form.
  assert.equal(formatAest('2024-01-01T00:00:00Z'), '01 Jan 2024');
  // And a later time of day still falls on the expected AEST date.
  assert.equal(formatAest('2024-06-15T12:34:56Z'), '15 Jun 2024');
});

test('formatAest rolls into next day when AEST shift crosses midnight', () => {
  // 14:00 UTC + 11 = 01:00 next-day AEST.
  assert.equal(formatAest('2024-01-01T14:00:00Z'), '02 Jan 2024');
});

test('formatAest falls back to YYYY-MM-DD prefix on unparseable input', () => {
  assert.equal(formatAest('not-a-date-at-all'), 'not-a-date');
  // A YYYY-MM-DD-prefixed-but-broken-tail value still yields the prefix.
  assert.equal(formatAest('2024-01-01 garbage'), '2024-01-01');
});

test('formatAest returns null for empty input', () => {
  assert.equal(formatAest(''), null);
  assert.equal(formatAest(null), null);
});

// ── renderMeta ───────────────────────────────────────────────────────

test('renderMeta includes updated span and edit link', () => {
  const out = renderMeta('Owner/Repo', 'docs/index.html', '01 Jan 2024');
  assert.ok(out.includes(START));
  assert.ok(out.includes(END));
  assert.match(out, /Updated 01 Jan 2024/);
  assert.match(
    out,
    /https:\/\/github\.com\/Owner\/Repo\/edit\/main\/docs\/index\.html/,
  );
  assert.match(out, /Edit on GitHub/);
});

test('renderMeta omits edit link when github repo is unknown', () => {
  const out = renderMeta(null, 'docs/index.html', '01 Jan 2024');
  assert.match(out, /Updated 01 Jan 2024/);
  assert.ok(!out.includes('github.com'));
});

test('renderMeta omits the updated span when date is null', () => {
  const out = renderMeta('Owner/Repo', 'docs/x.html', null);
  assert.ok(!out.includes('Updated'));
  assert.match(out, /Edit on GitHub/);
});

test('renderMeta URL-encodes path segments (spaces, &, ?, #)', () => {
  // Regression: relPath went into the href raw, so a docs filename with
  // a space would produce "https://github.com/.../docs/foo bar.html",
  // which GitHub treats as a 404. ? and # are even worse - they reroute
  // the path into a query string / fragment.
  const out = renderMeta('Owner/Repo', 'docs/foo bar.html', null);
  assert.ok(out.includes('docs/foo%20bar.html'),
    `expected encoded path, got: ${out}`);
  assert.ok(!out.includes('docs/foo bar.html'),
    'raw path with space must not appear in href');

  const tricky = renderMeta('Owner/Repo', 'docs/page?q&a#x.html', null);
  assert.ok(tricky.includes('docs/page%3Fq%26a%23x.html'),
    `expected ?, &, # to be encoded, got: ${tricky}`);
});

test('renderMeta preserves slashes between path segments after encoding', () => {
  const out = renderMeta('Owner/Repo', 'docs/sub/inner.html', null);
  // edit URL must still have literal slashes between docs / sub / inner
  assert.match(out, /\/edit\/main\/docs\/sub\/inner\.html/);
});

test('renderMeta HTML-escapes the updated text', () => {
  // Defensive: if formatAest ever returned weird output (or if we surface
  // a future "Updated by Foo & Co" string), `&` must not break the HTML.
  const out = renderMeta(null, 'docs/x.html', 'Tom & Jerry');
  assert.ok(out.includes('Updated Tom &amp; Jerry'));
  assert.ok(!out.includes('Updated Tom & Jerry'));
});

// ── inject ───────────────────────────────────────────────────────────

test('inject places meta inside an existing footer, preserving content', () => {
  const html =
    '<html><body><main>hi</main>' +
    '<footer><p>site</p></footer></body></html>';
  const meta = renderMeta('Owner/Repo', 'docs/x.html', '01 Jan 2024');
  const out = inject(html, meta);
  assert.match(out, /<footer>/);
  assert.ok(out.includes(START));
  assert.ok(out.includes(END));
  assert.match(out, /<p>site<\/p>/);
});

test('inject creates a footer when one is missing', () => {
  const html = '<html><body><main>hi</main></body></html>';
  const meta = renderMeta('Owner/Repo', 'docs/x.html', '01 Jan 2024');
  const out = inject(html, meta);
  assert.match(out, /<footer>/);
  assert.ok(out.includes(START));
});

test('inject is idempotent: rerun replaces the marker block', () => {
  const html =
    '<html><body><main>hi</main>' +
    '<footer><p>orig</p></footer></body></html>';
  const metaA = renderMeta('Owner/Repo', 'docs/x.html', '01 Jan 2024');
  const once = inject(html, metaA);
  const metaB = renderMeta('Owner/Repo', 'docs/x.html', '02 Feb 2024');
  const twice = inject(once, metaB);

  const countStart = (s) => (s.match(new RegExp(escapeRe(START), 'g')) || []).length;
  const countEnd = (s) => (s.match(new RegExp(escapeRe(END), 'g')) || []).length;
  assert.equal(countStart(twice), 1);
  assert.equal(countEnd(twice), 1);
  assert.ok(!twice.includes('01 Jan 2024'));
  assert.match(twice, /02 Feb 2024/);
});

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── lastUpdated: drives git through spawnSync ────────────────────────

test('lastUpdated returns a formatted stamp for a tracked file', () => {
  const site = makeSite();
  try {
    initGitRepo(site.root, 'git@github.com:Example/Project.git');
    gitCommit(
      site.root,
      'initial',
      null,
      '2024-01-01T00:00:00+00:00',
    );
    const stamp = lastUpdated(
      site.root,
      path.join(site.docs, 'index.html'),
    );
    assert.equal(stamp, '01 Jan 2024');
  } finally {
    site.cleanup();
  }
});

test('lastUpdated returns null for an untracked file', () => {
  const site = makeSite();
  try {
    initGitRepo(site.root, 'git@github.com:Example/Project.git');
    gitCommit(site.root, 'initial');
    const untracked = path.join(site.docs, 'untracked.html');
    writeFileSync(untracked, '<html></html>');
    assert.equal(lastUpdated(site.root, untracked), null);
  } finally {
    site.cleanup();
  }
});

// ── CLI end-to-end ───────────────────────────────────────────────────

test('CLI injects meta into every docs/*.html on a git fixture', () => {
  const site = makeSite();
  try {
    initGitRepo(site.root, 'git@github.com:Example/Project.git');
    gitCommit(site.root, 'initial');
    const r = runCli([], site.root);
    assert.equal(r.status, 0, r.stderr);
    for (const name of readdirSync(site.docs).filter((f) => f.endsWith('.html'))) {
      const text = readFileSync(path.join(site.docs, name), 'utf8');
      assert.ok(text.includes('<!-- @page-meta -->'), `${name} missing marker`);
      assert.match(text, /github\.com\/Example\/Project/);
    }
  } finally {
    site.cleanup();
  }
});

test('CLI is idempotent across runs on the same tree', () => {
  const site = makeSite();
  try {
    initGitRepo(site.root, 'git@github.com:Example/Project.git');
    gitCommit(site.root, 'initial');
    runCli([], site.root);
    runCli([], site.root);
    for (const name of readdirSync(site.docs).filter((f) => f.endsWith('.html'))) {
      const text = readFileSync(path.join(site.docs, name), 'utf8');
      const matches = text.match(/<!-- @page-meta -->/g) || [];
      assert.equal(matches.length, 1, `${name} has duplicate markers`);
    }
  } finally {
    site.cleanup();
  }
});

test('CLI handles two commits on different files and picks each file own stamp', () => {
  // End-to-end check that `git log -1 -- <file>` is per-file, not repo-wide,
  // so two files committed at different times end up with different stamps.
  const site = makeSite();
  try {
    initGitRepo(site.root, 'git@github.com:Example/Project.git');
    // First commit: only index.html, dated 2024-01-01.
    gitCommit(
      site.root,
      'add index',
      ['docs/index.html'],
      '2024-01-01T00:00:00+00:00',
    );
    // Second commit: about.html + guide.html, dated 2024-06-15.
    gitCommit(
      site.root,
      'add others',
      ['docs/about.html', 'docs/guide.html'],
      '2024-06-15T00:00:00+00:00',
    );

    const r = runCli([], site.root);
    assert.equal(r.status, 0, r.stderr);

    const index = readFileSync(path.join(site.docs, 'index.html'), 'utf8');
    const about = readFileSync(path.join(site.docs, 'about.html'), 'utf8');
    assert.match(index, /Updated 01 Jan 2024/);
    assert.match(about, /Updated 15 Jun 2024/);
    // Cross-check: index should not pick up the later commit's date.
    assert.ok(!index.includes('15 Jun 2024'));
  } finally {
    site.cleanup();
  }
});

test('CLI skips pages without </body> (no marker to anchor against)', () => {
  // A page that has no </body> and no <footer> has no insertion point;
  // inject() must leave it unchanged rather than corrupt it.
  const site = makeSite();
  try {
    const weird = path.join(site.docs, 'weird.html');
    writeFileSync(weird, '<html><head></head><p>no body close</p>');
    initGitRepo(site.root, 'git@github.com:Example/Project.git');
    gitCommit(site.root, 'initial');
    const before = readFileSync(weird, 'utf8');
    const r = runCli([], site.root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(weird, 'utf8'), before);
  } finally {
    site.cleanup();
  }
});

test('CLI fails with a clear message when docs/ is missing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'no-docs-'));
  try {
    const r = runCli([], root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /docs\/ directory not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
