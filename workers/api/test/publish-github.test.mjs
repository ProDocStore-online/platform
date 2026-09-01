import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);
const API_ROOT = path.resolve(import.meta.dirname, "..");
const SRC_ROOT = path.join(API_ROOT, "src");

function loadWorkerApp() {
  const tmp = mkdtempSync(path.join(API_ROOT, ".tmp-api-test-"));
  try {
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "commonjs" }));
    transpileTree(SRC_ROOT, tmp);
    const mod = require(path.join(tmp, "index.js"));
    return { app: mod.default, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

function transpileTree(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true });
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    const from = path.join(fromDir, entry.name);
    const to = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      transpileTree(from, to);
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
    const output = ts.transpileModule(readFileSync(from, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
      fileName: from,
    }).outputText;
    writeFileSync(to.replace(/\.ts$/, ".js"), output);
  }
}

function env() {
  const kv = new Map();
  kv.set("session:s1", JSON.stringify({
    id: "s1",
    user: {
      id: "github_1",
      provider: "github",
      login: "serge",
      name: "Serge",
      avatarUrl: "",
      githubUrl: "https://github.com/serge",
      email: "serge@ozai.digital",
    },
    githubAccessToken: "session-token",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  }));
  return {
    PDS_API_KV: {
      async get(key, type) {
        const value = kv.get(key) ?? null;
        return type === "json" && value ? JSON.parse(value) : value;
      },
      async put(key, value) {
        kv.set(key, value);
      },
      async delete(key) {
        kv.delete(key);
      },
    },
    DB: fakeDb(),
    EDITOR_BASE_URL: "https://console.prodocstore.online",
    PUBLIC_BASE_URL: "https://prodocstore.online",
    GITHUB_ORG: "ProDocStore-online",
    GITHUB_TOKEN: "platform-token",
    CLOUDFLARE_API_TOKEN: "cf-token",
    CLOUDFLARE_ACCOUNT_ID: "cf-account",
    PDS_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  };
}

function fakeDb() {
  const publishTargets = [];
  const publishJobs = [];
  return {
    records: { publishTargets, publishJobs },
    prepare(sql) {
      return {
        params: [],
        bind(...params) {
          this.params = params;
          return this;
        },
        async first() {
          if (sql.includes("FROM publish_targets WHERE provider = 'github' AND github_full_name = ?")) {
            return publishTargets.find((target) => target.provider === "github" && target.github_full_name === this.params[0]) ?? null;
          }
          throw new Error(`Unhandled D1 first: ${sql}`);
        },
        async run() {
          if (sql.includes("INSERT INTO publish_targets")) {
            const [
              id,
              kbId,
              localDraftId,
              userId,
              mode,
              githubOwner,
              githubRepo,
              githubFullName,
              defaultBranch,
              visibility,
              liveUrl,
              actionsUrl,
              createdAt,
              updatedAt,
            ] = this.params;
            const existing = publishTargets.find((target) => target.provider === "github" && target.github_full_name === githubFullName);
            const next = {
              id: existing?.id ?? id,
              kb_id: kbId,
              local_draft_id: localDraftId,
              user_id: userId,
              provider: "github",
              mode,
              github_owner: githubOwner,
              github_repo: githubRepo,
              github_full_name: githubFullName,
              default_branch: defaultBranch,
              visibility,
              live_url: liveUrl,
              actions_url: actionsUrl,
              created_at: existing?.created_at ?? createdAt,
              updated_at: updatedAt,
            };
            if (existing) Object.assign(existing, next);
            else publishTargets.push(next);
            return { success: true };
          }
          if (sql.includes("INSERT INTO publish_jobs")) {
            const [
              id,
              targetId,
              kbId,
              userId,
              githubFullName,
              githubBranch,
              githubCommitSha,
              githubCommitUrl,
              liveUrl,
              actionsUrl,
              message,
              createdAt,
              updatedAt,
            ] = this.params;
            publishJobs.push({
              id,
              target_id: targetId,
              kb_id: kbId,
              user_id: userId,
              source: "api",
              trigger: "console",
              status: "submitted",
              github_full_name: githubFullName,
              github_branch: githubBranch,
              github_commit_sha: githubCommitSha,
              github_commit_url: githubCommitUrl,
              live_url: liveUrl,
              actions_url: actionsUrl,
              message,
              created_at: createdAt,
              updated_at: updatedAt,
              completed_at: null,
            });
            return { success: true };
          }
          throw new Error(`Unhandled D1 run: ${sql}`);
        },
      };
    },
  };
}

function repoFiles() {
  return [
    {
      path: ".github/workflows/deploy.yml",
      content: "name: Deploy\njobs:\n  deploy:\n    uses: ProDocStore-online/platform/.github/workflows/deploy-zensical-kb.yml@publisher-v1\n",
    },
    {
      path: "zensical.toml",
      content: 'site_name = "KB"\ndocs_dir = "docs"\nsite_dir = "site"\n',
    },
    {
      path: "docs/index.md",
      content: "# KB\n",
    },
  ];
}

