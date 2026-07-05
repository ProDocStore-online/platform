// GitHubClient tests. Mocks fetch and a minimal chrome.storage shim so
// the refresh-on-near-expiry branch can run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { GitHubClient } = await import(await bundle("src/lib/github.ts"));

function installFetchMock(mapping) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const method = init.method ?? "GET";
    const fullPath = String(url).replace(/^https:\/\/api\.github\.com/, "");
    // Try exact match first; fall back to path-only (strip query) so tests
    // for endpoints with dynamic query params (e.g. listRecentCommits's
    // since=<ISO>) can register a single key like "GET /repos/x/y/commits".
    const exactKey = `${method} ${fullPath}`;
    const pathOnlyKey = `${method} ${fullPath.split("?")[0]}`;
    const handler = mapping[exactKey] ?? mapping[pathOnlyKey];
    if (!handler) throw new Error(`No mock for ${exactKey}`);
    const { status = 200, body } = handler({ ...init, url: String(url) });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

function installChromeStorage() {
  const store = new Map();
  const original = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      sync: {
        get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
      },
    },
  };
  return { store, restore: () => (globalThis.chrome = original) };
}

const ONE_HOUR = 60 * 60 * 1000;

test("fromSettings: rejects when no GitHub credential is present", async () => {
  await assert.rejects(() => GitHubClient.fromSettings({ adapter: "openai" }), /not connected/i);
});

test("fromSettings: uses PAT when only a PAT is set", async () => {
  const client = await GitHubClient.fromSettings({
    adapter: "openai",
    claude: { apiKey: "", model: "", githubToken: "ghp_test" },
  });
  assert.ok(client);
});

test("fromSettings: uses App token when present and non-expired", async () => {
  const client = await GitHubClient.fromSettings({
    adapter: "openai",
    claude: {
      apiKey: "",
      model: "",
      githubApp: {
        clientId: "Iv23li",
        accessToken: "gho_app",
        refreshToken: "ghr",
        expiresAt: Date.now() + ONE_HOUR,
      },
    },
  });
  assert.ok(client);
});

test("getFile preserves slashes in nested paths (per-segment encoding)", async () => {
  const html = "<p>deep</p>";
  const b64 = Buffer.from(html).toString("base64");
  const { calls, restore } = installFetchMock({
    "GET /repos/foo/bar/contents/docs/clients/acme/sow.html": () => ({
      body: { content: b64, encoding: "base64", sha: "s", path: "docs/clients/acme/sow.html" },
    }),
  });
  try {
    const client = await GitHubClient.fromSettings({
      adapter: "openai",
      claude: { apiKey: "", model: "", githubToken: "ghp_test" },
    });
    const f = await client.getFile("foo", "bar", "docs/clients/acme/sow.html");
    assert.equal(f.content, html);
    // URL must keep slashes - regression test for bug where
    // encodeURIComponent(path) turned "docs/foo" into "docs%2Ffoo".
    assert.ok(calls[0].url.includes("/contents/docs/clients/acme/sow.html"));
    assert.ok(!calls[0].url.includes("%2F"), "slashes must not be percent-encoded");
  } finally {
    restore();
  }
});

test("getFile decodes base64 content", async () => {
  const html = "<html><body>hi</body></html>";
  const b64 = Buffer.from(html).toString("base64");
  const { restore } = installFetchMock({
    "GET /repos/foo/bar/contents/docs/index.html": () => ({
      body: { content: b64, encoding: "base64", sha: "abc123", path: "docs/index.html" },
    }),
  });
  try {
    const client = await GitHubClient.fromSettings({
      adapter: "openai",
      claude: { apiKey: "", model: "", githubToken: "ghp_test" },
    });
    const file = await client.getFile("foo", "bar", "docs/index.html");
    assert.equal(file.content, html);
    assert.equal(file.sha, "abc123");
  } finally {
    restore();
  }
});

test("updateFile base64-encodes UTF-8 content", async () => {
  const { calls, restore } = installFetchMock({
    "PUT /repos/foo/bar/contents/docs/x.html": () => ({
      body: { commit: { sha: "newsha" } },
    }),
  });
  try {
    const client = await GitHubClient.fromSettings({
      adapter: "openai",
      claude: { apiKey: "", model: "", githubToken: "ghp_test" },
    });
    await client.updateFile("foo", "bar", "docs/x.html", "<p>hello</p>", "oldsha", "branch-x", "Update");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(Buffer.from(body.content, "base64").toString("utf8"), "<p>hello</p>");
    assert.equal(body.branch, "branch-x");
    assert.equal(body.sha, "oldsha");
  } finally {
    restore();
  }
});

