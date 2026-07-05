// Unit tests for the OpenAI adapter's tool dispatcher.
//
// We bundle openai-tools.ts directly. Dependencies (GitHubClient) are
// stubbed - these tests don't care about auth or HTTP, only about the
// list_pages / read_page semantics.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const tools = await import(await bundle("src/adapters/openai-tools.ts"));
const {
  makeDispatch,
  isValidReadPath,
  sourceFormatOf,
  isValidRepoPath,
  capText,
  siteIdentifier,
  collectNav,
  looksLikeBinary,
  READ_PAGE_CAP,
  READ_PAGE_HALF,
} = tools;

function fakeGh({ listDocsHtml, getFile, listRepoFiles }) {
  return {
    listDocsHtml: listDocsHtml ?? (async () => []),
    listRepoFiles: listRepoFiles ?? (async () => []),
    getFile: getFile ?? (async () => ({ content: "", sha: "", path: "" })),
  };
}

function baseContext(overrides = {}) {
  return {
    url: "https://docs.example.com/",
    title: "Playbook",
    sourcePath: "docs/index.html",
    repo: { owner: "FreeDocStore", name: "freedocstore" },
    html: "",
    text: "",
    navConfig: null,
    ...overrides,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

test("isValidReadPath accepts docs/<name>.html", () => {
  assert.equal(isValidReadPath("docs/index.html"), true);
  assert.equal(isValidReadPath("docs/clients/acme/sow.html"), true);
});

test("isValidReadPath rejects traversal, absolute, out-of-docs, bad ext", () => {
  assert.equal(isValidReadPath(""), false);
  assert.equal(isValidReadPath("docs/../secrets.html"), false);
  assert.equal(isValidReadPath("/docs/index.html"), false);
  assert.equal(isValidReadPath("other/index.html"), false);
  // Non-source extensions stay rejected (only html/md/mdx/markdown allowed).
  assert.equal(isValidReadPath("docs/data.json"), false);
  assert.equal(isValidReadPath("docs/script.js"), false);
});

test("isValidReadPath accepts html and the markdown family", () => {
  assert.equal(isValidReadPath("docs/index.html"), true);
  assert.equal(isValidReadPath("docs/index.md"), true);
  assert.equal(isValidReadPath("docs/guide.mdx"), true);
  assert.equal(isValidReadPath("docs/reference/glossary.md"), true);
});

test("sourceFormatOf distinguishes markdown sources from html", () => {
  assert.equal(sourceFormatOf("docs/architecture.md"), "markdown");
  assert.equal(sourceFormatOf("docs/guide.mdx"), "markdown");
  assert.equal(sourceFormatOf("docs/notes.markdown"), "markdown");
  assert.equal(sourceFormatOf("docs/index.html"), "html");
  assert.equal(sourceFormatOf("docs/index"), "html");
});

test("capText passes through under the cap", () => {
  const { text, truncated } = capText("short");
  assert.equal(text, "short");
  assert.equal(truncated, false);
});

test("capText truncates head+tail with marker over the cap", () => {
  const big = "A".repeat(READ_PAGE_CAP + 5000);
  const { text, truncated } = capText(big);
  assert.equal(truncated, true);
  assert.match(text, /\[TRUNCATED 5000 CHARS\]/);
  // Head + tail + marker should be close to 20k + marker length.
  assert.ok(text.startsWith("A".repeat(READ_PAGE_HALF)));
  assert.ok(text.endsWith("A".repeat(READ_PAGE_HALF)));
});

test("siteIdentifier returns owner/repo when repo is known", () => {
  assert.equal(
    siteIdentifier(baseContext()),
    "FreeDocStore/freedocstore",
  );
});

test("siteIdentifier falls back to hostname when repo is null", () => {
  assert.equal(
    siteIdentifier(baseContext({ repo: null, url: "https://example.pages.dev/" })),
    "example.pages.dev",
  );
});

test("collectNav flattens leaves and recurses into dropdowns", () => {
  const out = [];
  const covered = new Set();
  collectNav(
    [
      { href: "components.html", label: "Components" },
      { label: "Guides", children: [{ href: "guides/a.html", label: "A" }] },
    ],
    null,
    out,
    covered,
  );
  assert.deepEqual(out, [
    { path: "docs/components.html", label: "Components", parent: null },
    { path: "docs/guides/a.html", label: "A", parent: "Guides" },
  ]);
  assert.deepEqual([...covered], ["docs/components.html", "docs/guides/a.html"]);
});

// ── list_pages ───────────────────────────────────────────────────────

test("list_pages: with navConfig flattens navItems and computes otherPages", async () => {
  const navConfig = {
    items: [
      { href: "components.html", label: "Components" },
      { label: "Guides", children: [{ href: "guides/a.html", label: "A" }] },
    ],
    navSkip: ["index.html", "404.html"],
    raw: "{}",
  };
  const gh = fakeGh({
    listDocsHtml: async () => [
      "docs/index.html",
      "docs/components.html",
      "docs/guides/a.html",
      "docs/changelog.html",
      "docs/404.html",
    ],
  });
  const dispatch = makeDispatch(gh, baseContext({ navConfig }));
  const result = JSON.parse(
    await dispatch({ id: "x", name: "list_pages", args: {} }),
  );
  assert.equal(result.site, "FreeDocStore/freedocstore");
  assert.equal(result.currentPage, "docs/index.html");
  assert.deepEqual(result.navItems, [
    { path: "docs/components.html", label: "Components", parent: null },
    { path: "docs/guides/a.html", label: "A", parent: "Guides" },
  ]);
  assert.deepEqual(
    result.otherPages.sort(),
    ["docs/404.html", "docs/changelog.html", "docs/index.html"],
  );
  assert.deepEqual(result.navSkip, ["index.html", "404.html"]);
});

test("list_pages: without navConfig lands everything in otherPages", async () => {
  const gh = fakeGh({
    listDocsHtml: async () => ["docs/index.html", "docs/about.html"],
  });
  const dispatch = makeDispatch(gh, baseContext({ navConfig: null }));
  const result = JSON.parse(
    await dispatch({ id: "x", name: "list_pages", args: {} }),
  );
  assert.deepEqual(result.navItems, []);
  assert.deepEqual(result.otherPages.sort(), ["docs/about.html", "docs/index.html"]);
  assert.deepEqual(result.navSkip, []);
});

test("list_pages: no repo -> {error:'no_repo'}", async () => {
  const dispatch = makeDispatch(null, baseContext({ repo: null }));
  const result = JSON.parse(
    await dispatch({ id: "x", name: "list_pages", args: {} }),
  );
  assert.equal(result.error, "no_repo");
});

test("list_pages: caches the tree across dispatches in one loop", async () => {
  let count = 0;
  const gh = fakeGh({
    listDocsHtml: async () => {
      count++;
      return ["docs/index.html", "docs/about.html"];
    },
  });
  const dispatch = makeDispatch(gh, baseContext());
  await dispatch({ id: "a", name: "list_pages", args: {} });
  await dispatch({ id: "b", name: "list_pages", args: {} });
  assert.equal(count, 1, "listDocsHtml should be called once per turn");
});

// ── read_page ────────────────────────────────────────────────────────

test("read_page: happy path returns stripped text and extracted title", async () => {
  const html = `
    <html>
      <head><title>Components Reference</title></head>
      <body>
        <nav>should disappear</nav>
        <script>var x = 1;</script>
        <style>body { color: red }</style>
        <header>page hero copy</header>
        <main><p>Visible content here.</p></main>
        <footer>copyright 2026</footer>
      </body>
    </html>`;
  const gh = fakeGh({
    getFile: async () => ({ content: html, sha: "s", path: "docs/components.html" }),
  });
  const dispatch = makeDispatch(gh, baseContext());
  const result = JSON.parse(
    await dispatch({
      id: "x",
      name: "read_page",
      args: { path: "docs/components.html" },
    }),
  );
  assert.equal(result.path, "docs/components.html");
  assert.equal(result.title, "Components Reference");
  assert.equal(result.truncated, false);
  assert.match(result.text, /Visible content here/);
  assert.ok(!result.text.includes("var x = 1"), "script body must be stripped");
  assert.ok(!result.text.includes("color: red"), "style body must be stripped");
  assert.ok(!result.text.includes("should disappear"), "nav body must be stripped (it's the topbar)");
  // Regression: <header> and <footer> stay so the model can answer
  // questions like "is there a footer?" and "what's in the page hero?".
  assert.match(result.text, /page hero copy/, "header must be kept");
  assert.match(result.text, /copyright 2026/, "footer must be kept");
});

test("read_page: over the cap returns head+tail with marker and truncated=true", async () => {
  const pad = "X".repeat(READ_PAGE_CAP + 1234);
  const html = `<html><head><title>Big</title></head><body><p>${pad}</p></body></html>`;
  const gh = fakeGh({
    getFile: async () => ({ content: html, sha: "s", path: "docs/big.html" }),
  });
  const dispatch = makeDispatch(gh, baseContext());
  const result = JSON.parse(
    await dispatch({ id: "x", name: "read_page", args: { path: "docs/big.html" } }),
  );
  assert.equal(result.truncated, true);
  assert.match(result.text, /\[TRUNCATED \d+ CHARS\]/);
});

test("read_page: invalid path returns {error:'invalid_path'} and does not fetch", async () => {
  let fetched = 0;
  const gh = fakeGh({
    getFile: async () => {
      fetched++;
      return { content: "", sha: "", path: "" };
    },
  });
  const dispatch = makeDispatch(gh, baseContext());
  const result = JSON.parse(
    await dispatch({ id: "x", name: "read_page", args: { path: "docs/../secret.html" } }),
  );
  assert.equal(result.error, "invalid_path");
  assert.equal(fetched, 0, "invalid paths must not hit GitHub");
});

test("read_page: 404 from getFile returns {error:'not_found'}", async () => {
  const gh = fakeGh({
    getFile: async () => {
      throw new Error("GitHub API GET /repos/x/y/contents/docs/missing.html failed: 404 Not Found");
    },
  });
  const dispatch = makeDispatch(gh, baseContext());
  const result = JSON.parse(
    await dispatch({ id: "x", name: "read_page", args: { path: "docs/missing.html" } }),
  );
  assert.equal(result.error, "not_found");
  assert.equal(result.path, "docs/missing.html");
});

test("read_page: after list_pages, unknown path is rejected without fetch", async () => {
  let fetched = 0;
  const gh = fakeGh({
    listDocsHtml: async () => ["docs/index.html", "docs/known.html"],
    getFile: async () => {
      fetched++;
      return { content: "", sha: "", path: "" };
    },
  });
  const dispatch = makeDispatch(gh, baseContext());
  await dispatch({ id: "a", name: "list_pages", args: {} });
  const result = JSON.parse(
    await dispatch({
      id: "b",
      name: "read_page",
      args: { path: "docs/not-in-list.html" },
    }),
  );
  assert.equal(result.error, "invalid_path");
  assert.match(result.detail, /list_pages/);
  assert.equal(fetched, 0);
});

test("read_page: without list_pages, any syntactically valid path is allowed", async () => {
  let fetched = 0;
  const gh = fakeGh({
    getFile: async () => {
      fetched++;
      return {
        content: "<html><head><title>OK</title></head><body>ok</body></html>",
        sha: "s",
        path: "docs/x.html",
      };
    },
  });
  const dispatch = makeDispatch(gh, baseContext());
  const result = JSON.parse(
    await dispatch({ id: "x", name: "read_page", args: { path: "docs/x.html" } }),
  );
  assert.equal(result.title, "OK");
  assert.equal(fetched, 1);
});

test("unknown tool returns {error:'unknown_tool'}", async () => {
  const dispatch = makeDispatch(fakeGh({}), baseContext());
  const result = JSON.parse(
    await dispatch({ id: "x", name: "does_not_exist", args: {} }),
  );
  assert.equal(result.error, "unknown_tool");
  assert.equal(result.name, "does_not_exist");
});

// ── isValidRepoPath ─────────────────────────────────────────────────

test("isValidRepoPath accepts any non-traversal repo-relative path", () => {
  // Reads outside docs/ are the WHOLE point of read_repo_file - so the
  // permissive validator must allow source code, workflows, dotfiles.
  assert.equal(isValidRepoPath("extension/src/adapters/openai.ts"), true);
  assert.equal(isValidRepoPath(".github/workflows/deploy-pages.yml"), true);
  assert.equal(isValidRepoPath("README.md"), true);
  assert.equal(isValidRepoPath("templates/_headers"), true);
  // Still allows docs/* (read_repo_file is a superset of read_page).
  assert.equal(isValidRepoPath("docs/index.html"), true);
});

test("isValidRepoPath accepts real-world unusual but valid paths (regression)", () => {
  // Earlier regex was [A-Za-z0-9._/-]+ which rejected legitimate paths
  // every JS/TS repo has. Bug-hunter agent flagged these as common false
  // negatives blocking the model from reading actual source.
  assert.equal(isValidRepoPath("node_modules/@anthropic-ai/sdk/index.js"), true);
  assert.equal(isValidRepoPath("packages/@scope/pkg/package.json"), true);
  // Next.js route groups
  assert.equal(isValidRepoPath("app/(marketing)/page.tsx"), true);
  // Versioned folders / build metadata
  assert.equal(isValidRepoPath("releases/v1.2.3+build.5/notes.md"), true);
});

test("isValidRepoPath rejects traversal and absolute paths", () => {
  // Even with broader access we never want to escape the repo root.
  assert.equal(isValidRepoPath(""), false);
  assert.equal(isValidRepoPath("../etc/passwd"), false);
  assert.equal(isValidRepoPath("docs/../../secrets"), false);
  assert.equal(isValidRepoPath("/etc/passwd"), false);
  assert.equal(isValidRepoPath("\\windows\\system32"), false);
});

test("isValidRepoPath rejects shell metacharacters and whitespace", () => {
  // Defensive: any path that could be misinterpreted as a shell glob,
  // pipe, or env-substitution. Real repo paths don't contain these.
  assert.equal(isValidRepoPath("foo bar.txt"), false);
  assert.equal(isValidRepoPath("foo|bar"), false);
  assert.equal(isValidRepoPath("foo;bar"), false);
  assert.equal(isValidRepoPath("foo$bar"), false);
  assert.equal(isValidRepoPath("foo*bar"), false);
});

// ── list_repo_files ────────────────────────────────────────────────

test("list_repo_files returns the full repo tree (not just docs/)", async () => {
  const gh = fakeGh({
    listRepoFiles: async () => [
      "README.md",
      "docs/index.html",
      "extension/src/adapters/openai.ts",
      ".github/workflows/deploy-pages.yml",
    ],
  });
  const dispatch = makeDispatch(gh, baseContext());
  const result = JSON.parse(
    await dispatch({ id: "x", name: "list_repo_files", args: {} }),
  );
  assert.equal(result.count, 4);
  assert.deepEqual(result.files.sort(), [
    ".github/workflows/deploy-pages.yml",
    "README.md",
    "docs/index.html",
    "extension/src/adapters/openai.ts",
  ]);
  assert.equal(result.truncated, false);
});

test("list_repo_files caps at 1000 entries with truncated:true", async () => {
  const big = Array.from({ length: 1500 }, (_, i) => `f${i}.txt`);
  const gh = fakeGh({ listRepoFiles: async () => big });
  const dispatch = makeDispatch(gh, baseContext());
  const result = JSON.parse(
    await dispatch({ id: "x", name: "list_repo_files", args: {} }),
  );
  assert.equal(result.count, 1500);
  assert.equal(result.files.length, 1000);
  assert.equal(result.truncated, true);
});

test("list_repo_files: no repo -> {error:'no_repo'}", async () => {
  const gh = fakeGh({});
  const dispatch = makeDispatch(gh, baseContext({ repo: null }));
  const result = JSON.parse(
    await dispatch({ id: "x", name: "list_repo_files", args: {} }),
  );
  assert.equal(result.error, "no_repo");
});

// ── read_repo_file ──────────────────────────────────────────────────

test("read_repo_file reads any path in the repo (regression: not just docs/)", async () => {
  // The whole point of this tool: docs are useful, source code is also
  // useful. The agent should be able to read extension/src/* to verify
  // docs/extension.html claims.
  const gh = fakeGh({
    getFile: async (_owner, _repo, path) => ({
      content: `// fake source for ${path}\nexport const x = 1;`,
      sha: "shaval",
      path,
    }),
  });
  const dispatch = makeDispatch(gh, baseContext());
  const result = JSON.parse(
    await dispatch({
      id: "x",
      name: "read_repo_file",
      args: { path: "extension/src/adapters/openai.ts" },
    }),
  );
  assert.equal(result.path, "extension/src/adapters/openai.ts");
  assert.match(result.text, /fake source for extension\/src\/adapters\/openai\.ts/);
  assert.equal(result.truncated, false);
  assert.equal(result.sha, "shaval");
});

test("read_repo_file truncates oversized files head+tail", async () => {
  const huge = "x".repeat(READ_PAGE_CAP + 5_000);
  const gh = fakeGh({
    getFile: async () => ({ content: huge, sha: "s", path: "big.bin" }),
  });
  const dispatch = makeDispatch(gh, baseContext());
  const result = JSON.parse(
    await dispatch({ id: "x", name: "read_repo_file", args: { path: "big.bin" } }),
  );
  assert.equal(result.truncated, true);
  assert.ok(result.text.includes("[TRUNCATED"), "expected truncation marker");
});

test("read_repo_file rejects path traversal without fetching", async () => {
  let fetched = false;
  const gh = fakeGh({
    getFile: async () => {
      fetched = true;
      return { content: "", sha: "", path: "" };
    },
  });
  const dispatch = makeDispatch(gh, baseContext());
  const result = JSON.parse(
    await dispatch({ id: "x", name: "read_repo_file", args: { path: "../../../etc/passwd" } }),
  );
  assert.equal(result.error, "invalid_path");
  assert.equal(fetched, false, "must not fetch when path is rejected");
});

test("looksLikeBinary detects NUL bytes and replacement chars", () => {
  // NUL bytes appear in binaries (PNG, PDF, .ico) but never in real text;
  // U+FFFD is what TextDecoder emits when binary bytes are decoded as
  // UTF-8. Either flag means we should not return the file as text.
  assert.equal(looksLikeBinary("hello world"), false);
  assert.equal(looksLikeBinary("contains\x00null"), true);
  assert.equal(looksLikeBinary("decoded as garbage \uFFFD\uFFFD"), true);
  // Sample is the first 8KB - a NUL beyond that is allowed (rare).
  assert.equal(looksLikeBinary("a".repeat(9000) + "\x00"), false);
});

test("read_repo_file refuses binary content with {error:'binary_file'}", async () => {
  // Real bug: getFile blindly decodes any base64 content as UTF-8, so
  // requesting docs/logo.png returned mangled garbage. Without binary
  // detection the model would burn tokens trying to read the noise and
  // hallucinate "code" from random bytes.
  const gh = fakeGh({
    getFile: async () => ({ content: "PNG header\x00\x00\x00 binary data", sha: "s", path: "logo.png" }),
  });
  const dispatch = makeDispatch(gh, baseContext());
  const result = JSON.parse(
    await dispatch({ id: "x", name: "read_repo_file", args: { path: "docs/logo.png" } }),
  );
  assert.equal(result.error, "binary_file");
  assert.equal(result.path, "docs/logo.png");
  // No content leaked into the response.
  assert.equal(result.text, undefined);
});

test("read_repo_file 404 returns {error:'not_found'} (gracefully)", async () => {
  const gh = fakeGh({
    getFile: async () => {
      throw new Error("GitHub API GET /repos/x/y/contents/z failed: 404 Not Found");
    },
  });
  const dispatch = makeDispatch(gh, baseContext());
  const result = JSON.parse(
    await dispatch({ id: "x", name: "read_repo_file", args: { path: "missing.txt" } }),
  );
  assert.equal(result.error, "not_found");
  assert.equal(result.path, "missing.txt");
});