function form() {
  return {
    title: "KB",
    slug: "customer-kb",
    owner: "ProDocStore-online",
    customDomain: "",
    visibility: "private",
    prompt: "A staff KB.",
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("POST /api/publish/github creates repo, installs deploy secrets, then commits all files once", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init.method || "GET";
    const body = typeof init.body === "string" ? init.body : "";
    calls.push({ method, url, body });

    if (url === "https://api.github.com/user") return jsonResponse({ login: "ProDocStore-online" });
    if (url === "https://api.github.com/user/repos" && method === "POST") {
      return jsonResponse({ full_name: "ProDocStore-online/customer-kb", html_url: "https://github.com/ProDocStore-online/customer-kb", default_branch: "main" });
    }
    if (url.endsWith("/actions/secrets/public-key") && method === "GET") {
      return jsonResponse({ key: Buffer.alloc(32).toString("base64"), key_id: "key1" });
    }
    if (url.includes("/actions/secrets/") && method === "PUT") return jsonResponse({});
    if (url === "https://api.github.com/repos/ProDocStore-online/customer-kb" && method === "GET") {
      return jsonResponse({ full_name: "ProDocStore-online/customer-kb", html_url: "https://github.com/ProDocStore-online/customer-kb", default_branch: "main" });
    }
    if (url.endsWith("/git/ref/heads/main") && method === "GET") return jsonResponse({ object: { sha: "headsha" } });
    if (url.endsWith("/git/commits/headsha") && method === "GET") return jsonResponse({ sha: "headsha", tree: { sha: "basetree" } });
    if (url.endsWith("/git/trees") && method === "POST") return jsonResponse({ sha: "newtree" });
    if (url.endsWith("/git/commits") && method === "POST") return jsonResponse({ sha: "newcommit" });
    if (url.endsWith("/git/refs/heads/main") && method === "PATCH") return jsonResponse({});

    return jsonResponse({ message: `Unhandled ${method} ${url}` }, { status: 500 });
  };

  const { app, cleanup } = loadWorkerApp();
  const testEnv = env();
  try {
    const response = await app.fetch(
      new Request("https://api.prodocstore.online/api/publish/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "pds_session=s1",
        },
        body: JSON.stringify({ draftId: "draft-1", form: form(), files: repoFiles() }),
      }),
      testEnv,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    assert.equal(data.repo.full_name, "ProDocStore-online/customer-kb");
    assert.equal(data.commit.sha, "newcommit");
    assert.equal(data.actionsUrl, "https://github.com/ProDocStore-online/customer-kb/actions");
    assert.equal(data.publishTarget.githubFullName, "ProDocStore-online/customer-kb");
    assert.equal(data.publishTarget.mode, "client-hosted");
    assert.equal(data.publishJob.status, "submitted");
    assert.equal(data.publishJob.commitSha, "newcommit");

    assert.equal(testEnv.DB.records.publishTargets.length, 1);
    assert.equal(testEnv.DB.records.publishTargets[0].local_draft_id, "draft-1");
    assert.equal(testEnv.DB.records.publishTargets[0].github_full_name, "ProDocStore-online/customer-kb");
    assert.equal(testEnv.DB.records.publishTargets[0].live_url, "https://customer-kb.pages.dev/");
    assert.equal(testEnv.DB.records.publishJobs.length, 1);
    assert.equal(testEnv.DB.records.publishJobs[0].target_id, testEnv.DB.records.publishTargets[0].id);
    assert.equal(testEnv.DB.records.publishJobs[0].github_commit_url, "https://github.com/ProDocStore-online/customer-kb/commit/newcommit");

    const secretWrites = calls.filter((call) => call.method === "PUT" && call.url.includes("/actions/secrets/"));
    assert.equal(secretWrites.length, 2);
    assert.ok(secretWrites.some((call) => call.url.endsWith("/CLOUDFLARE_API_TOKEN")));
    assert.ok(secretWrites.some((call) => call.url.endsWith("/CLOUDFLARE_ACCOUNT_ID")));

    const treeCall = calls.find((call) => call.method === "POST" && call.url.endsWith("/git/trees"));
    assert.ok(treeCall, "expected one git tree creation");
    const treePayload = JSON.parse(treeCall.body);
    assert.equal(treePayload.tree.length, 3);
    assert.deepEqual(treePayload.tree.map((entry) => entry.path).sort(), [".github/workflows/deploy.yml", "docs/index.md", "zensical.toml"]);

    const firstSecretWrite = calls.findIndex((call) => call.method === "PUT" && call.url.includes("/actions/secrets/"));
    const firstCommitWrite = calls.findIndex((call) => call.method === "POST" && call.url.endsWith("/git/trees"));
    assert.ok(firstSecretWrite >= 0 && firstCommitWrite > firstSecretWrite, "deploy secrets should be written before committing workflow files");
    assert.equal(calls.filter((call) => call.method === "PATCH" && call.url.endsWith("/git/refs/heads/main")).length, 1);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/publish/github rejects generated site output before GitHub calls", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ method: init.method || "GET", url: typeof input === "string" ? input : input.url });
    return jsonResponse({});
  };
  const { app, cleanup } = loadWorkerApp();
  const testEnv = env();
  try {
    const response = await app.fetch(
      new Request("https://api.prodocstore.online/api/publish/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: "pds_session=s1",
        },
        body: JSON.stringify({
          form: form(),
          files: [...repoFiles(), { path: "site/index.html", content: "<h1>built</h1>" }],
        }),
      }),
      testEnv,
    );
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Generated site output is not allowed/);
    assert.deepEqual(calls, []);
    assert.deepEqual(testEnv.DB.records.publishTargets, []);
    assert.deepEqual(testEnv.DB.records.publishJobs, []);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});
