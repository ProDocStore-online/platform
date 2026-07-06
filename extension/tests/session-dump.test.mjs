// Tests for the "copy chat" session-dump builder: correct sections, and -
// critically - that secrets never leak into the dump (both key-name redaction
// of settings and token-shape scrubbing of the assembled text).

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { buildSessionDump } = await import(await bundle("src/sidepanel/session-dump.ts"));

const fmt = () => "12:00:00";

test("includes context, settings, messages, and log sections", () => {
  const out = buildSessionDump({
    ctx: {
      repo: { owner: "o", name: "r" },
      sourcePath: "docs/x.md",
      url: "https://x.pages.dev/x",
      navConfig: { items: [1, 2, 3] },
    },
    settings: { adapter: "claude" },
    history: [{ role: "user", content: "hello", timestamp: 1 }],
    logBuffer: ["[12:00:00] sent turn"],
    formatTime: fmt,
  });
  assert.match(out, /# ProDocStore session dump/);
  assert.match(out, /- repo: o\/r/);
  assert.match(out, /- navConfig items: 3/);
  assert.match(out, /## Messages \(1 total\)/);
  assert.match(out, /\[12:00:00\] user:/);
  assert.match(out, /hello/);
  assert.match(out, /## Diagnostic log \(1 entries\)/);
  assert.match(out, /sent turn/);
});

test("no page context renders a placeholder", () => {
  const out = buildSessionDump({
    ctx: null,
    settings: {},
    history: [],
    logBuffer: [],
    formatTime: fmt,
  });
  assert.match(out, /- \(no page context\)/);
  assert.match(out, /\(empty - send a message first\)/);
});

test("redacts secret-named settings values and token-shaped strings in messages", () => {
  const fakeApiKey = ["sk", "-ant-abcdefghijklmnop1234"].join("");
  const fakeGithubToken = ["ghp", "_abcdefghijklmnopqrstuvwxyz0123456789"].join("");
  const out = buildSessionDump({
    ctx: null,
    settings: { claude: { apiKey: fakeApiKey } },
    history: [{ role: "user", content: `my token is ${fakeGithubToken}`, timestamp: 1 }],
    logBuffer: [],
    formatTime: fmt,
  });
  // Settings key-name redaction.
  assert.match(out, /<redacted>/);
  assert.ok(!out.includes(fakeApiKey), "settings secret must not leak");
  // Token-shape scrub of the assembled text (a token pasted into a message).
  assert.ok(!out.includes(fakeGithubToken), "pasted token must not leak");
  assert.match(out, /\[redacted-secret\]/);
});
