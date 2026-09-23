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
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    CLOUDFLARE_API_TOKEN: "cf-token",
    CLOUDFLARE_ACCOUNT_ID: "cf-account",
    PDS_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  };
}

function fakeDb() {
  const publishTargets = [];
  const publishJobs = [];
  const knowledgeBases = [];
  const memberships = [];
  const pages = [];
  const publishVersions = [];
  const publishVersionPages = [];
  const publishPointers = [];
  return {
    records: { publishTargets, publishJobs, knowledgeBases, memberships, pages, publishVersions, publishVersionPages, publishPointers },
    async batch(statements) {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
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
          if (sql.includes("FROM publish_targets WHERE provider = 'github' AND lower(github_full_name) = lower(?)")) {
            return publishTargets.find((target) => target.provider === "github" && target.github_full_name.toLowerCase() === String(this.params[0]).toLowerCase()) ?? null;
          }
          if (sql.includes("FROM publish_targets WHERE provider = 'prodocstore' AND github_full_name = ?")) {
            return publishTargets.find((target) => target.provider === "prodocstore" && target.github_full_name === this.params[0]) ?? null;
          }
          if (sql.includes("FROM knowledge_bases WHERE id = ?")) {
            return knowledgeBases.find((kb) => kb.id === this.params[0]) ?? null;
          }
          if (sql.includes("SELECT role FROM memberships WHERE org_id = ? AND user_id = ?")) {
            const [orgId, userId] = this.params;
            return memberships.find((membership) => membership.org_id === orgId && membership.user_id === userId) ?? null;
          }
          if (sql.includes("SELECT MAX(version) AS version FROM publish_versions WHERE kb_id = ?")) {
            const versions = publishVersions.filter((v) => v.kb_id === this.params[0]).map((v) => v.version);
            return { version: versions.length ? Math.max(...versions) : null };
          }
          if (sql.includes("FROM publish_pointers p JOIN publish_versions v ON v.id = p.version_id")) {
            const pointer = publishPointers.find((p) => p.kb_id === this.params[0]);
            return pointer ? (publishVersions.find((v) => v.id === pointer.version_id) ?? null) : null;
          }
          if (sql.includes("FROM publish_versions WHERE kb_id = ? AND version = ?")) {
            const [kbId, version] = this.params;
            return publishVersions.find((v) => v.kb_id === kbId && v.version === version) ?? null;
          }
          if (sql.includes("FROM publish_version_pages WHERE version_id = ? AND path = ?")) {
            const [versionId, path] = this.params;
            return publishVersionPages.find((p) => p.version_id === versionId && p.path === path) ?? null;
          }
          throw new Error(`Unhandled D1 first: ${sql}`);
        },
        async all() {
          if (sql.includes("FROM publish_jobs j") && sql.includes("JOIN publish_targets t ON t.id = j.target_id")) {
            const [userId, localDraftId, limit] = this.params;
            const targetIds = new Map(
              publishTargets
                .filter((target) => target.user_id === userId && target.local_draft_id === localDraftId)
                .map((target) => [target.id, target]),
            );
            const results = publishJobs
              .filter((job) => targetIds.has(job.target_id))
              .sort((a, b) => b.created_at - a.created_at)
              .slice(0, limit)
              .map((job) => {
                const target = targetIds.get(job.target_id);
                return {
                  ...job,
                  target_mode: target.mode,
                  target_provider: target.provider,
                };
              });
            return { results };
          }
          if (sql.includes("SELECT id, kb_id, path, title, updated_by, updated_at FROM pages WHERE kb_id = ? ORDER BY path")) {
            const [kbId] = this.params;
            return {
              results: pages
                .filter((page) => page.kb_id === kbId)
                .map(({ content, ...page }) => page),
            };
          }
          if (sql.includes("SELECT * FROM pages WHERE kb_id = ? ORDER BY path")) {
            const [kbId] = this.params;
            return { results: pages.filter((page) => page.kb_id === kbId).sort((a, b) => a.path.localeCompare(b.path)) };
          }
          if (sql.includes("SELECT path, title FROM publish_version_pages WHERE version_id = ? ORDER BY path")) {
            const [versionId] = this.params;
            return {
              results: publishVersionPages
                .filter((page) => page.version_id === versionId)
                .sort((a, b) => a.path.localeCompare(b.path))
                .map(({ path, title }) => ({ path, title })),
            };
          }
          if (sql.includes("FROM publish_versions WHERE kb_id = ? ORDER BY version DESC LIMIT ?")) {
            const [kbId, limit] = this.params;
            return {
              results: publishVersions
                .filter((v) => v.kb_id === kbId)
                .sort((a, b) => b.version - a.version)
                .slice(0, limit),
            };
          }
          throw new Error(`Unhandled D1 all: ${sql}`);
        },
        async run() {
          if (sql.includes("INSERT INTO users")) {
            return { success: true };
          }
          if (sql.includes("INSERT INTO publish_targets")) {
            if (sql.includes("'prodocstore'")) {
              const [
                id,
                kbId,
                userId,
                githubRepo,
                githubFullName,
                visibility,
                liveUrl,
                createdAt,
                updatedAt,
              ] = this.params;
              const existing = publishTargets.find((target) => target.provider === "prodocstore" && target.github_full_name === githubFullName);
              const next = {
                id: existing?.id ?? id,
                kb_id: kbId,
                local_draft_id: null,
                user_id: userId,
                provider: "prodocstore",
                mode: "managed",
                github_owner: "",
                github_repo: githubRepo,
                github_full_name: githubFullName,
                default_branch: "managed",
                visibility,
                live_url: liveUrl,
                actions_url: "",
                created_at: existing?.created_at ?? createdAt,
                updated_at: updatedAt,
              };
              if (existing) Object.assign(existing, next);
              else publishTargets.push(next);
              return { success: true };
            }
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
              source,
              trigger,
              status,
              githubFullName,
              githubBranch,
              githubCommitSha,
              githubCommitUrl,
              liveUrl,
              actionsUrl,
              message,
              createdAt,
              updatedAt,
              completedAt,
            ] = this.params;
            publishJobs.push({
              id,
              target_id: targetId,
              kb_id: kbId,
              user_id: userId,
              source,
              trigger,
              status,
              github_full_name: githubFullName,
              github_branch: githubBranch,
              github_commit_sha: githubCommitSha,
              github_commit_url: githubCommitUrl,
              live_url: liveUrl,
              actions_url: actionsUrl,
              message,
              created_at: createdAt,
              updated_at: updatedAt,
              completed_at: completedAt,
            });
            return { success: true };
          }
          if (sql.includes("UPDATE publish_jobs SET status = ?, message = ?, completed_at = ?, updated_at = ? WHERE id = ?")) {
            const [status, message, completedAt, updatedAt, id] = this.params;
            const job = publishJobs.find((j) => j.id === id);
            if (job) Object.assign(job, { status, message, completed_at: completedAt, updated_at: updatedAt });
            return { success: true };
          }
          if (sql.includes("INSERT INTO publish_version_pages")) {
            const [versionId, path, title, content] = this.params;
            publishVersionPages.push({ version_id: versionId, path, title, content });
            return { success: true };
          }
          if (sql.includes("INSERT INTO publish_versions")) {
            const [id, kbId, version, targetId, jobId, pageCount, createdBy, createdAt] = this.params;
            if (publishVersions.some((v) => v.kb_id === kbId && v.version === version)) {
              throw new Error("UNIQUE constraint failed: publish_versions.kb_id, publish_versions.version");
            }
            publishVersions.push({
              id,
              kb_id: kbId,
              version,
              target_id: targetId,
              job_id: jobId,
              page_count: pageCount,
              created_by: createdBy,
              created_at: createdAt,
            });
            return { success: true };
          }
          if (sql.includes("INSERT INTO publish_pointers")) {
            const [kbId, versionId, version, updatedBy, updatedAt] = this.params;
            const next = { kb_id: kbId, version_id: versionId, version, updated_by: updatedBy, updated_at: updatedAt };
            const existing = publishPointers.find((p) => p.kb_id === kbId);
            if (existing) Object.assign(existing, next);
            else publishPointers.push(next);
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

async function githubSignature(secret, body) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `sha256=${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function publishTarget(overrides = {}) {
  return {
    id: "target-1",
    kb_id: null,
    local_draft_id: "draft-1",
    user_id: "github_1",
    provider: "github",
    mode: "client-hosted",
    github_owner: "ProDocStore-online",
    github_repo: "customer-kb",
    github_full_name: "ProDocStore-online/customer-kb",
    default_branch: "main",
    visibility: "private",
    live_url: "https://customer-kb.pages.dev/",
    actions_url: "https://github.com/ProDocStore-online/customer-kb/actions",
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
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
    if (url.endsWith("/hooks?per_page=100") && method === "GET") return jsonResponse([]);
    if (url.endsWith("/hooks") && method === "POST") return jsonResponse({ id: 123 });

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
    assert.deepEqual(data.webhook, {
      configured: true,
      status: "created",
      source: "platform",
      id: 123,
    });

    assert.equal(testEnv.DB.records.publishTargets.length, 1);
    assert.equal(testEnv.DB.records.publishTargets[0].local_draft_id, "draft-1");
    assert.equal(testEnv.DB.records.publishTargets[0].github_full_name, "ProDocStore-online/customer-kb");
    assert.equal(testEnv.DB.records.publishTargets[0].live_url, "https://customer-kb.pages.dev/");
    assert.equal(testEnv.DB.records.publishJobs.length, 1);
    assert.equal(testEnv.DB.records.publishJobs[0].target_id, testEnv.DB.records.publishTargets[0].id);
    assert.equal(testEnv.DB.records.publishJobs[0].github_commit_url, "https://github.com/ProDocStore-online/customer-kb/commit/newcommit");

    const jobsResponse = await app.fetch(
      new Request("https://api.prodocstore.online/api/publish/jobs?draftId=draft-1", {
        headers: { Cookie: "pds_session=s1" },
      }),
      testEnv,
    );
    assert.equal(jobsResponse.status, 200, await jobsResponse.clone().text());
    const jobsData = await jobsResponse.json();
    assert.equal(jobsData.jobs.length, 1);
    assert.equal(jobsData.jobs[0].status, "submitted");
    assert.equal(jobsData.jobs[0].mode, "client-hosted");
    assert.equal(jobsData.jobs[0].provider, "github");
    assert.equal(jobsData.jobs[0].repo, "ProDocStore-online/customer-kb");
    assert.equal(jobsData.jobs[0].commitSha, "newcommit");

    const secretWrites = calls.filter((call) => call.method === "PUT" && call.url.includes("/actions/secrets/"));
    assert.equal(secretWrites.length, 2);
    assert.ok(secretWrites.some((call) => call.url.endsWith("/CLOUDFLARE_API_TOKEN")));
    assert.ok(secretWrites.some((call) => call.url.endsWith("/CLOUDFLARE_ACCOUNT_ID")));

    const hookCreates = calls.filter((call) => call.method === "POST" && call.url.endsWith("/hooks"));
    assert.equal(hookCreates.length, 1);
    const hookPayload = JSON.parse(hookCreates[0].body);
    assert.equal(hookPayload.active, true);
    assert.deepEqual(hookPayload.events, ["push"]);
    assert.equal(hookPayload.config.url, "https://api.prodocstore.online/api/webhooks/github");
    assert.equal(hookPayload.config.content_type, "json");
    assert.equal(hookPayload.config.secret, "webhook-secret");

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

test("POST /api/publish/github refreshes an existing GitHub push webhook", async () => {
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
    if (url.endsWith("/hooks?per_page=100") && method === "GET") {
      return jsonResponse([{ id: 456, active: false, events: ["issues"], config: { url: "https://api.prodocstore.online/api/webhooks/github" } }]);
    }
    if (url.endsWith("/hooks/456") && method === "PATCH") return jsonResponse({ id: 456 });

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
    assert.deepEqual(data.webhook, {
      configured: true,
      status: "updated",
      source: "platform",
      id: 456,
    });
    assert.equal(calls.filter((call) => call.method === "POST" && call.url.endsWith("/hooks")).length, 0);
    const hookUpdates = calls.filter((call) => call.method === "PATCH" && call.url.endsWith("/hooks/456"));
    assert.equal(hookUpdates.length, 1);
    assert.equal(JSON.parse(hookUpdates[0].body).config.secret, "webhook-secret");
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/kbs/:kbId/publish records a managed target without GitHub calls", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("managed publish should not call GitHub or Cloudflare");
  };
  const { app, cleanup } = loadWorkerApp();
  const testEnv = env();
  testEnv.DB.records.knowledgeBases.push({
    id: "kb_1",
    org_id: "org_1",
    slug: "ops",
    title: "Ops KB",
    description: null,
    visibility: "private",
    custom_domain: null,
    access_email_domains: "ozai.digital",
    access_allowed_emails: "",
    created_by: "github_1",
    created_at: 1760000000000,
    updated_at: 1760000001000,
  });
  testEnv.DB.records.memberships.push({ org_id: "org_1", user_id: "github_1", role: "editor" });
  testEnv.DB.records.pages.push({
    id: "page_1",
    kb_id: "kb_1",
    path: "docs/index.md",
    title: "Home",
    content: "# Ops KB\n",
    updated_by: "github_1",
    updated_at: 1760000001000,
  });
  try {
    const response = await app.fetch(
      new Request("https://api.prodocstore.online/api/kbs/kb_1/publish", {
        method: "POST",
        headers: { Cookie: "pds_session=s1" },
      }),
      testEnv,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    assert.equal(data.mode, "managed");
    assert.equal(data.liveUrl, "https://api.prodocstore.online/kb/kb_1");
    assert.equal(data.pageCount, 1);
    assert.equal(data.publishTarget.mode, "managed");
    assert.equal(data.publishTarget.provider, "prodocstore");
    assert.equal(data.publishTarget.kbId, "kb_1");
    assert.equal(data.publishJob.status, "completed");
    assert.ok(data.publishJob.completedAt);

    assert.equal(testEnv.DB.records.publishTargets.length, 1);
    assert.equal(testEnv.DB.records.publishTargets[0].provider, "prodocstore");
    assert.equal(testEnv.DB.records.publishTargets[0].mode, "managed");
    assert.equal(testEnv.DB.records.publishTargets[0].github_full_name, "prodocstore:kb_1");
    assert.equal(testEnv.DB.records.publishTargets[0].live_url, "https://api.prodocstore.online/kb/kb_1");
    assert.equal(testEnv.DB.records.publishJobs.length, 1);
    assert.equal(testEnv.DB.records.publishJobs[0].status, "completed");
    assert.equal(testEnv.DB.records.publishJobs[0].source, "api");
    assert.equal(testEnv.DB.records.publishJobs[0].trigger, "console");
    assert.equal(testEnv.DB.records.publishJobs[0].completed_at, data.publishJob.completedAt);
    assert.equal(data.version.version, 1);
    assert.equal(testEnv.DB.records.publishVersions.length, 1);
    assert.equal(testEnv.DB.records.publishVersions[0].job_id, data.publishJob.id);
    assert.equal(testEnv.DB.records.publishVersions[0].target_id, data.publishTarget.id);
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
  }
});

function seedManagedKb(testEnv, content = "# Ops KB\n") {
  testEnv.DB.records.knowledgeBases.push({
    id: "kb_1",
    org_id: "org_1",
    slug: "ops",
    title: "Ops KB",
    description: null,
    visibility: "private",
    custom_domain: null,
    access_email_domains: "ozai.digital",
    access_allowed_emails: "",
    created_by: "github_1",
    created_at: 1760000000000,
    updated_at: 1760000001000,
  });
  testEnv.DB.records.memberships.push({ org_id: "org_1", user_id: "github_1", role: "editor" });
  testEnv.DB.records.pages.push({
    id: "page_1",
    kb_id: "kb_1",
    path: "docs/index.md",
    title: "Home",
    content,
    updated_by: "github_1",
    updated_at: 1760000001000,
  });
}

function managedRequest(pathname, init = {}) {
  return new Request(`https://api.prodocstore.online${pathname}`, {
    ...init,
    headers: { Cookie: "pds_session=s1", ...(init.headers ?? {}) },
  });
}

