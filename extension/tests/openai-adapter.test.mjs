// Integration tests for the OpenAI adapter. Mocks fetch to cover the
// branching that lib-level tests don't reach: commit-mode (PR vs
// direct push), the clarification escape hatch, and the attachment
// shape callers depend on.
//
// We intentionally do NOT mock the GitHubClient or the openai lib -
// the whole point is to exercise the adapter as it runs in the
// service worker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

// Minimal chrome.storage.session mock - the adapter saves PendingProposal
// objects there as part of the new preview flow. crypto.randomUUID is
// already global in modern Node.
function installChromeMock() {
  const store = new Map();
  const local = new Map();
  const area = (m) => ({
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) m.set(k, v); },
    get: async (key) => {
      if (key == null) return Object.fromEntries(m);
      const k = typeof key === "string" ? key : Array.isArray(key) ? key[0] : Object.keys(key)[0];
      const v = m.get(k);
      return v === undefined ? {} : { [k]: v };
    },
    remove: async (key) => {
      const k = typeof key === "string" ? key : key[0];
      m.delete(k);
    },
  });
  globalThis.chrome = {
    // session: PendingProposal storage. local: the task store (lib/tasks.ts,
    // exercised now that buildEditProposalPreview opens a board task).
    storage: { session: area(store), local: area(local) },
  };
  return store;
}

installChromeMock();

// Engine helpers live in ./proposal-engine now but are re-exported from the
// adapter (backward-compat barrel), so a single bundle shares cache state -
// which the cache-invalidation regression test below depends on.
const { openaiAdapter, applyPendingProposal, formatActivityBlock, formatMemoryBlock, mergeMemoryEntry, MEMORY_PATH } = await import(await bundle("src/adapters/openai.ts"));
const { loadPendingProposal } = await import(await bundle("src/lib/proposals.ts"));
const { getTask, listTasks } = await import(await bundle("src/lib/tasks.ts"));

const HTML = "<html><body><h1>Hello</h1></body></html>";
const NEW_HTML = "<html><body><h1>Hello world</h1></body></html>";
const SOURCE_PATH = "docs/index.html";

const CONTEXT = {
  url: "https://docs.example.com/",
  title: "Hello",
  sourcePath: SOURCE_PATH,
  repo: { owner: "FreeDocStore", name: "freedocstore" },
  html: HTML,
  text: "Hello",
  navConfig: null,
};

function baseSettings(commitMode) {
  return {
    adapter: "openai",
    // Edit-mode tests need to explicitly opt in - the new default is "read".
    mode: "edit",
    commitMode,
    openai: { apiKey: "sk-test", model: "gpt-5.4" },
    // PAT auth path - no token refresh logic, no chrome.storage needed.
    claude: { apiKey: "", model: "claude-sonnet-4-6", githubToken: "ghp_test" },
  };
}

