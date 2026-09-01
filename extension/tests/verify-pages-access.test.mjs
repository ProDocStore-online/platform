import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, mkdtempBare } from "./_helpers.mjs";

const SCRIPT = path.join(REPO_ROOT, "templates", "search", "scripts", "verify-pages-access.sh");

const BASE_ENV = {
  CLOUDFLARE_API_TOKEN: "t",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  PROJECT_NAME: "kb",
  PAGES_DOMAIN: "kb.pages.dev",
  VERIFY_WAIT_SECONDS: "0",
};

function makeMockCurl(tmpDir, dispatchSource) {
  const logPath = path.join(tmpDir, "curl.log");
  writeFileSync(logPath, "");
  const mockPath = path.join(tmpDir, "mock-curl");
  const script = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
let method = "GET";
let url = "";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-X") { method = args[++i]; continue; }
  if (a === "-H" || a === "-o" || a === "-w" || a === "--max-time") { i++; continue; }
  if (a.startsWith("-")) continue;
  url = a;
}
appendFileSync(${JSON.stringify(logPath)}, method + "\\t" + url + "\\n");
function emit(body, code = 0) {
  process.stdout.write(body);
  process.exit(code);
}
${dispatchSource}
process.stderr.write(\`mock-curl: unhandled \${method} \${url}\\n\`);
process.exit(2);
`;
  writeFileSync(mockPath, script);
  chmodSync(mockPath, 0o755);
  return { mockPath, logPath };
}

function runScript(env, mockPath) {
  return spawnSync("bash", [SCRIPT], {
    env: { ...process.env, ...BASE_ENV, ...env, CURL: mockPath },
    encoding: "utf8",
  });
}

function readCurlLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.includes("\t"))
    .map((line) => line.split("\t", 2));
}

test("private KB accepts Access redirect or denial without rollback", () => {
  const tmp = mkdtempBare("verify-pages-");
  try {
    const { mockPath, logPath } = makeMockCurl(tmp.root, `
      if (url === "https://kb.pages.dev") emit("302");
    `);
    const result = runScript({ PROTECT_SITE: "true" }, mockPath);
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stdout, /not publicly readable/);
    const calls = readCurlLog(logPath);
    assert.deepEqual(calls, [["GET", "https://kb.pages.dev"]]);
  } finally {
    tmp.cleanup();
  }
});

test("private KB rolls back and fails when content is publicly reachable", () => {
  const tmp = mkdtempBare("verify-pages-");
  try {
    const { mockPath, logPath } = makeMockCurl(tmp.root, `
      if (url === "https://kb.pages.dev") emit("200");
      if (url.endsWith("/deployments") && method === "GET") emit('{"success":true,"result":[{"id":"dep1"}]}');
      if (url.endsWith("/deployments/dep1?force=true") && method === "DELETE") emit('{"success":true,"result":{}}');
    `);
    const result = runScript({ PROTECT_SITE: "true" }, mockPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Rolled back latest deployment dep1/);
    const calls = readCurlLog(logPath);
    assert.ok(calls.some(([method, url]) => method === "DELETE" && url.endsWith("/deployments/dep1?force=true")));
  } finally {
    tmp.cleanup();
  }
});

test("private KB fails closed and rolls back when verification cannot reach the domain", () => {
  const tmp = mkdtempBare("verify-pages-");
  try {
    const { mockPath, logPath } = makeMockCurl(tmp.root, `
      if (url === "https://kb.pages.dev") emit("000");
      if (url.endsWith("/deployments") && method === "GET") emit('{"success":true,"result":[{"id":"dep2"}]}');
      if (url.endsWith("/deployments/dep2?force=true") && method === "DELETE") emit('{"success":true,"result":{}}');
    `);
    const result = runScript({ PROTECT_SITE: "true" }, mockPath);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /failing closed/);
    const calls = readCurlLog(logPath);
    assert.ok(calls.some(([method, url]) => method === "DELETE" && url.endsWith("/deployments/dep2?force=true")));
  } finally {
    tmp.cleanup();
  }
});

test("public KB must return HTTP 200", () => {
  const tmp = mkdtempBare("verify-pages-");
  try {
    const { mockPath } = makeMockCurl(tmp.root, `
      if (url === "https://kb.pages.dev") emit("200");
    `);
    const result = runScript({ PROTECT_SITE: "false" }, mockPath);
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stdout, /Public KB is reachable/);
  } finally {
    tmp.cleanup();
  }
});