test("POST /api/kbs/:kbId/publish snapshots pages so later draft edits are not live", async () => {
  const { app, cleanup } = loadWorkerApp();
  const testEnv = env();
  seedManagedKb(testEnv, "# Published copy\n");
  try {
    const published = await app.fetch(managedRequest("/api/kbs/kb_1/publish", { method: "POST" }), testEnv);
    assert.equal(published.status, 200, await published.clone().text());
    const data = await published.json();
    assert.equal(data.version.version, 1);
    assert.equal(data.version.pageCount, 1);

    // The artifact is a copy: the version row holds the page content, and the
    // pointer names the version that is live.
    assert.equal(testEnv.DB.records.publishVersionPages.length, 1);
    assert.equal(testEnv.DB.records.publishVersionPages[0].content, "# Published copy\n");
    assert.equal(testEnv.DB.records.publishPointers.length, 1);
    assert.equal(testEnv.DB.records.publishPointers[0].version_id, data.version.id);

    // A draft edit after publishing must not reach the live URL.
    testEnv.DB.records.pages[0].content = "# Unpublished draft\n";
    const rendered = await app.fetch(managedRequest("/kb/kb_1"), testEnv);
    assert.equal(rendered.status, 200);
    const html = await rendered.text();
    assert.ok(html.includes("Published copy"), html);
    assert.ok(!html.includes("Unpublished draft"), html);
  } finally {
    cleanup();
  }
});

