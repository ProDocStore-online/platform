// Tests for the .prodocstore/chat conversation mirror.
//
// serializeConversation is pure; persistConversation is exercised against
// a hand-rolled GitHubClient stub so we can assert the branch/file/sha
// dance without a live GitHub.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const {
  serializeConversation,
  persistConversation,
  CHAT_BRANCH,
  CHAT_FILE,
} = await import(await bundle("src/lib/prodocstore-chat.ts"));

const NOW = "2026-06-30T05:00:00.000Z";

// ── serializeConversation ────────────────────────────────────────────

test("serializeConversation emits versioned, self-describing JSON", () => {
  const messages = [
    { role: "user", content: "hi", timestamp: 1 },
    { role: "assistant", content: "hello", timestamp: 2 },
  ];
  const out = serializeConversation("owner/name", messages, NOW);
  const doc = JSON.parse(out);
  assert.equal(doc.version, 1);
  assert.equal(doc.repo, "owner/name");
  assert.equal(doc.updatedAt, NOW);
  assert.equal(doc.messageCount, 2);
  assert.deepEqual(doc.messages, messages);
  assert.ok(out.endsWith("\n"), "file should end with a trailing newline");
});

test("serializeConversation messageCount always tracks messages.length", () => {
  const doc = JSON.parse(serializeConversation("o/n", [], NOW));
  assert.equal(doc.messageCount, 0);
  assert.deepEqual(doc.messages, []);
});

// ── persistConversation ──────────────────────────────────────────────

/**
 * Minimal GitHubClient stand-in. Records calls and lets each test decide
 * what getFileOrNull returns (null = file doesn't exist yet).
 */
function stubClient({ existingFile = null } = {}) {
  const calls = { ensureBranch: [], getFileOrNull: [], updateFile: [] };
  return {
    calls,
    async ensureBranch(owner, repo, branch) {
      calls.ensureBranch.push({ owner, repo, branch });
      return branch;
    },
    async getFileOrNull(owner, repo, path, ref) {
      calls.getFileOrNull.push({ owner, repo, path, ref });
      return existingFile;
    },
    async updateFile(owner, repo, path, content, sha, branch, message) {
      calls.updateFile.push({ owner, repo, path, content, sha, branch, message });
      return { sha: "newsha", html_url: "https://github.com/o/n/commit/newsha" };
    },
  };
}

test("persistConversation creates the file (null sha) on first write", async () => {
  const gh = stubClient({ existingFile: null });
  const messages = [{ role: "user", content: "first" }];
  const { commitUrl } = await persistConversation(gh, "o", "n", messages, NOW);

  assert.equal(commitUrl, "https://github.com/o/n/commit/newsha");
  // Branch ensured first.
  assert.deepEqual(gh.calls.ensureBranch[0], { owner: "o", repo: "n", branch: CHAT_BRANCH });
  // Read targets the chat branch (ref), not the default branch.
  assert.deepEqual(gh.calls.getFileOrNull[0], {
    owner: "o", repo: "n", path: CHAT_FILE, ref: CHAT_BRANCH,
  });
  const put = gh.calls.updateFile[0];
  assert.equal(put.path, CHAT_FILE);
  assert.equal(put.branch, CHAT_BRANCH);
  assert.equal(put.sha, null, "null sha => create new file");
  // Content is the serialized doc.
  assert.equal(JSON.parse(put.content).messages.length, 1);
});

test("persistConversation overwrites with the existing blob sha on update", async () => {
  const gh = stubClient({ existingFile: { sha: "oldsha", content: "{}", path: CHAT_FILE } });
  await persistConversation(gh, "o", "n", [{ role: "user", content: "x" }], NOW);
  assert.equal(gh.calls.updateFile[0].sha, "oldsha", "must pass the prior sha to overwrite");
});

test("persistConversation singularises the commit message for one message", async () => {
  const gh = stubClient();
  await persistConversation(gh, "o", "n", [{ role: "user", content: "x" }], NOW);
  assert.match(gh.calls.updateFile[0].message, /\(1 message\)$/);
});

test("persistConversation pluralises the commit message for many messages", async () => {
  const gh = stubClient();
  await persistConversation(gh, "o", "n", [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ], NOW);
  assert.match(gh.calls.updateFile[0].message, /\(2 messages\)$/);
});