test("createPullRequest sends title/body/head/base and returns html_url", async () => {
  const { calls, restore } = installFetchMock({
    "POST /repos/foo/bar/pulls": () => ({
      body: { number: 42, url: "api-url", html_url: "https://github.com/foo/bar/pull/42" },
    }),
  });
  try {
    const client = await GitHubClient.fromSettings({
      adapter: "openai",
      claude: { apiKey: "", model: "", githubToken: "ghp_test" },
    });
    const pr = await client.createPullRequest("foo", "bar", "Title", "Body", "head-branch", "main");
    assert.equal(pr.number, 42);
    assert.equal(pr.html_url, "https://github.com/foo/bar/pull/42");
    const sent = JSON.parse(calls[0].init.body);
    assert.deepEqual(sent, { title: "Title", body: "Body", head: "head-branch", base: "main" });
  } finally {
    restore();
  }
});

test("getDefaultBranch returns name + SHA", async () => {
  const { restore } = installFetchMock({
    "GET /repos/foo/bar": () => ({ body: { default_branch: "main" } }),
    "GET /repos/foo/bar/git/ref/heads/main": () => ({ body: { object: { sha: "mainSha" } } }),
  });
  try {
    const client = await GitHubClient.fromSettings({
      adapter: "openai",
      claude: { apiKey: "", model: "", githubToken: "ghp_test" },
    });
    const b = await client.getDefaultBranch("foo", "bar");
    assert.deepEqual(b, { name: "main", sha: "mainSha" });
  } finally {
    restore();
  }
});

test("ensureBranch: returns the branch unchanged when it already exists", async () => {
  let createCalled = false;
  const { restore } = installFetchMock({
    "GET /repos/foo/bar/git/ref/heads/freedocstore-chat": () => ({ body: { object: { sha: "existing" } } }),
    "POST /repos/foo/bar/git/refs": () => { createCalled = true; return { body: {} }; },
  });
  try {
    const client = await GitHubClient.fromSettings({
      adapter: "openai",
      claude: { apiKey: "", model: "", githubToken: "ghp_test" },
    });
    const b = await client.ensureBranch("foo", "bar", "freedocstore-chat");
    assert.equal(b, "freedocstore-chat");
    assert.equal(createCalled, false, "must not create a branch that already exists");
  } finally {
    restore();
  }
});

test("ensureBranch: creates the branch from default HEAD on 404", async () => {
  let created = null;
  const { restore } = installFetchMock({
    "GET /repos/foo/bar/git/ref/heads/freedocstore-chat": () => ({ status: 404, body: { message: "Not Found" } }),
    "GET /repos/foo/bar": () => ({ body: { default_branch: "main" } }),
    "GET /repos/foo/bar/git/ref/heads/main": () => ({ body: { object: { sha: "mainSha" } } }),
    "POST /repos/foo/bar/git/refs": ({ body }) => { created = JSON.parse(body); return { body: {} }; },
  });
  try {
    const client = await GitHubClient.fromSettings({
      adapter: "openai",
      claude: { apiKey: "", model: "", githubToken: "ghp_test" },
    });
    const b = await client.ensureBranch("foo", "bar", "freedocstore-chat");
    assert.equal(b, "freedocstore-chat");
    assert.deepEqual(created, { ref: "refs/heads/freedocstore-chat", sha: "mainSha" });
  } finally {
    restore();
  }
});

test("getRepoPermissions returns push/admin/pull from the repo response", async () => {
  const { restore } = installFetchMock({
    "GET /repos/foo/bar": () => ({
      body: {
        default_branch: "main",
        permissions: { push: true, admin: false, pull: true, maintain: false, triage: true },
      },
    }),
  });
  try {
    const client = await GitHubClient.fromSettings({
      adapter: "openai",
      claude: { apiKey: "", model: "", githubToken: "ghp_test" },
    });
    const p = await client.getRepoPermissions("foo", "bar");
    assert.deepEqual(p, { push: true, admin: false, pull: true });
  } finally {
    restore();
  }
});

test("getRepoPermissions returns null for read-only repos with no permissions block", async () => {
  // Some repos return without a permissions block when the user can only
  // read. Coerce to all-false rather than throwing.
  const { restore } = installFetchMock({
    "GET /repos/foo/bar": () => ({ body: { default_branch: "main" } }),
  });
  try {
    const client = await GitHubClient.fromSettings({
      adapter: "openai",
      claude: { apiKey: "", model: "", githubToken: "ghp_test" },
    });
    const p = await client.getRepoPermissions("foo", "bar");
    assert.deepEqual(p, { push: false, admin: false, pull: false });
  } finally {
    restore();
  }
});