test("POST /api/kbs/:kbId/rollback moves the pointer back without rewriting artifacts", async () => {
  const { app, cleanup } = loadWorkerApp();
  const testEnv = env();
  seedManagedKb(testEnv, "# Version one\n");
  try {
    await app.fetch(managedRequest("/api/kbs/kb_1/publish", { method: "POST" }), testEnv);
    testEnv.DB.records.pages[0].content = "# Version two\n";
    const second = await app.fetch(managedRequest("/api/kbs/kb_1/publish", { method: "POST" }), testEnv);
    assert.equal((await second.json()).version.version, 2);

    const live = await app.fetch(managedRequest("/kb/kb_1"), testEnv);
    assert.ok((await live.text()).includes("Version two"));

    const rolledBack = await app.fetch(
      managedRequest("/api/kbs/kb_1/rollback", { method: "POST", body: JSON.stringify({ version: 1 }) }),
      testEnv,
    );
    assert.equal(rolledBack.status, 200, await rolledBack.clone().text());
    assert.equal((await rolledBack.json()).version.version, 1);

    // Rollback is a pointer change only — both artifacts survive it.
    assert.equal(testEnv.DB.records.publishVersions.length, 2);
    assert.equal(testEnv.DB.records.publishVersionPages.length, 2);
    assert.equal(testEnv.DB.records.publishPointers.length, 1);
    assert.equal(testEnv.DB.records.publishPointers[0].version, 1);

    const afterRollback = await app.fetch(managedRequest("/kb/kb_1"), testEnv);
    const html = await afterRollback.text();
    assert.ok(html.includes("Version one"), html);
    assert.ok(!html.includes("Version two"), html);

    // Rolling forward again is the same call with the higher version.
    const rolledForward = await app.fetch(
      managedRequest("/api/kbs/kb_1/rollback", { method: "POST", body: JSON.stringify({ version: 2 }) }),
      testEnv,
    );
    assert.equal(rolledForward.status, 200);
    assert.ok((await (await app.fetch(managedRequest("/kb/kb_1"), testEnv)).text()).includes("Version two"));
  } finally {
    cleanup();
  }
});

