// Tests for templates/search/scripts/sync-access-policies.sh.
//
// The action at .github/actions/sync-access-policies/action.yml is a thin
// wrapper around this script. Tests drive the script directly and point
// its CURL env var at a Node mock so no real Cloudflare API calls go out.
//
// Ported from tests/test_sync_access_policies.py. The mock was Python; now
// it's Node, same pattern: the mock writes each call to a log file and
// emits canned responses based on dispatch logic supplied per test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  accessSync,
  constants,
} from "node:fs";
import path from "node:path";
import { REPO_ROOT, mkdtempBare } from "./_helpers.mjs";

const SCRIPT = path.join(
  REPO_ROOT,
  "templates",
  "search",
  "scripts",
  "sync-access-policies.sh",
);

const BASE_ENV = {
  CLOUDFLARE_API_TOKEN: "t",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  APP_ID: "app123",
  EMAIL_DOMAIN: "example.com",
  CLIENT_EMAILS: "",
  CLIENT_DOMAIN: "",
  OFFICE_CIDRS: "",
};

/**
 * Write an executable Node script that pretends to be curl. It logs each
 * call to <tmp>/curl.log as `METHOD\tURL` and emits a canned body based
 * on the `dispatch` JS source provided by the caller. Dispatch receives
 * `method` and `url` and must call `emit(body)` exactly once.
 */
function makeMockCurl(tmpDir, dispatchSource) {
  const logPath = path.join(tmpDir, "curl.log");
  writeFileSync(logPath, "");
  const mockPath = path.join(tmpDir, "mock-curl");
  const script = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
// Parse method (-X VERB) and URL (first non-flag, non-flag-value arg)
const args = process.argv.slice(2);
let method = "GET";
let url = "";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-X") { method = args[++i]; continue; }
  if (a === "-H" || a === "--data" || a === "-d") { i++; continue; }
  if (a.startsWith("-")) continue;
  url = a;
}
appendFileSync(${JSON.stringify(logPath)}, method + "\\t" + url + "\\n");

function emit(body, code = 0) {
  process.stdout.write(body);
  process.exit(code);
}

// ── user dispatch ──
${dispatchSource}
// fall-through: unhandled URL
process.stderr.write(\`mock-curl: unhandled \${method} \${url}\\n\`);
process.exit(2);
`;
  writeFileSync(mockPath, script);
  chmodSync(mockPath, 0o755);
  return { mockPath, logPath };
}

function runScript(env, mockPath) {
  const merged = { ...process.env, ...env, CURL: mockPath };
  // Let a caller UNSET a var by passing it as undefined. Without this, the
  // `...process.env` spread leaks the ambient value through (e.g. a real
  // CLOUDFLARE_API_TOKEN in the dev/CI shell), so the "requires token" test
  // would pass the token it was trying to withhold and wrongly see success.
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return spawnSync("bash", [SCRIPT], { env: merged, encoding: "utf8" });
}

function readCurlLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.includes("\t"))
    .map((l) => l.split("\t", 2));
}

// ── Sanity ──────────────────────────────────────────────────────────

test("script exists and is readable", () => {
  assert.ok(existsSync(SCRIPT));
  assert.doesNotThrow(() => accessSync(SCRIPT, constants.R_OK));
});

test("requires CLOUDFLARE_API_TOKEN", () => {
  const tmp = mkdtempBare("sync-access-");
  try {
    const { mockPath } = makeMockCurl(tmp.root, 'emit("{}");');
    // Pass undefined (not `delete`) so runScript strips it from the child env
    // instead of the ambient value leaking back in via process.env.
    const env = { ...BASE_ENV, CLOUDFLARE_API_TOKEN: undefined };
    const r = runScript(env, mockPath);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /CLOUDFLARE_API_TOKEN/);
  } finally {
    tmp.cleanup();
  }
});

// ── {"result": null} must not crash ────────────────────────────────