test("getRepoPermissions returns null on 404 instead of throwing", async () => {
  const { restore } = installFetchMock({
    "GET /repos/foo/bar": () => ({ status: 404, body: { message: "Not Found" } }),
  });
  try {
    const client = await GitHubClient.fromSettings({
      adapter: "openai",
      claude: { apiKey: "", model: "", githubToken: "ghp_test" },
    });
    const p = await client.getRepoPermissions("foo", "bar");
    assert.equal(p, null);
  } finally {
    restore();
  }
});

test("listRecentCommits maps the commits API response into RecentCommit[]", async () => {
  // Captures the encoded query string GitHub sees so we can assert
  // path/since/per_page round-trip correctly.
  let captured = null;
  const { restore } = installFetchMock({
    "GET /repos/foo/bar/commits": ({ url }) => {
      captured = url;
      return {
        body: [
          {
            sha: "deadbeef0001",
            commit: {
              author: { name: "Sergey Ivochkin", date: "2026-04-17T10:00:00Z" },
              message: "fix typo on home page\n\nlonger body that should be dropped",
            },
            author: { login: "sergey-ivochkin" },
          },
          {
            // GH-author missing (commit author isn't a linked GH user)
            // - we should fall back to the git author name.
            sha: "deadbeef0002",
            commit: {
              author: { name: "L. Devereux", date: "2026-04-16T15:30:00Z" },
              message: "add Tags section",
            },
            author: null,
          },
        ],
      };
    },
  });
  try {
    const client = await GitHubClient.fromSettings({
      adapter: "openai",
      claude: { apiKey: "", model: "", githubToken: "ghp_test" },
    });
    const commits = await client.listRecentCommits("foo", "bar", "docs", 30, 20);
    assert.equal(commits.length, 2);
    assert.deepEqual(commits[0], {
      sha: "deadbeef0001",
      date: "2026-04-17T10:00:00Z",
      author: "sergey-ivochkin",
      message: "fix typo on home page",
    });
    assert.equal(commits[1].author, "L. Devereux", "falls back to git author name when login is null");
    assert.match(captured, /path=docs/);
    assert.match(captured, /since=20/);
    assert.match(captured, /per_page=20/);
  } finally {
    restore();
  }
});

test("listRepoFiles returns ALL blobs in the tree (not docs-only)", async () => {
  // Real bug context: list_repo_files exists so the agent can verify
  // docs against source code. listDocsHtml's docs/*.html filter would
  // make that impossible. This test pins that listRepoFiles returns
  // EVERY blob path, so a future "let's add a filter for performance"
  // refactor would fail loudly.
  const { restore } = installFetchMock({
    "GET /repos/foo/bar": () => ({ body: { default_branch: "main" } }),
    "GET /repos/foo/bar/git/ref/heads/main": () => ({ body: { object: { sha: "X" } } }),
    "GET /repos/foo/bar/git/trees/main": () => ({
      body: {
        tree: [
          { path: "docs/index.html", type: "blob" },
          { path: "extension/src/adapters/openai.ts", type: "blob" },
          { path: ".github/workflows/deploy-pages.yml", type: "blob" },
          { path: "extension/src", type: "tree" }, // directories must be filtered out
          { path: "README.md", type: "blob" },
        ],
      },
    }),
  });
  try {
    const client = await GitHubClient.fromSettings({
      adapter: "openai",
      claude: { apiKey: "", model: "", githubToken: "ghp_test" },
    });
    const files = await client.listRepoFiles("foo", "bar");
    assert.deepEqual(files.sort(), [
      ".github/workflows/deploy-pages.yml",
      "README.md",
      "docs/index.html",
      "extension/src/adapters/openai.ts",
    ], "directories must be excluded; every blob must be included regardless of path");
  } finally {
    restore();
  }
});

test("listRecentCommits clamps per_page into [1, 100]", async () => {
  let captured = null;
  const { restore } = installFetchMock({
    "GET /repos/foo/bar/commits": ({ url }) => {
      captured = url;
      return { body: [] };
    },
  });
  try {
    const client = await GitHubClient.fromSettings({
      adapter: "openai",
      claude: { apiKey: "", model: "", githubToken: "ghp_test" },
    });
    await client.listRecentCommits("foo", "bar", "docs", 30, 999);
    assert.match(captured, /per_page=100/);
  } finally {
    restore();
  }
});

test("request failure surfaces status + body", async () => {
  const { restore } = installFetchMock({
    "GET /repos/foo/bar": () => ({ status: 404, body: { message: "Not Found" } }),
  });
  try {
    const client = await GitHubClient.fromSettings({
      adapter: "openai",
      claude: { apiKey: "", model: "", githubToken: "ghp_test" },
    });
    await assert.rejects(() => client.getDefaultBranch("foo", "bar"), /404/);
  } finally {
    restore();
  }
});