test("POST /api/kbs/:kbId/rollback rejects versions the KB does not have", async () => {
  const { app, cleanup } = loadWorkerApp();
  const testEnv = env();
  seedManagedKb(testEnv);
  try {
    await app.fetch(managedRequest("/api/kbs/kb_1/publish", { method: "POST" }), testEnv);
    const missing = await app.fetch(
      managedRequest("/api/kbs/kb_1/rollback", { method: "POST", body: JSON.stringify({ version: 9 }) }),
      testEnv,
    );
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /does not exist/);

    const invalid = await app.fetch(
      managedRequest("/api/kbs/kb_1/rollback", { method: "POST", body: JSON.stringify({ version: 0 }) }),
      testEnv,
    );
    assert.equal(invalid.status, 400);

    // Neither rejection disturbed the live pointer.
    assert.equal(testEnv.DB.records.publishPointers[0].version, 1);
  } finally {
    cleanup();
  }
});

test("POST /api/kbs/:kbId/publish returns 409 and fails the job when a concurrent publish wins the version", async () => {
  const { app, cleanup } = loadWorkerApp();
  const testEnv = env();
  seedManagedKb(testEnv, "# First\n");
  try {
    await app.fetch(managedRequest("/api/kbs/kb_1/publish", { method: "POST" }), testEnv);

    // Simulate the race: this request read MAX(version) before the other publish
    // committed, so it tries to insert a version number that now exists.
    const prepare = testEnv.DB.prepare.bind(testEnv.DB);
    testEnv.DB.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql.includes("SELECT MAX(version) AS version FROM publish_versions")) statement.first = async () => ({ version: null });
      return statement;
    };
    testEnv.DB.records.pages[0].content = "# Loser\n";
    const raced = await app.fetch(managedRequest("/api/kbs/kb_1/publish", { method: "POST" }), testEnv);
    assert.equal(raced.status, 409, await raced.clone().text());

    const jobs = testEnv.DB.records.publishJobs;
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].status, "completed");
    assert.equal(jobs[1].status, "failed");
    assert.ok(jobs[1].completed_at);
    // The winner stays live.
    assert.equal(testEnv.DB.records.publishVersions.length, 1);
    assert.equal(testEnv.DB.records.publishPointers[0].version, 1);
  } finally {
    cleanup();
  }
});