test('{"success": true, "result": null} is handled without jq iteration crash', () => {
  const tmp = mkdtempBare("sync-access-");
  try {
    const dispatch = `
      if (url.includes("/policies") && method === "GET")
        emit('{"success": true, "result": null}');
      if (url.includes("/policies") && method === "POST")
        emit('{"success": true, "result": {"id": "new1"}}');
    `;
    const { mockPath, logPath } = makeMockCurl(tmp.root, dispatch);
    const r = runScript(BASE_ENV, mockPath);
    assert.equal(
      r.status,
      0,
      `exit=${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
    );
    assert.doesNotMatch(r.stderr, /Cannot iterate over null/);
    // Allow policy was still created.
    const calls = readCurlLog(logPath);
    assert.ok(calls.some(([m]) => m === "POST"));
  } finally {
    tmp.cleanup();
  }
});

test("no Access rules configured deletes managed policies and leaves app closed", () => {
  const tmp = mkdtempBare("sync-access-");
  try {
    const dispatch = `
      if (url.includes("/policies") && method === "GET")
        emit('{"success": true, "result": [{"id":"p1","name":"Old allow","precedence":1}]}');
      if (url.includes("/policies/") && method === "DELETE")
        emit('{"success": true, "result": {"id":"p1"}}');
    `;
    const { mockPath, logPath } = makeMockCurl(tmp.root, dispatch);
    const env = {
      ...BASE_ENV,
      EMAIL_DOMAIN: "",
      CLIENT_EMAILS: "",
      CLIENT_DOMAIN: "",
      OFFICE_CIDRS: "",
    };
    const r = runScript(env, mockPath);
    assert.equal(
      r.status,
      0,
      `exit=${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
    );
    assert.match(r.stdout, /closed by default/);
    const calls = readCurlLog(logPath);
    assert.ok(calls.some(([m]) => m === "DELETE"));
    assert.equal(calls.filter(([m]) => m === "POST").length, 0);
  } finally {
    tmp.cleanup();
  }
});

// ── API error surfaced, not silently ignored ──────────────────────

test('list-policies error response (success:false) fails the script', () => {
  const tmp = mkdtempBare("sync-access-");
  try {
    const dispatch = `
      if (url.includes("/policies") && method === "GET")
        emit('{"success": false, "errors":[{"code": 10000, "message":"Auth error"}]}');
    `;
    const { mockPath } = makeMockCurl(tmp.root, dispatch);
    const r = runScript(BASE_ENV, mockPath);
    assert.notEqual(r.status, 0);
    const combined = r.stdout + r.stderr;
    assert.ok(
      combined.includes("10000") || combined.includes("Auth error"),
      `error not surfaced. stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`,
    );
  } finally {
    tmp.cleanup();
  }
});

// ── Dynamic precedence ────────────────────────────────────────────

test("dynamic precedence skips reusable policies at 1 and 2", () => {
  const tmp = mkdtempBare("sync-access-");
  try {
    // Two reusable policies that refuse deletion. Bypass -> prec 3; Allow -> prec 4.
    const dispatch = `
      if (url.includes("/policies") && method === "GET")
        emit(JSON.stringify({
          success: true,
          result: [
            { id: "r1", name: "Reusable A", precedence: 1 },
            { id: "r2", name: "Reusable B", precedence: 2 },
          ],
        }));
      if (url.includes("/policies/") && method === "DELETE")
        emit('{"success": false, "errors":[{"message":"reusable"}]}');
      if (url.includes("/policies") && method === "POST")
        emit('{"success": true, "result": {"id": "new"}}');
    `;
    const { mockPath } = makeMockCurl(tmp.root, dispatch);
    const env = { ...BASE_ENV, OFFICE_CIDRS: "10.0.0.0/24" };
    const r = runScript(env, mockPath);
    assert.equal(
      r.status,
      0,
      `exit=${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
    );
    assert.match(r.stdout, /precedence 3/, `expected bypass at prec 3:\n${r.stdout}`);
    assert.match(r.stdout, /precedence 4/, `expected allow at prec 4:\n${r.stdout}`);
  } finally {
    tmp.cleanup();
  }
});

// ── Delete verification warning ───────────────────────────────────

test("delete failure surfaces as ::warning:: but doesn't fail the script", () => {
  const tmp = mkdtempBare("sync-access-");
  try {
    const dispatch = `
      if (url.includes("/policies") && method === "GET")
        emit(JSON.stringify({
          success: true,
          result: [{ id: "p1", name: "Old", precedence: 1 }],
        }));
      if (url.includes("/policies/") && method === "DELETE")
        emit('{"success": false, "errors":[{"message":"cannot delete"}]}');
      if (url.includes("/policies") && method === "POST")
        emit('{"success": true, "result": {"id": "new"}}');
    `;
    const { mockPath } = makeMockCurl(tmp.root, dispatch);
    const r = runScript(BASE_ENV, mockPath);
    assert.equal(
      r.status,
      0,
      `exit=${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
    );
    assert.match(r.stdout, /::warning::/);
    assert.match(r.stdout, /Failed to delete/);
  } finally {
    tmp.cleanup();
  }
});

// ── Empty policy list ─────────────────────────────────────────────

test("empty policy list + no CIDRs -> single allow POST", () => {
  const tmp = mkdtempBare("sync-access-");
  try {
    const dispatch = `
      if (url.includes("/policies") && method === "GET")
        emit('{"success": true, "result": []}');
      if (url.includes("/policies") && method === "POST")
        emit('{"success": true, "result": {"id": "new"}}');
    `;
    const { mockPath, logPath } = makeMockCurl(tmp.root, dispatch);
    const r = runScript(BASE_ENV, mockPath);
    assert.equal(
      r.status,
      0,
      `exit=${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
    );
    assert.doesNotMatch(r.stderr, /Cannot iterate/);
    assert.match(r.stdout, /Created allow policy/);
    const posts = readCurlLog(logPath).filter(([m]) => m === "POST");
    assert.equal(posts.length, 1);
    // Allow policy takes precedence 1 when it's the only managed policy.
    assert.match(r.stdout, /at precedence 1/);
  } finally {
    tmp.cleanup();
  }
});

test("raw Cloudflare Access include, require, and exclude rules are added to allow policy", () => {
  const tmp = mkdtempBare("sync-access-");
  try {
    const dispatch = `
      if (url.includes("/policies") && method === "GET")
        emit('{"success": true, "result": []}');
      if (url.includes("/policies") && method === "POST")
        emit('{"success": true, "result": {"id": "new"}}');
    `;
    const { mockPath } = makeMockCurl(tmp.root, dispatch);
    const env = {
      ...BASE_ENV,
      EMAIL_DOMAIN: "",
      ACCESS_RULES_JSON: JSON.stringify({
        include: [{ github_organization: { name: "ProDocStore-online", identity_provider_id: "idp" } }],
        require: [{ country: { country_code: "AU" } }],
        exclude: [{ email: { email: "blocked@example.com" } }],
      }),
    };
    const r = runScript(env, mockPath);
    assert.equal(
      r.status,
      0,
      `exit=${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`,
    );
    assert.match(r.stdout, /github_organization/);
    assert.match(r.stdout, /"require":/);
    assert.match(r.stdout, /"exclude":/);
  } finally {
    tmp.cleanup();
  }
});

test("raw Cloudflare Access require without include fails closed", () => {
  const tmp = mkdtempBare("sync-access-");
  try {
    const { mockPath, logPath } = makeMockCurl(tmp.root, 'emit("{}");');
    const env = {
      ...BASE_ENV,
      EMAIL_DOMAIN: "",
      ACCESS_RULES_JSON: JSON.stringify({ require: [{ country: { country_code: "AU" } }] }),
    };
    const r = runScript(env, mockPath);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /need at least one include rule/);
    assert.deepEqual(readCurlLog(logPath), []);
  } finally {
    tmp.cleanup();
  }
});