/** Install a fetch mock that dispatches by URL pattern. */
function installFetchMock(handlers) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET", body: init?.body });
    for (const [pattern, handler] of handlers) {
      if (pattern instanceof RegExp ? pattern.test(u) : u.includes(pattern)) {
        const r = handler({ url: u, init });
        const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
        return new Response(body, {
          status: r.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    throw new Error(`No mock for ${u}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

function openaiEditFileResponse() {
  return {
    body: {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                function: {
                  name: "edit_file",
                  arguments: JSON.stringify({
                    edits: [{ find: "<h1>Hello</h1>", replace: "<h1>Hello world</h1>" }],
                    summary: "Greet the world",
                    rationale: "Make the greeting more inclusive",
                  }),
                },
              },
            ],
          },
        },
      ],
    },
  };
}

function openaiClarificationResponse() {
  return {
    body: {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                function: {
                  name: "ask_clarification",
                  arguments: JSON.stringify({
                    question: "Which heading would you like updated?",
                    why: "The prompt 'fix the title' could mean <title> or <h1>.",
                  }),
                },
              },
            ],
          },
        },
      ],
    },
  };
}

function openaiCreatePageResponse() {
  return {
    body: {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                function: {
                  name: "create_page",
                  arguments: JSON.stringify({
                    path: "docs/security.html",
                    content: "<html><body><h1>Security</h1><p>Our security posture.</p></body></html>",
                    summary: "Add security page",
                  }),
                },
              },
            ],
          },
        },
      ],
    },
  };
}

test("openai adapter: create_page -> new-file preview then apply CREATES with no sha", async () => {
  const handlers = [
    ["openai.com", () => openaiCreatePageResponse()],
    [/repos\/[^/]+\/[^/]+$/, () => ({ body: { default_branch: "main" } })],
    [/git\/ref\/heads\//, () => ({ body: { object: { sha: "basesha" } } })],
    // current page fetched for grounding (exists)
    [/\/contents\/docs\/index\.html/, () => ({ body: { content: b64(HTML), sha: "filesha", path: SOURCE_PATH, encoding: "base64" } })],
    // the NEW page: only a PUT should ever hit this (never a GET/fetch)
    [/\/contents\/docs\/security\.html/, () => ({ body: { commit: { sha: "newsha", html_url: "https://github.com/x/y/commit/newsha" } } })],
  ];
  const { calls, restore } = installFetchMock(handlers);
  try {
    const reply = await openaiAdapter.chat("add a security page", CONTEXT, [], baseSettings("direct"));
    assert.equal(reply.attachment?.kind, "preview", "create_page should produce a preview");
    const proposal = reply.attachment.data;
    assert.equal(proposal.kind, "edit");
    assert.equal(proposal.path, "docs/security.html");
    assert.equal(proposal.fileSha, null, "new page has no base sha");
    assert.match(proposal.editedContent, /<h1>Security<\/h1>/);

    // The whole point: we must NOT fetch the nonexistent new page (the 404 bug),
    // and preview must not commit.
    const methods = calls.map((c) => `${c.method} ${c.url.replace(/.*api\.github\.com/, "")}`);
    assert.equal(methods.filter((m) => /GET .*security\.html/.test(m)).length, 0, "must NOT fetch the new page");
    assert.equal(methods.filter((m) => m.startsWith("PUT ")).length, 0, "no commit on preview");

    // Apply (direct) creates the file: PUT to the new path with NO sha.
    const stored = await loadPendingProposal(proposal.proposalId);
    const { GitHubClient } = await import(await bundle("src/lib/github.ts"));
    const gh = await GitHubClient.fromSettings(baseSettings("direct"));
    const result = await applyPendingProposal(stored, gh);
    assert.match(result.content, /Pushed/);
    const put = calls.find((c) => c.method === "PUT");
    assert.ok(put, "apply should PUT the new file");
    assert.match(put.url, /docs\/security\.html/);
    assert.equal(JSON.parse(put.body).sha, undefined, "create must omit sha so GitHub creates rather than updates");

    // A new page must also be a trackable board task that advances on apply -
    // that's what makes "add a page" show up and progress like any other edit.
    const task = await getTask(proposal.taskId);
    assert.equal(task.sourcePath, "docs/security.html", "task targets the new page");
    assert.equal(task.status, "deployed", "create_page apply advances the task to deployed");
    // HTML site -> the menu tip points at the nav (docs/nav.json / update_nav_config).
    assert.match(result.content, /Pushed/);
    assert.match(reply.content, /add .*to the nav/i, "html page -> nav.json menu tip");
  } finally {
    restore();
  }
});

test("create_page for a .md page gives a Markdown menu tip, not a nav.json dead end", async () => {
  // The user's real case: docs-chat-test is a Markdown (Zensical/MkDocs) site.
  // update_nav_config edits docs/nav.json, which those generators don't use, so
  // the tip must not send the user there.
  const handlers = [
    ["openai.com", () => ({ body: { choices: [{ message: { content: null, tool_calls: [
      { function: { name: "create_page", arguments: JSON.stringify({
        path: "docs/credits.md",
        content: "# Credits\n\nWith thanks to Ada Vega and Milo Cassini.",
        summary: "Add credits page with fictional celebrity names",
      }) } },
    ] } }] } })],
    [/repos\/[^/]+\/[^/]+$/, () => ({ body: { default_branch: "main" } })],
    [/git\/ref\/heads\//, () => ({ body: { object: { sha: "basesha" } } })],
    [/\/contents\/docs\/index\.html/, () => ({ body: { content: b64(HTML), sha: "filesha", path: SOURCE_PATH, encoding: "base64" } })],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const reply = await openaiAdapter.chat("add a credits page, make up celeb names", CONTEXT, [], baseSettings("pr"));
    assert.equal(reply.attachment?.kind, "preview");
    assert.equal(reply.attachment.data.path, "docs/credits.md");
    assert.match(reply.content, /Markdown site/i, "md page -> markdown-appropriate menu tip");
  } finally {
    restore();
  }
});

test("editing a page whose source 404s returns a friendly message, not a raw GitHub error", async () => {
  // The exact failure the user kept hitting: on a page (e.g. /credits/) whose
  // source doesn't exist in the repo, the UPFRONT grounding fetch 404s. That
  // must not surface as "Error: GitHub API GET ... failed: 404". The model
  // still runs (so it CAN create the page - see the next test); if it
  // stubbornly tries edit_file, buildEditProposalPreview catches the 404 and
  // returns friendly guidance instead of a raw error.
  const ctx = { ...CONTEXT, sourcePath: "docs/credits.md", url: "https://docs.example.com/credits/", title: "Credits" };
  const handlers = [
    ["openai.com", () => openaiEditFileResponse()],
    [/repos\/[^/]+\/[^/]+$/, () => ({ body: { default_branch: "main" } })],
    // Every extension fetchSourceFile tries for docs/credits.* is missing.
    [/\/contents\/docs\/credits\./, () => ({ status: 404, body: { message: "Not Found", status: "404" } })],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const reply = await openaiAdapter.chat("push", ctx, [], baseSettings("direct"));
    assert.match(reply.content, /doesn't exist yet/i);
    assert.match(reply.content, /docs\/credits\.md/);
    assert.doesNotMatch(reply.content, /^Error:/, "must not leak the raw GitHub 404");
    assert.equal(reply.attachment, undefined, "no proposal from a page with no source");
  } finally {
    restore();
  }
});

test("on a missing current page, create_page runs and produces a create proposal", async () => {
  // Regression: the friendly-404 handler used to SHORT-CIRCUIT before the
  // model ran, so "create the page and push it" on a not-yet-created page
  // could never fire create_page. Now the upfront 404 sets currentPageMissing
  // (file=null) and the model runs with a note steering it to create_page.
  const ctx = { ...CONTEXT, sourcePath: "docs/credits.md", url: "https://docs.example.com/credits/", title: "Credits" };
  const createResp = {
    body: {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                function: {
                  name: "create_page",
                  arguments: JSON.stringify({
                    path: "docs/credits.md",
                    content: "# Credits\n\nThanks to everyone who contributed.\n",
                    summary: "Add credits page",
                  }),
                },
              },
            ],
          },
        },
      ],
    },
  };
  const handlers = [
    ["openai.com", () => createResp],
    [/repos\/[^/]+\/[^/]+$/, () => ({ body: { default_branch: "main" } })],
    // Grounding fetch for the current page 404s (page not created yet).
    [/\/contents\/docs\/credits\./, () => ({ status: 404, body: { message: "Not Found", status: "404" } })],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const reply = await openaiAdapter.chat("create the page and push it", ctx, [], baseSettings("direct"));
    assert.doesNotMatch(reply.content ?? "", /^Error:/, "must not leak a raw GitHub 404");
    assert.equal(reply.attachment?.kind, "preview", "create_page should produce a preview");
    // A created page is a write proposal (kind "edit") with no base sha.
    assert.equal(reply.attachment.data.path, "docs/credits.md");
    assert.equal(reply.attachment.data.fileSha, null, "new page has no base sha");
    assert.match(reply.attachment.data.editedContent, /Credits/);
  } finally {
    restore();
  }
});

const githubHandlers = (extra = []) => [
  ["openai.com", () => openaiEditFileResponse()],
  // GET /repos/{owner}/{repo}
  [/repos\/[^/]+\/[^/]+$/, () => ({ body: { default_branch: "main" } })],
  // GET /repos/.../git/ref/heads/main
  [/git\/ref\/heads\//, () => ({ body: { object: { sha: "basesha" } } })],
  // GET (read source) and PUT (commit) both target /contents/docs/index.html.
  // encodePath preserves slashes (it only encodes path segments), so the URL
  // contains literal '/' between docs and index.html.
  [
    /\/contents\/docs\/index\.html/,
    ({ init }) => {
      if (!init || init.method === "GET" || init.method === undefined) {
        return { body: { content: b64(HTML), sha: "filesha", path: SOURCE_PATH, encoding: "base64" } };
      }
      // PUT to update the file
      return { body: { commit: { sha: "newcommitsha", html_url: "https://github.com/x/y/commit/newcommitsha" } } };
    },
  ],
  // POST /repos/.../git/refs (createBranch)
  [/git\/refs$/, () => ({ body: { ref: "refs/heads/feature" } })],
  // POST /repos/.../pulls (createPullRequest)
  [/\/pulls$/, () => ({ body: { number: 42, url: "api", html_url: "https://github.com/x/y/pull/42" } })],
  ...extra,
];

test("openai adapter: PR mode - chat() returns a preview, no commit yet", async () => {
  const { calls, restore } = installFetchMock(githubHandlers());
  try {
    const reply = await openaiAdapter.chat("greet the world", CONTEXT, [], baseSettings("pr"));
    assert.equal(reply.role, "assistant");
    assert.equal(reply.attachment?.kind, "preview", "edit_file should produce a preview, not commit");
    const proposal = reply.attachment.data;
    assert.equal(proposal.kind, "edit");
    assert.equal(proposal.path, SOURCE_PATH);
    assert.equal(proposal.commitMode, "pr");
    assert.equal(proposal.outcomes.length, 1);
    assert.ok(proposal.outcomes[0].applied);

    // Preview must NOT have created a branch, written the file, or opened a PR.
    const methods = calls.map((c) => `${c.method} ${c.url.replace(/.*api\.github\.com/, "")}`);
    assert.equal(methods.filter((m) => /POST .*\/git\/refs$/.test(m)).length, 0, "no createBranch on preview");
    assert.equal(methods.filter((m) => m.startsWith("PUT ")).length, 0, "no updateFile on preview");
    assert.equal(methods.filter((m) => /POST .*\/pulls$/.test(m)).length, 0, "no createPullRequest on preview");
  } finally {
    restore();
  }
});

test("openai adapter: PR mode - applyPendingProposal opens the PR using stored proposal", async () => {
  const { calls, restore } = installFetchMock(githubHandlers());
  try {
    const reply = await openaiAdapter.chat("greet the world", CONTEXT, [], baseSettings("pr"));
    const proposalId = reply.attachment.data.proposalId;
    const stored = await loadPendingProposal(proposalId);
    assert.ok(stored, "expected proposal to be in session storage");

    const { GitHubClient } = await import(await bundle("src/lib/github.ts"));
    const gh = await GitHubClient.fromSettings(baseSettings("pr"));

    const result = await applyPendingProposal(stored, gh);
    assert.match(result.content, /PR opened/);
    assert.equal(result.attachment?.kind, "pr");
    assert.equal(result.attachment.data.number, 42);

    const methods = calls.map((c) => `${c.method} ${c.url.replace(/.*api\.github\.com/, "")}`);
    assert.ok(methods.some((m) => /POST .*\/git\/refs$/.test(m)), "apply should createBranch");
    assert.ok(methods.some((m) => m.startsWith("PUT ")), "apply should updateFile");
    assert.ok(methods.some((m) => /POST .*\/pulls$/.test(m)), "apply should createPullRequest");
    const putCall = calls.find((c) => c.method === "PUT");
    const putBody = JSON.parse(putCall.body);
    assert.match(putBody.branch, /^docs-chat\//, "PR mode pushes to feature branch");

    const afterApply = await loadPendingProposal(proposalId);
    assert.equal(afterApply, null, "proposal should be removed after successful apply");
  } finally {
    restore();
  }
});

test("openai adapter: direct mode - chat() returns a preview tagged commitMode=direct, no commit yet", async () => {
  const { calls, restore } = installFetchMock(githubHandlers());
  try {
    const reply = await openaiAdapter.chat("greet the world", CONTEXT, [], baseSettings("direct"));
    assert.equal(reply.attachment?.kind, "preview");
    assert.equal(reply.attachment.data.commitMode, "direct");
    const methods = calls.map((c) => `${c.method} ${c.url.replace(/.*api\.github\.com/, "")}`);
    assert.equal(methods.filter((m) => m.startsWith("PUT ")).length, 0, "no updateFile on preview");
  } finally {
    restore();
  }
});

test("openai adapter: direct mode - applyPendingProposal pushes to main, no PR or branch", async () => {
  const { calls, restore } = installFetchMock(githubHandlers());
  try {
    const reply = await openaiAdapter.chat("greet the world", CONTEXT, [], baseSettings("direct"));
    const proposalId = reply.attachment.data.proposalId;
    const stored = await loadPendingProposal(proposalId);
    const { GitHubClient } = await import(await bundle("src/lib/github.ts"));
    const gh = await GitHubClient.fromSettings(baseSettings("direct"));
    const result = await applyPendingProposal(stored, gh);
    assert.match(result.content, /Pushed to main/);
    assert.match(result.content, /commit\/newcommitsha/);
    assert.equal(result.attachment?.kind, "commit", "direct push must label attachment as commit, not pr");
    assert.equal(result.attachment.data.sha, "newcommitsha");

    const methods = calls.map((c) => `${c.method} ${c.url.replace(/.*api\.github\.com/, "")}`);
    assert.equal(
      methods.filter((m) => /POST .*\/git\/refs$/.test(m)).length,
      0,
      "direct mode must NOT createBranch",
    );
    assert.equal(
      methods.filter((m) => /POST .*\/pulls$/.test(m)).length,
      0,
      "direct mode must NOT openPullRequest",
    );

    const putCall = calls.find((c) => c.method === "PUT");
    const putBody = JSON.parse(putCall.body);
    assert.equal(putBody.branch, "main", "direct mode must commit to default branch");
  } finally {
    restore();
  }
});

test("openai adapter: Apply advances the board task status (proposed -> deployed/in_review)", async () => {
  const { GitHubClient } = await import(await bundle("src/lib/github.ts"));
  // Direct push -> deployed.
  {
    const { restore } = installFetchMock(githubHandlers());
    try {
      const reply = await openaiAdapter.chat("greet the world", CONTEXT, [], baseSettings("direct"));
      const { proposalId, taskId } = reply.attachment.data;
      assert.ok(taskId, "proposal must carry a taskId or the status can never advance");
      assert.equal((await getTask(taskId)).status, "proposed", "task starts proposed");
      const gh = await GitHubClient.fromSettings(baseSettings("direct"));
      await applyPendingProposal(await loadPendingProposal(proposalId), gh);
      const after = await getTask(taskId);
      assert.equal(after.status, "deployed", "direct push must move the task to deployed");
      assert.equal(after.commit?.sha, "newcommitsha", "commit link recorded on the task");
    } finally {
      restore();
    }
  }
  // PR mode -> in_review.
  {
    const { restore } = installFetchMock(githubHandlers());
    try {
      const reply = await openaiAdapter.chat("greet the world again", CONTEXT, [], baseSettings("pr"));
      const { proposalId, taskId } = reply.attachment.data;
      const gh = await GitHubClient.fromSettings(baseSettings("pr"));
      await applyPendingProposal(await loadPendingProposal(proposalId), gh);
      const after = await getTask(taskId);
      assert.equal(after.status, "in_review", "PR mode must move the task to in_review");
      assert.equal(after.pr?.number, 42, "PR link recorded on the task");
    } finally {
      restore();
    }
  }
});

test("new conversation: a clarification reply does NOT create a board task", async () => {
  // Starting a new edit mints a taskId client-side; the FIRST turn is often a
  // clarification (no proposal yet). That must not spawn a phantom board card.
  const handlers = [
    ["openai.com", () => openaiClarificationResponse()],
    [/repos\/[^/]+\/[^/]+$/, () => ({ body: { default_branch: "main" } })],
    [/git\/ref\/heads\//, () => ({ body: { object: { sha: "basesha" } } })],
    [/\/contents\/docs\/index\.html/, () => ({ body: { content: b64(HTML), sha: "filesha", path: SOURCE_PATH, encoding: "base64" } })],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const taskId = "convo-clar-1";
    const reply = await openaiAdapter.chat("add a page", CONTEXT, [], baseSettings("direct"), { taskId });
    assert.match(reply.content, /which heading/i, "clarification question surfaced");
    assert.equal(reply.attachment, undefined, "clarification carries no preview");
    assert.equal(await getTask(taskId), null, "no task until an actual proposal");
  } finally {
    restore();
  }
});

test("conversation lifecycle: follow-up edit revises the SAME task, not a new one", async () => {
  const { GitHubClient } = await import(await bundle("src/lib/github.ts"));
  const taskId = "convo-life-1";

  // Turn 1: propose an edit on a brand-new edit thread (client-minted taskId).
  {
    const { restore } = installFetchMock(githubHandlers());
    try {
      const reply = await openaiAdapter.chat("greet the world", CONTEXT, [], baseSettings("direct"), { taskId });
      const t = await getTask(taskId);
      assert.equal(t.id, taskId, "first proposal creates the task under the minted id");
      assert.equal(t.status, "proposed");
      assert.equal(t.conversation.length, 2, "user + assistant turn recorded");
      // Apply it -> deployed.
      const gh = await GitHubClient.fromSettings(baseSettings("direct"));
      await applyPendingProposal(await loadPendingProposal(reply.attachment.data.proposalId), gh);
    } finally {
      restore();
    }
  }

  const afterApply = await getTask(taskId);
  assert.equal(afterApply.status, "deployed");
  const createdAt = afterApply.createdAt;

  // Turn 2: another edit on the SAME thread (same taskId). Must reuse the task.
  {
    const { restore } = installFetchMock(githubHandlers());
    try {
      const before = (await getTask(taskId)).conversation.length;
      await openaiAdapter.chat("greet the world again", CONTEXT, [], baseSettings("direct"), { taskId });
      const t = await getTask(taskId);
      assert.equal(t.id, taskId, "same task id - not a duplicate card");
      assert.equal(t.createdAt, createdAt, "createdAt preserved across the follow-up");
      assert.equal(t.status, "proposed", "re-opened as proposed for the new change");
      assert.ok(t.conversation.length > before, "the follow-up turn is appended, not replaced");
      // Exactly one task with this id exists in the store.
      const all = await listTasks();
      assert.equal(all.filter((x) => x.id === taskId).length, 1, "no duplicate task rows");
    } finally {
      restore();
    }
  }
});

test("openai adapter: cross-page edit - edit_file with explicit path re-fetches that file", async () => {
  // Model proposes editing docs/about.html while user is on
  // docs/index.html. Adapter must fetch about.html (not the upfront
  // index.html), apply edits to it, and tag the proposal with the
  // about.html path.
  const ABOUT_HTML = "<html><body><h2>About us</h2></body></html>";
  let aboutFetched = false;
  const handlers = [
    [
      "openai.com",
      () => ({
        body: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    function: {
                      name: "edit_file",
                      arguments: JSON.stringify({
                        path: "docs/about.html",
                        edits: [{ find: "<h2>About us</h2>", replace: "<h2>About</h2>" }],
                        summary: "Tighten about heading",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    ],
    [/repos\/[^/]+\/[^/]+$/, () => ({ body: { default_branch: "main" } })],
    // Upfront index.html fetch (current page).
    [
      /\/contents\/docs\/index\.html/,
      () => ({ body: { content: b64(HTML), sha: "indexsha", path: "docs/index.html", encoding: "base64" } }),
    ],
    // Cross-page about.html fetch (target of edit_file).
    [
      /\/contents\/docs\/about\.html/,
      () => {
        aboutFetched = true;
        return { body: { content: b64(ABOUT_HTML), sha: "aboutsha", path: "docs/about.html", encoding: "base64" } };
      },
    ],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const reply = await openaiAdapter.chat("fix the about heading", CONTEXT, [], baseSettings("pr"));
    assert.equal(reply.attachment?.kind, "preview");
    const proposal = reply.attachment.data;
    assert.equal(proposal.path, "docs/about.html", "preview must target the requested path");
    assert.equal(proposal.fileSha, "aboutsha", "fileSha must be the about.html sha, not index.html");
    assert.ok(aboutFetched, "about.html should have been re-fetched");
    assert.ok(proposal.outcomes[0].applied);
    assert.match(proposal.editedContent, /<h2>About<\/h2>/);
  } finally {
    restore();
  }
});

test("openai adapter: cross-page edit - rejects malformed paths without fetching", async () => {
  const handlers = [
    [
      "openai.com",
      () => ({
        body: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    function: {
                      name: "edit_file",
                      arguments: JSON.stringify({
                        path: "../../etc/passwd",
                        edits: [{ find: "x", replace: "y" }],
                        summary: "evil",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    ],
    [/repos\/[^/]+\/[^/]+$/, () => ({ body: { default_branch: "main" } })],
    [
      /\/contents\/docs\/index\.html/,
      () => ({ body: { content: b64(HTML), sha: "filesha", path: SOURCE_PATH, encoding: "base64" } }),
    ],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const reply = await openaiAdapter.chat("test", CONTEXT, [], baseSettings("pr"));
    assert.match(reply.content, /Refusing to edit/);
    assert.equal(reply.attachment, undefined, "no preview for rejected path");
  } finally {
    restore();
  }
});

test("openai adapter: edit mode passes prior chat history to the model (no amnesia)", async () => {
  // Regression: edit mode used to ignore the history arg entirely. After
  // a "switched" follow-up to "switch to Edit mode", the model would
  // reply asking for clarification because it had no idea what was being
  // switched. Verifies the OpenAI request actually carries the prior
  // turns.
  let capturedMessages = null;
  const handlers = githubHandlers();
  handlers[0] = ["openai.com", ({ init }) => {
    capturedMessages = JSON.parse(init.body).messages;
    return openaiEditFileResponse();
  }];
  const { restore } = installFetchMock(handlers);
  try {
    const history = [
      { role: "user", content: "add year to the footer" },
      { role: "assistant", content: "You need to switch to Edit mode in the side panel header to make that change." },
    ];
    await openaiAdapter.chat("switched", CONTEXT, history, baseSettings("pr"));
    assert.ok(capturedMessages, "expected the OpenAI call to be captured");
    // First message is the system prompt; the prior turns must appear
    // before the current grounded user message (which is always last).
    assert.ok(capturedMessages.length >= 4, `expected >=4 messages, got ${capturedMessages.length}`);
    assert.equal(capturedMessages[0].role, "system");
    assert.equal(capturedMessages[1].role, "user");
    assert.match(capturedMessages[1].content, /add year to the footer/);
    assert.equal(capturedMessages[2].role, "assistant");
    assert.match(capturedMessages[2].content, /switch to Edit mode/);
    // The current grounded user message is always last - it carries the
    // file content and the new prompt.
    const last = capturedMessages[capturedMessages.length - 1];
    assert.equal(last.role, "user");
    assert.match(last.content, /Requested change:\s*switched/);
  } finally {
    restore();
  }
});

test("openai adapter: read mode - answers question, ZERO github calls, no auth needed", async () => {
  // Read mode must not require GitHub auth - omit the github token entirely
  // to prove it. Mock OpenAI to return a plain text answer.
  const settings = {
    adapter: "openai",
    mode: "read",
    openai: { apiKey: "sk-test", model: "gpt-5.4" },
    claude: { apiKey: "", model: "claude-sonnet-4-6" }, // no githubToken, no githubApp
  };

  const handlers = [
    [
      "openai.com",
      ({ init }) => {
        const sent = JSON.parse(init.body);
        // Read mode now offers list_pages / read_page / ask_clarification
        // so the model can ground answers in other pages. The write tools
        // (edit_file, update_nav_config) must NOT be offered.
        const toolNames = (sent.tools ?? []).map((t) => t.function.name);
        if (toolNames.includes("edit_file") || toolNames.includes("update_nav_config")) {
          throw new Error("read mode must not offer write tools");
        }
        return {
          body: {
            choices: [
              { message: { content: "This page describes the docs playbook architecture." } },
            ],
          },
        };
      },
    ],
  ];
  const { calls, restore } = installFetchMock(handlers);
  try {
    const reply = await openaiAdapter.chat("what is this page about?", CONTEXT, [], settings);
    assert.equal(reply.role, "assistant");
    assert.match(reply.content, /docs playbook architecture/);
    assert.equal(reply.attachment, undefined);

    // Critical: read mode must NEVER touch GitHub.
    const githubCalls = calls.filter((c) => c.url.includes("api.github.com"));
    assert.equal(githubCalls.length, 0, "read mode must not call GitHub");
  } finally {
    restore();
  }
});

test("openai adapter: read mode does NOT require GitHub auth (configError returns null)", () => {
  const err = openaiAdapter.configError({
    adapter: "openai",
    mode: "read",
    openai: { apiKey: "sk-test", model: "gpt-5.4" },
    claude: { apiKey: "", model: "claude-sonnet-4-6" }, // no token at all
  });
  assert.equal(err, null, "read mode should not block on missing GitHub auth");
});

test("openai adapter: edit mode requires GitHub auth (explicit opt-in)", () => {
  const err = openaiAdapter.configError({
    adapter: "openai",
    mode: "edit",
    openai: { apiKey: "sk-test", model: "gpt-5.4" },
    claude: { apiKey: "", model: "claude-sonnet-4-6" },
  });
  assert.match(err ?? "", /GitHub not connected/);
});

test("openai adapter: when mode is unset, configError treats it as edit (auth required)", () => {
  // The default is read at the Settings level, but configError gets called
  // before defaults are applied if mode is absent on the patch. Behaviour:
  // unset mode => fall through to edit-mode auth check, so we don't silently
  // let an unconfigured user try to commit.
  const err = openaiAdapter.configError({
    adapter: "openai",
    // mode omitted
    openai: { apiKey: "sk-test", model: "gpt-5.4" },
    claude: { apiKey: "", model: "claude-sonnet-4-6" },
  });
  assert.match(err ?? "", /GitHub not connected/);
});

test("openai adapter: clarification - returns question, opens no branch and no PR", async () => {
  const handlers = githubHandlers();
  // Override the OpenAI handler to return ask_clarification.
  handlers[0] = ["openai.com", () => openaiClarificationResponse()];
  const { calls, restore } = installFetchMock(handlers);
  try {
    const reply = await openaiAdapter.chat("test", CONTEXT, [], baseSettings("pr"));
    assert.equal(reply.role, "assistant");
    assert.match(reply.content, /Which heading/);
    assert.equal(reply.attachment, undefined, "clarification must not carry an attachment");

    // Only the source-file fetch + the OpenAI call should have happened.
    // No branch creation, no file write, no PR open.
    const methods = calls.map((c) => `${c.method} ${c.url}`);
    assert.equal(
      methods.filter((m) => m.includes("/git/refs")).length, 0,
      "clarification must NOT createBranch",
    );
    assert.equal(
      methods.filter((m) => m.startsWith("PUT ")).length, 0,
      "clarification must NOT updateFile",
    );
    assert.equal(
      methods.filter((m) => /\/pulls$/.test(m)).length, 0,
      "clarification must NOT openPullRequest",
    );
  } finally {
    restore();
  }
});

// ── activity log (Phase 1 of long-term memory) ──────────────────────

test("formatActivityBlock: empty list -> empty string (no header injected)", () => {
  assert.equal(formatActivityBlock([]), "");
});

test("formatActivityBlock: renders one line per commit with date prefix", () => {
  const out = formatActivityBlock([
    { sha: "a", date: "2026-04-17T10:00:00Z", author: "sergey-ivochkin", message: "fix typo" },
    { sha: "b", date: "2026-04-16T15:30:00Z", author: "L. Devereux", message: "add Tags section" },
  ]);
  assert.match(out, /Recent docs activity/i);
  assert.match(out, /2026-04-17 sergey-ivochkin: "fix typo"/);
  assert.match(out, /2026-04-16 L\. Devereux: "add Tags section"/);
});

test("openai adapter: activity log is injected into the system prompt", async () => {
  // Capture the OpenAI request body to assert the activity block landed
  // in the system message. Mocks the commits API to return two recent
  // commits, then makes the model return an empty plain reply so the
  // chat call resolves without going further.
  let capturedSystem = null;
  const handlers = [
    [
      "openai.com",
      ({ init }) => {
        capturedSystem = JSON.parse(init.body).messages[0].content;
        return { body: { choices: [{ message: { content: "ok" } }] } };
      },
    ],
    // commits API
    [
      /\/repos\/[^/]+\/[^/]+\/commits/,
      () => ({
        body: [
          {
            sha: "x1",
            commit: { author: { name: "Sergey", date: "2026-04-17T10:00:00Z" }, message: "fix typo" },
            author: { login: "sergey-ivochkin" },
          },
          {
            sha: "x2",
            commit: { author: { name: "L. Devereux", date: "2026-04-16T15:30:00Z" }, message: "add Tags section" },
            author: null,
          },
        ],
      }),
    ],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const settings = {
      adapter: "openai",
      mode: "read", // read mode to skip the upfront getFile + commit branch
      openai: { apiKey: "sk-test", model: "gpt-5.4" },
      claude: { apiKey: "", model: "claude-sonnet-4-6", githubToken: "ghp_test" },
    };
    const reply = await openaiAdapter.chat("hi", CONTEXT, [], settings);
    assert.equal(reply.role, "assistant");
    assert.ok(capturedSystem, "expected the OpenAI request to be captured");
    assert.match(capturedSystem, /Recent docs activity/);
    assert.match(capturedSystem, /sergey-ivochkin.*fix typo/);
    assert.match(capturedSystem, /L\. Devereux.*Tags section/);
  } finally {
    restore();
  }
});

test("openai adapter: no GH auth -> no activity block (graceful)", async () => {
  // No githubToken / githubApp - tryBuildGitHubClient returns null, so
  // the activity log is skipped. The chat should still complete with
  // just the role prompt.
  let capturedSystem = null;
  const handlers = [
    [
      "openai.com",
      ({ init }) => {
        capturedSystem = JSON.parse(init.body).messages[0].content;
        return { body: { choices: [{ message: { content: "ok" } }] } };
      },
    ],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const settings = {
      adapter: "openai",
      mode: "read",
      openai: { apiKey: "sk-test", model: "gpt-5.4" },
      claude: { apiKey: "", model: "claude-sonnet-4-6" }, // no GH credentials
    };
    await openaiAdapter.chat("hi", CONTEXT, [], settings);
    assert.ok(capturedSystem, "expected the OpenAI request to be captured");
    assert.ok(!/Recent docs activity/.test(capturedSystem),
      "activity block must not appear without GH auth");
  } finally {
    restore();
  }
});

// ── shared memory (Phase 2A: read MEMORY.md) ────────────────────────

test("formatMemoryBlock: empty / null content -> empty string", () => {
  assert.equal(formatMemoryBlock(null), "");
  assert.equal(formatMemoryBlock(""), "");
  assert.equal(formatMemoryBlock("   \n\n  "), "");
});

test("formatMemoryBlock: small content rendered with header", () => {
  const out = formatMemoryBlock("## Style\n- Use sentence case in headings.");
  assert.match(out, /Shared team memory.*\.docs-chat\/MEMORY\.md/);
  assert.match(out, /## Style/);
  assert.match(out, /sentence case/);
});

test("formatMemoryBlock: caps at 200 lines", () => {
  const big = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
  const out = formatMemoryBlock(big);
  assert.ok(out.includes("line 0"));
  assert.ok(out.includes("line 199"));
  assert.ok(!out.includes("line 200"), "line 200 must be cut by the line cap");
});

test("formatMemoryBlock: caps at 25KB", () => {
  const huge = "x".repeat(40_000);
  const out = formatMemoryBlock(huge);
  assert.ok(out.includes("[...memory truncated at 25KB...]"));
  assert.ok(out.length < huge.length, "output must be smaller than input");
});

test("openai adapter: memory.md is fetched and injected before the activity log", async () => {
  let capturedSystem = null;
  const handlers = [
    [
      "openai.com",
      ({ init }) => {
        capturedSystem = JSON.parse(init.body).messages[0].content;
        return { body: { choices: [{ message: { content: "ok" } }] } };
      },
    ],
    [
      /\/contents\/\.docs-chat\/MEMORY\.md/,
      () => ({
        body: {
          content: b64("## Style\n- always use sentence case"),
          sha: "memsha",
          path: MEMORY_PATH,
          encoding: "base64",
        },
      }),
    ],
    [
      /\/repos\/[^/]+\/[^/]+\/commits/,
      () => ({
        body: [
          {
            sha: "x1",
            commit: { author: { name: "Sergey", date: "2026-04-17T10:00:00Z" }, message: "fix typo" },
            author: { login: "sergey-ivochkin" },
          },
        ],
      }),
    ],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const settings = {
      adapter: "openai",
      mode: "read",
      openai: { apiKey: "sk-test", model: "gpt-5.4" },
      claude: { apiKey: "", model: "claude-sonnet-4-6", githubToken: "ghp_test" },
    };
    await openaiAdapter.chat("hi", CONTEXT, [], settings);
    assert.ok(capturedSystem);
    const memIdx = capturedSystem.indexOf("Shared team memory");
    const actIdx = capturedSystem.indexOf("Recent docs activity");
    assert.ok(memIdx >= 0, `expected memory block, got: ${capturedSystem.slice(0, 200)}`);
    assert.ok(actIdx >= 0, "expected activity block");
    assert.ok(memIdx < actIdx, "memory must appear before activity log");
    assert.match(capturedSystem, /always use sentence case/);
  } finally {
    restore();
  }
});

test("openai adapter: add-ons catalog is injected into the system prompt", async () => {
  // Even without GH auth the catalog must reach the system prompt -
  // it's a static bundled file, not a per-repo fetch. The model needs
  // it every turn so it can answer "what can I enable?".
  let capturedSystem = null;
  const handlers = [
    [
      "openai.com",
      ({ init }) => {
        capturedSystem = JSON.parse(init.body).messages[0].content;
        return { body: { choices: [{ message: { content: "ok" } }] } };
      },
    ],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const settings = {
      adapter: "openai",
      mode: "read",
      openai: { apiKey: "sk-test", model: "gpt-5.4" },
      claude: { apiKey: "", model: "claude-sonnet-4-6" },
    };
    await openaiAdapter.chat("hi", CONTEXT, [], settings);
    assert.ok(capturedSystem, "expected the OpenAI request to be captured");
    assert.match(capturedSystem, /Available add-ons.*toggle by asking the agent/);
    // Must include the on/off marker for at least one entry.
    assert.match(capturedSystem, /\[off\]/);
  } finally {
    restore();
  }
});

test("openai adapter: features.json from PageContext flips the on/off marker", async () => {
  let capturedSystem = null;
  const handlers = [
    [
      "openai.com",
      ({ init }) => {
        capturedSystem = JSON.parse(init.body).messages[0].content;
        return { body: { choices: [{ message: { content: "ok" } }] } };
      },
    ],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const settings = {
      adapter: "openai",
      mode: "read",
      openai: { apiKey: "sk-test", model: "gpt-5.4" },
      claude: { apiKey: "", model: "claude-sonnet-4-6" },
    };
    // Pretend the site has the search add-on enabled.
    const ctx = { ...CONTEXT, features: { search: true } };
    await openaiAdapter.chat("hi", ctx, [], settings);
    assert.ok(capturedSystem);
    // The "search [ON]" marker must appear somewhere in the system block.
    assert.match(capturedSystem, /- search \[ON\]:/);
  } finally {
    restore();
  }
});

test("openai adapter: missing MEMORY.md is treated as empty (no header injected)", async () => {
  let capturedSystem = null;
  const handlers = [
    [
      "openai.com",
      ({ init }) => {
        capturedSystem = JSON.parse(init.body).messages[0].content;
        return { body: { choices: [{ message: { content: "ok" } }] } };
      },
    ],
    [
      /\/contents\/\.docs-chat\/MEMORY\.md/,
      () => ({ status: 404, body: { message: "Not Found" } }),
    ],
    [/\/repos\/[^/]+\/[^/]+\/commits/, () => ({ body: [] })],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    // Use a different repo than other tests so the per-(owner/repo)
    // module-level memoryCache from those tests doesn't pollute this one.
    const ctx = { ...CONTEXT, repo: { owner: "Other", name: "no-memory-repo" } };
    const settings = {
      adapter: "openai",
      mode: "read",
      openai: { apiKey: "sk-test", model: "gpt-5.4" },
      claude: { apiKey: "", model: "claude-sonnet-4-6", githubToken: "ghp_test" },
    };
    await openaiAdapter.chat("hi", ctx, [], settings);
    assert.ok(capturedSystem);
    assert.ok(!/Shared team memory/.test(capturedSystem),
      "no memory header when MEMORY.md is missing");
  } finally {
    restore();
  }
});

// ── shared memory phase 2B: write via `remember` tool ──────────────

test("openai adapter: remember tool produces a memory preview", async () => {
  // Model returns a `remember` tool call. Adapter should fetch current
  // MEMORY.md (here: doesn't exist - 404), build the new content via
  // mergeMemoryEntry, and return a preview attachment.
  const handlers = [
    [
      "openai.com",
      () => ({
        body: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    function: {
                      name: "remember",
                      arguments: JSON.stringify({
                        entry: "Headings on this site use sentence case.",
                        section: "Style",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    ],
    [/repos\/[^/]+\/[^/]+$/, () => ({ body: { default_branch: "main" } })],
    // Upfront page fetch (current source)
    [
      /\/contents\/docs\/index\.html/,
      () => ({ body: { content: b64(HTML), sha: "filesha", path: SOURCE_PATH, encoding: "base64" } }),
    ],
    // MEMORY.md doesn't exist yet
    [
      /\/contents\/\.docs-chat\/MEMORY\.md/,
      () => ({ status: 404, body: { message: "Not Found" } }),
    ],
    [/\/repos\/[^/]+\/[^/]+\/commits/, () => ({ body: [] })],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const reply = await openaiAdapter.chat(
      "remember that headings here are sentence case",
      // Use a fresh repo to dodge module-level memoryCache pollution
      { ...CONTEXT, repo: { owner: "Other", name: "memory-write-1" } },
      [],
      baseSettings("pr"),
    );
    assert.equal(reply.role, "assistant");
    assert.equal(reply.attachment?.kind, "preview");
    const proposal = reply.attachment.data;
    assert.equal(proposal.kind, "memory");
    assert.equal(proposal.entry, "Headings on this site use sentence case.");
    assert.equal(proposal.section, "Style");
    assert.equal(proposal.fileSha, null, "fileSha should be null when MEMORY.md doesn't exist");
    // mergeMemoryEntry should have built a fresh skeleton with the entry.
    assert.match(proposal.newContent, /## Style/);
    assert.match(proposal.newContent, /sentence case/);
  } finally {
    restore();
  }
});

test("openai adapter: applyPendingProposal commits a memory entry to .docs-chat/MEMORY.md", async () => {
  let putCall = null;
  const handlers = [
    [
      "openai.com",
      () => ({
        body: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    function: {
                      name: "remember",
                      arguments: JSON.stringify({ entry: "Hello world.", section: "Notes" }),
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    ],
    [/repos\/[^/]+\/[^/]+$/, () => ({ body: { default_branch: "main" } })],
    [
      /\/contents\/docs\/index\.html/,
      () => ({ body: { content: b64(HTML), sha: "filesha", path: SOURCE_PATH, encoding: "base64" } }),
    ],
    [
      /\/contents\/\.docs-chat\/MEMORY\.md/,
      ({ init }) => {
        if (!init || init.method === "GET" || init.method === undefined) {
          return { status: 404, body: { message: "Not Found" } };
        }
        // PUT - capture the body so we can assert SHA was omitted
        // (creating the file fresh) and the path is correct.
        putCall = { body: JSON.parse(init.body), method: init.method };
        return { body: { commit: { sha: "memcommit", html_url: "https://github.com/x/y/commit/memcommit" } } };
      },
    ],
    [/git\/refs$/, () => ({ body: { ref: "refs/heads/feature" } })],
    [/\/pulls$/, () => ({ body: { number: 99, url: "api", html_url: "https://github.com/x/y/pull/99" } })],
    [/\/git\/ref\/heads\//, () => ({ body: { object: { sha: "basesha" } } })],
    [/\/repos\/[^/]+\/[^/]+\/commits/, () => ({ body: [] })],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    // Step 1: get the preview so a proposal is in session storage.
    const reply = await openaiAdapter.chat(
      "remember Hello world",
      { ...CONTEXT, repo: { owner: "Other", name: "memory-apply-1" } },
      [],
      baseSettings("pr"),
    );
    const proposalId = reply.attachment.data.proposalId;
    const stored = await loadPendingProposal(proposalId);
    assert.ok(stored);

    // Step 2: apply.
    const { GitHubClient } = await import(await bundle("src/lib/github.ts"));
    const gh = await GitHubClient.fromSettings(baseSettings("pr"));
    const result = await applyPendingProposal(stored, gh);

    assert.match(result.content, /PR opened/);
    assert.match(result.content, /\.docs-chat\/MEMORY\.md/);
    assert.equal(result.attachment?.kind, "pr");
    // PUT body must NOT have a sha (it's a create, not an update).
    assert.ok(putCall, "expected a PUT to /contents/.docs-chat/MEMORY.md");
    assert.equal(putCall.body.sha, undefined, "creating MEMORY.md should omit the sha field");
    // Body content (decoded from base64) should include the entry.
    const newContent = Buffer.from(putCall.body.content, "base64").toString("utf8");
    assert.match(newContent, /## Notes/);
    assert.match(newContent, /Hello world/);
  } finally {
    restore();
  }
});

// ── mergeMemoryEntry: pure-function unit tests ─────────────────────

test("mergeMemoryEntry: empty input creates a fresh skeleton with the entry", () => {
  const out = mergeMemoryEntry("", "Headings use sentence case.", "Style");
  assert.match(out, /^# Shared docs-chat memory/);
  assert.match(out, /## Style\n- Headings use sentence case\./);
});

test("mergeMemoryEntry: empty section name falls back to 'Notes'", () => {
  for (const section of ["", undefined, "   "]) {
    const out = mergeMemoryEntry("", "fact", section);
    assert.match(out, /## Notes\n- fact/, `failed for section=${JSON.stringify(section)}`);
  }
});

test("mergeMemoryEntry: appends to an existing section's bullet list", () => {
  const current = "# Memory\n\n## Style\n- old bullet\n";
  const out = mergeMemoryEntry(current, "new bullet", "Style");
  assert.match(out, /- old bullet\n- new bullet/);
  assert.ok(out.includes("- old bullet"));
});

test("mergeMemoryEntry: new entry inserts before the next section, not at file end", () => {
  // Regression: a naive "append at end" would put the new bullet under
  // the wrong section. mergeMemoryEntry must insert just after the last
  // bullet of the target section, before the next ## header.
  const current = [
    "# Memory",
    "",
    "## Style",
    "- A",
    "- B",
    "",
    "## Voice",
    "- voice rule",
    "",
  ].join("\n");
  const out = mergeMemoryEntry(current, "C", "Style");
  const styleIdx = out.indexOf("## Style");
  const voiceIdx = out.indexOf("## Voice");
  const cIdx = out.indexOf("- C");
  assert.ok(cIdx > styleIdx && cIdx < voiceIdx,
    `expected '- C' between Style and Voice, got: ${out}`);
});

test("mergeMemoryEntry: missing section is created at end of file", () => {
  const current = "# Memory\n\n## Style\n- A\n";
  const out = mergeMemoryEntry(current, "ops fact", "Ops");
  assert.match(out, /## Style\n- A/);
  assert.match(out, /## Ops\n- ops fact/);
  assert.ok(out.indexOf("## Ops") > out.indexOf("## Style"));
});

test("mergeMemoryEntry: empty section header (no bullets yet) inserts cleanly", () => {
  const current = "# Memory\n\n## Style\n\n## Voice\n- v\n";
  const out = mergeMemoryEntry(current, "first style fact", "Style");
  const styleIdx = out.indexOf("## Style");
  const voiceIdx = out.indexOf("## Voice");
  const factIdx = out.indexOf("- first style fact");
  assert.ok(factIdx > styleIdx && factIdx < voiceIdx);
});

test("mergeMemoryEntry: trims surrounding whitespace from the entry", () => {
  const out = mergeMemoryEntry("", "   leading + trailing\n  ", "Notes");
  assert.match(out, /- leading \+ trailing\n/);
  assert.ok(!out.includes("-    leading"), "leading whitespace must be stripped");
});

// ── cache invalidation after Apply (regression) ─────────────────────

test("openai adapter: applying a memory entry invalidates memoryCache", async () => {
  // Real bug: after applying a memory entry, the next chat turn would
  // load the cached pre-apply MEMORY.md for up to 5 min, so the model
  // wouldn't know the entry it just added existed. invalidateCachesAfterApply
  // drops the cache key on success.
  let memoryFetches = 0;
  const handlers = [
    [
      "openai.com",
      () => ({
        body: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    function: {
                      name: "remember",
                      arguments: JSON.stringify({ entry: "fact A", section: "Notes" }),
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    ],
    [/repos\/[^/]+\/[^/]+$/, () => ({ body: { default_branch: "main" } })],
    [
      /\/contents\/docs\/index\.html/,
      () => ({ body: { content: b64(HTML), sha: "filesha", path: SOURCE_PATH, encoding: "base64" } }),
    ],
    [
      /\/contents\/\.docs-chat\/MEMORY\.md/,
      ({ init }) => {
        if (!init || init.method === "GET" || init.method === undefined) {
          memoryFetches++;
          return { status: 404, body: { message: "Not Found" } };
        }
        return { body: { commit: { sha: "memcommit", html_url: "https://github.com/x/y/commit/memcommit" } } };
      },
    ],
    [/git\/refs$/, () => ({ body: { ref: "refs/heads/feature" } })],
    [/\/pulls$/, () => ({ body: { number: 1, url: "api", html_url: "https://github.com/x/y/pull/1" } })],
    [/\/git\/ref\/heads\//, () => ({ body: { object: { sha: "basesha" } } })],
    [/\/repos\/[^/]+\/[^/]+\/commits/, () => ({ body: [] })],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const ctx = { ...CONTEXT, repo: { owner: "Other", name: "memcache-invalidate" } };
    const settings = baseSettings("pr");

    const reply = await openaiAdapter.chat("remember fact A", ctx, [], settings);
    const before = memoryFetches;
    assert.ok(before >= 1, "expected at least one memory fetch from chat");

    const stored = await loadPendingProposal(reply.attachment.data.proposalId);
    const { GitHubClient } = await import(await bundle("src/lib/github.ts"));
    const gh = await GitHubClient.fromSettings(settings);
    await applyPendingProposal(stored, gh);

    // Without invalidation, getRepoMemory would return cached null and
    // skip the GET. With invalidation, it refetches.
    await openaiAdapter.chat("hi", ctx, [], settings);
    assert.ok(memoryFetches > before,
      `expected memoryFetches to grow after apply (was ${before}, now ${memoryFetches})`);
  } finally {
    restore();
  }
});

test("openai adapter: cache key includes auth fingerprint so accounts don't share state", async () => {
  // Real bug: activityCache + memoryCache used to be keyed only by
  // owner/repo. Sign out of account A, sign in as account B viewing
  // the same repo, and B got back A's cached MEMORY.md / activity log
  // for up to 5 minutes - cross-account leak. Fix: cache key includes
  // GitHubClient.authFingerprint(), so a token swap forces a refetch.
  //
  // Asserted by counting fetches across two chats with different tokens
  // pointed at the same (owner, repo).
  let memoryFetches = 0;
  let activityFetches = 0;
  const handlers = [
    ["openai.com", () => ({ body: { choices: [{ message: { content: "ok" } }] } })],
    [
      /\/contents\/docs\/index\.html/,
      () => ({ body: { content: b64(HTML), sha: "filesha", path: SOURCE_PATH, encoding: "base64" } }),
    ],
    [
      /\/contents\/\.docs-chat\/MEMORY\.md/,
      () => {
        memoryFetches++;
        return { status: 404, body: { message: "Not Found" } };
      },
    ],
    [
      /\/repos\/[^/]+\/[^/]+\/commits/,
      () => {
        activityFetches++;
        return { body: [] };
      },
    ],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const ctx = { ...CONTEXT, repo: { owner: "Other", name: "auth-fingerprint-isolation" } };
    const settingsA = { ...baseSettings("pr"),
      claude: { apiKey: "", model: "claude-sonnet-4-6", githubToken: "ghp_account_AAA" } };
    const settingsB = { ...baseSettings("pr"),
      claude: { apiKey: "", model: "claude-sonnet-4-6", githubToken: "ghp_account_BBB" } };

    await openaiAdapter.chat("hi", ctx, [], settingsA);
    const aMem = memoryFetches, aAct = activityFetches;
    assert.ok(aMem >= 1 && aAct >= 1, "expected fetches from account A");

    // Same repo, different account. Without per-auth keying, both caches
    // would hit and these counters would NOT grow.
    await openaiAdapter.chat("hi", ctx, [], settingsB);
    assert.ok(memoryFetches > aMem,
      `account B must refetch memory (was ${aMem}, now ${memoryFetches})`);
    assert.ok(activityFetches > aAct,
      `account B must refetch activity (was ${aAct}, now ${activityFetches})`);
  } finally {
    restore();
  }
});

test("openai adapter: edit-mode Apply invalidates activityCache (regression)", () => {
  // Sibling test to the memory-Apply invalidation guarantee. After a
  // successful edit/nav Apply the next chat turn should refetch the
  // commits list - the new commit it just made is part of the activity
  // log. invalidateCachesAfterApply must drop both memory AND activity
  // cache for memory writes; for edit/nav writes it must drop activity
  // (memory file wasn't touched).
  //
  // Asserted by counting calls to /commits across an Apply. We use
  // a unique repo so the module-level activityCache from earlier
  // tests doesn't pollute this one.
  let activityFetches = 0;
  const handlers = [
    [
      "openai.com",
      () => openaiEditFileResponse(),
    ],
    [/repos\/[^/]+\/[^/]+$/, () => ({ body: { default_branch: "main" } })],
    [/git\/ref\/heads\//, () => ({ body: { object: { sha: "basesha" } } })],
    [
      /\/contents\/docs\/index\.html/,
      ({ init }) => {
        if (!init || init.method === "GET" || init.method === undefined) {
          return { body: { content: b64(HTML), sha: "filesha", path: SOURCE_PATH, encoding: "base64" } };
        }
        return { body: { commit: { sha: "newsha", html_url: "https://github.com/x/y/commit/newsha" } } };
      },
    ],
    [/git\/refs$/, () => ({ body: { ref: "refs/heads/feature" } })],
    [/\/pulls$/, () => ({ body: { number: 1, url: "api", html_url: "https://github.com/x/y/pull/1" } })],
    [
      /\/contents\/\.docs-chat\/MEMORY\.md/,
      () => ({ status: 404, body: { message: "Not Found" } }),
    ],
    [
      /\/repos\/[^/]+\/[^/]+\/commits/,
      () => {
        activityFetches++;
        return { body: [] };
      },
    ],
  ];
  const { restore } = installFetchMock(handlers);
  // Prime an activity fetch so the cache is populated before Apply.
  return (async () => {
    try {
      const ctx = { ...CONTEXT, repo: { owner: "Other", name: "edit-apply-invalidate" } };
      const settings = baseSettings("pr");
      const reply = await openaiAdapter.chat("greet the world", ctx, [], settings);
      const before = activityFetches;
      assert.ok(before >= 1, "expected an activity fetch from chat");

      // Apply the proposal.
      const stored = await loadPendingProposal(reply.attachment.data.proposalId);
      const { GitHubClient } = await import(await bundle("src/lib/github.ts"));
      const gh = await GitHubClient.fromSettings(settings);
      await applyPendingProposal(stored, gh);

      // Next chat turn must refetch the activity log.
      await openaiAdapter.chat("hi", ctx, [], settings);
      assert.ok(activityFetches > before,
        `expected activityFetches to grow after Apply (was ${before}, now ${activityFetches})`);
    } finally {
      restore();
    }
  })();
});

test("openai adapter: system context blocks stay in priority order (memory, addons, activity)", () => {
  // Order matters: most-stable team facts first, durable add-on
  // catalog second, fast-moving activity log last. This mirrors what
  // Claude Code does (CLAUDE.md/MEMORY.md > recent context).
  // A future refactor could accidentally swap them; this test pins the
  // contract.
  let capturedSystem = null;
  const handlers = [
    [
      "openai.com",
      ({ init }) => {
        capturedSystem = JSON.parse(init.body).messages[0].content;
        return { body: { choices: [{ message: { content: "ok" } }] } };
      },
    ],
    [
      /\/contents\/\.docs-chat\/MEMORY\.md/,
      () => ({
        body: {
          content: b64("## Style\n- always use sentence case"),
          sha: "memsha",
          path: ".docs-chat/MEMORY.md",
          encoding: "base64",
        },
      }),
    ],
    [
      /\/repos\/[^/]+\/[^/]+\/commits/,
      () => ({
        body: [
          {
            sha: "a",
            commit: { author: { name: "X", date: "2026-04-17T10:00:00Z" }, message: "fix typo" },
            author: { login: "x" },
          },
        ],
      }),
    ],
  ];
  const { restore } = installFetchMock(handlers);
  return (async () => {
    try {
      const settings = {
        adapter: "openai",
        mode: "read",
        openai: { apiKey: "sk-test", model: "gpt-5.4" },
        claude: { apiKey: "", model: "claude-sonnet-4-6", githubToken: "ghp_test" },
      };
      // Fresh repo so caches don't pollute order detection.
      const ctx = { ...CONTEXT, repo: { owner: "Other", name: "block-order-1" } };
      await openaiAdapter.chat("hi", ctx, [], settings);
      assert.ok(capturedSystem);
      const memIdx = capturedSystem.indexOf("Shared team memory");
      const addonsIdx = capturedSystem.indexOf("Available add-ons");
      const actIdx = capturedSystem.indexOf("Recent docs activity");
      assert.ok(memIdx >= 0, "memory block missing");
      assert.ok(addonsIdx >= 0, "add-ons block missing");
      assert.ok(actIdx >= 0, "activity block missing");
      assert.ok(memIdx < addonsIdx, "memory must come before add-ons");
      assert.ok(addonsIdx < actIdx, "add-ons must come before activity");
    } finally {
      restore();
    }
  })();
});