test("GET /api/kbs/:kbId/versions lists versions newest first and flags the live one", async () => {
  const { app, cleanup } = loadWorkerApp();
  const testEnv = env();
  seedManagedKb(testEnv);
  try {
    await app.fetch(managedRequest("/api/kbs/kb_1/publish", { method: "POST" }), testEnv);
    await app.fetch(managedRequest("/api/kbs/kb_1/publish", { method: "POST" }), testEnv);
    await app.fetch(managedRequest("/api/kbs/kb_1/rollback", { method: "POST", body: JSON.stringify({ version: 1 }) }), testEnv);

    const response = await app.fetch(managedRequest("/api/kbs/kb_1/versions"), testEnv);
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    assert.equal(data.liveVersion, 1);
    assert.deepEqual(data.versions.map((v) => v.version), [2, 1]);
    assert.deepEqual(data.versions.map((v) => v.live), [false, true]);
    assert.equal(data.versions[0].pageCount, 1);
  } finally {
    cleanup();
  }
});

test("POST /api/webhooks/github creates a publish job for registered default-branch pushes", async () => {
  const { app, cleanup } = loadWorkerApp();
  const testEnv = env();
  testEnv.DB.records.publishTargets.push(publishTarget());
  const body = JSON.stringify({
    ref: "refs/heads/main",
    after: "1234567890abcdef1234567890abcdef12345678",
    repository: { full_name: "ProDocStore-online/customer-kb" },
    head_commit: { url: "https://github.com/ProDocStore-online/customer-kb/commit/1234567890abcdef1234567890abcdef12345678" },
  });
  try {
    const response = await app.fetch(
      new Request("https://api.prodocstore.online/api/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "push",
          "X-GitHub-Delivery": "delivery-1",
          "X-Hub-Signature-256": await githubSignature("webhook-secret", body),
        },
        body,
      }),
      testEnv,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    assert.equal(data.job.status, "submitted");
    assert.equal(data.job.repo, "ProDocStore-online/customer-kb");
    assert.equal(data.job.branch, "main");
    assert.equal(data.job.commitSha, "1234567890abcdef1234567890abcdef12345678");
    assert.equal(testEnv.DB.records.publishJobs.length, 1);
    assert.equal(testEnv.DB.records.publishJobs[0].source, "webhook");
    assert.equal(testEnv.DB.records.publishJobs[0].trigger, "push");
    assert.equal(testEnv.DB.records.publishJobs[0].message, "GitHub push webhook delivery-1");
  } finally {
    cleanup();
  }
});