test("fromSettings: refreshes App token when it's within 60s of expiry", async () => {
  const { restore: restoreStorage } = installChromeStorage();
  const { calls, restore: restoreFetch } = installFetchMock({
    "POST /login/oauth/access_token": () => {
      throw new Error("wrong host - refresh should go to github.com");
    },
  });
  // Replace the refresh endpoint on the non-api.github.com host.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://github.com/login/oauth/access_token")) {
      return new Response(
        JSON.stringify({
          access_token: "gho_refreshed",
          refresh_token: "ghr_new",
          expires_in: 28800,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return origFetch(url, init);
  };

  try {
    const client = await GitHubClient.fromSettings({
      adapter: "openai",
      claude: {
        apiKey: "",
        model: "",
        githubApp: {
          clientId: "Iv23li",
          accessToken: "gho_old",
          refreshToken: "ghr_old",
          expiresAt: Date.now() + 10_000, // within the 60s refresh window
        },
      },
    });
    assert.ok(client);
    // Confirm a refresh was issued.
    assert.ok(calls.some((c) => c.url.startsWith("https://github.com/login/oauth/access_token")));
  } finally {
    globalThis.fetch = origFetch;
    restoreFetch();
    restoreStorage();
  }
});

test("reactive 401 adopts a newer stored token instead of refreshing a dead one", async () => {
  // A long-lived client holds gho_OLD; another client already rotated the token
  // and persisted gho_NEW. On a 401, refreshing with our (now single-use-dead)
  // token would invalid_grant - so we must adopt the stored token and retry,
  // issuing NO network refresh.
  const { store, restore: restoreStorage } = installChromeStorage();
  store.set("docs-chat.settings", {
    claude: {
      apiKey: "", model: "",
      githubApp: { clientId: "Iv23li", accessToken: "gho_NEW", refreshToken: "ghr_new", expiresAt: Date.now() + ONE_HOUR },
    },
  });
  const { restore: restoreFetch } = installFetchMock({
    "GET /repos/foo/bar": ({ headers }) =>
      (headers?.Authorization === "Bearer gho_OLD")
        ? { status: 401, body: { message: "Bad credentials" } }
        : { body: { permissions: { push: true } } },
  });
  const wrapped = globalThis.fetch;
  let refreshHits = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://github.com/login/oauth/access_token")) {
      refreshHits++;
      return new Response(JSON.stringify({ access_token: "gho_X", expires_in: 900 }), { status: 200 });
    }
    return wrapped(url, init);
  };
  try {
    // Not near expiry -> no proactive refresh; the client keeps gho_OLD in memory.
    const client = await GitHubClient.fromSettings({
      adapter: "openai",
      claude: {
        apiKey: "", model: "",
        githubApp: { clientId: "Iv23li", accessToken: "gho_OLD", refreshToken: "ghr_old", expiresAt: Date.now() + ONE_HOUR },
      },
    });
    const perms = await client.getRepoPermissions("foo", "bar");
    assert.deepEqual(perms, { push: true, admin: false, pull: false }, "retry with the adopted token succeeds");
    assert.equal(refreshHits, 0, "must adopt the stored token, not hit the refresh endpoint with a dead one");
  } finally {
    globalThis.fetch = wrapped;
    restoreFetch();
    restoreStorage();
  }
});

test("concurrent fromSettings near expiry issue ONE refresh, not N (single-flight)", async () => {
  // Refresh tokens are single-use: without coordination, N clients built at
  // once near expiry each refresh with the same token and all but one get
  // invalid_grant. The single-flight guard must collapse them to one network
  // refresh whose rotated token every caller shares.
  const { restore: restoreStorage } = installChromeStorage();
  const { calls, restore: restoreFetch } = installFetchMock({});
  const origFetch = globalThis.fetch;
  let refreshHits = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://github.com/login/oauth/access_token")) {
      refreshHits++;
      // Small yield so all N callers reach coordinatedRefresh before this
      // settles - proves they share the in-flight promise, not just luck.
      await new Promise((r) => setTimeout(r, 5));
      return new Response(
        JSON.stringify({ access_token: "gho_new", refresh_token: "ghr_new2", expires_in: 28800 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return origFetch(url, init);
  };

  const settings = {
    adapter: "openai",
    claude: {
      apiKey: "", model: "",
      githubApp: { clientId: "Iv23li", accessToken: "gho_old", refreshToken: "ghr_old", expiresAt: Date.now() + 10_000 },
    },
  };
  try {
    const clients = await Promise.all(
      Array.from({ length: 5 }, () => GitHubClient.fromSettings(settings)),
    );
    assert.equal(clients.length, 5);
    assert.equal(refreshHits, 1, "5 concurrent refreshes must collapse to a single network call");
  } finally {
    globalThis.fetch = origFetch;
    restoreFetch();
    restoreStorage();
    void calls;
  }
});