test("POST /api/webhooks/github rejects bad signatures before creating jobs", async () => {
  const { app, cleanup } = loadWorkerApp();
  const testEnv = env();
  testEnv.DB.records.publishTargets.push(publishTarget());
  const body = JSON.stringify({
    ref: "refs/heads/main",
    after: "1234567890abcdef1234567890abcdef12345678",
    repository: { full_name: "ProDocStore-online/customer-kb" },
  });
  try {
    const response = await app.fetch(
      new Request("https://api.prodocstore.online/api/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "push",
          "X-GitHub-Delivery": "delivery-2",
          "X-Hub-Signature-256": "sha256=bad",
        },
        body,
      }),
      testEnv,
    );
    assert.equal(response.status, 401);
    assert.deepEqual(testEnv.DB.records.publishJobs, []);
  } finally {
    cleanup();
  }
});

test("POST /api/webhooks/github ignores unregistered repositories", async () => {
  const { app, cleanup } = loadWorkerApp();
  const testEnv = env();
  const body = JSON.stringify({
    ref: "refs/heads/main",
    after: "1234567890abcdef1234567890abcdef12345678",
    repository: { full_name: "ProDocStore-online/unknown-kb" },
  });
  try {
    const response = await app.fetch(
      new Request("https://api.prodocstore.online/api/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "push",
          "X-GitHub-Delivery": "delivery-3",
          "X-Hub-Signature-256": await githubSignature("webhook-secret", body),
        },
        body,
      }),
      testEnv,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    assert.equal(data.ignored, "unregistered-repository");
    assert.deepEqual(testEnv.DB.records.publishJobs, []);
  } finally {
    cleanup();
  }
});

test("POST /api/webhooks/github ignores non-default branch pushes", async () => {
  const { app, cleanup } = loadWorkerApp();
  const testEnv = env();
  testEnv.DB.records.publishTargets.push(publishTarget());
  const body = JSON.stringify({
    ref: "refs/heads/draft",
    after: "1234567890abcdef1234567890abcdef12345678",
    repository: { full_name: "ProDocStore-online/customer-kb" },
  });
  try {
    const response = await app.fetch(
      new Request("https://api.prodocstore.online/api/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "push",
          "X-GitHub-Delivery": "delivery-4",
          "X-Hub-Signature-256": await githubSignature("webhook-secret", body),
        },
        body,
      }),
      testEnv,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    assert.equal(data.ignored, "non-default-branch");
    assert.deepEqual(testEnv.DB.records.publishJobs, []);
  } finally {
    cleanup();
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
