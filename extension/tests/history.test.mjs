// Unit tests for the per-scope chat history storage.
//
// Covers: scope key derivation (repo > origin > nocontext), the
// chrome.storage.local read/write/delete dance, multi-scope isolation,
// and the proposal-key collector that the side panel's Clear handler
// uses to garbage-collect orphan previews from session storage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

// chrome.storage.local mock - same shape as the real API but backed by
// a Map. The mock is shared across the whole test file because the
// history module's helpers all read it directly via `chrome.storage.local`.
function installChromeMock() {
  const store = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        get: async (key) => {
          if (key === null || key === undefined) {
            return Object.fromEntries(store);
          }
          const k = typeof key === "string" ? key : Array.isArray(key) ? key[0] : Object.keys(key)[0];
          const v = store.get(k);
          return v === undefined ? {} : { [k]: v };
        },
        remove: async (key) => {
          const k = typeof key === "string" ? key : key[0];
          store.delete(k);
        },
      },
    },
  };
  return store;
}

const store = installChromeMock();

const lib = await import(await bundle("src/lib/history.ts"));
const {
  HISTORY_KEY,
  HISTORY_LIMIT,
  NO_CONTEXT_SCOPE,
  scopeFromContext,
  repoFromScope,
  readHistoryMap,
  readScopeHistory,
  writeScopeHistory,
  updateScopeHistory,
  proposalKeysFor,
  isStaleReply,
} = lib;

function reset() {
  store.clear();
}

// ── scopeFromContext ────────────────────────────────────────────────

test("scopeFromContext: repo wins over origin", () => {
  // The whole point of preferring repo: a preview deploy and prod
  // deploy of the same site share the thread because they share a repo.
  const ctx = {
    repo: { owner: "FreeDocStore", name: "freedocstore" },
    url: "https://docs.example.com/extension",
    sourcePath: "docs/extension.html",
    text: "",
    title: "",
  };
  assert.equal(scopeFromContext(ctx), "repo:FreeDocStore/freedocstore");
});

test("scopeFromContext: falls back to origin when no repo", () => {
  const ctx = {
    repo: null,
    url: "https://example.com/some/path?q=1",
    sourcePath: "",
    text: "",
    title: "",
  };
  // Path + query stripped; only the origin survives so /foo and /bar
  // share a thread on the same site.
  assert.equal(scopeFromContext(ctx), "origin:https://example.com");
});

test("scopeFromContext: same origin, different paths -> same scope", () => {
  const ctxA = { repo: null, url: "https://docs.example.com/a", sourcePath: "", text: "", title: "" };
  const ctxB = { repo: null, url: "https://docs.example.com/b/c", sourcePath: "", text: "", title: "" };
  assert.equal(scopeFromContext(ctxA), scopeFromContext(ctxB));
});

test("scopeFromContext: different origins -> different scopes", () => {
  const a = scopeFromContext({ repo: null, url: "https://a.example.com/", sourcePath: "", text: "", title: "" });
  const b = scopeFromContext({ repo: null, url: "https://b.example.com/", sourcePath: "", text: "", title: "" });
  assert.notEqual(a, b);
});

test("scopeFromContext: malformed URL falls through to no-context", () => {
  const ctx = { repo: null, url: "not a url", sourcePath: "", text: "", title: "" };
  assert.equal(scopeFromContext(ctx), NO_CONTEXT_SCOPE);
});

test("scopeFromContext: null context -> no-context scope", () => {
  assert.equal(scopeFromContext(null), NO_CONTEXT_SCOPE);
});

test("scopeFromContext: ctx without repo or url -> no-context", () => {
  assert.equal(scopeFromContext({ repo: null, url: "", sourcePath: "", text: "", title: "" }), NO_CONTEXT_SCOPE);
});

// ── repoFromScope (inverse of the repo: branch) ─────────────────────

test("repoFromScope: parses a repo scope back to owner/name", () => {
  assert.deepEqual(repoFromScope("repo:Rocket-Lab-Skunkworks/docs-chat-test"), {
    owner: "Rocket-Lab-Skunkworks",
    name: "docs-chat-test",
  });
});

test("repoFromScope: round-trips with scopeFromContext", () => {
  const scope = scopeFromContext({
    repo: { owner: "FreeDocStore", name: "freedocstore" },
    url: "https://x/", sourcePath: "", text: "", title: "",
  });
  assert.deepEqual(repoFromScope(scope), { owner: "FreeDocStore", name: "freedocstore" });
});

test("repoFromScope: origin and no-context scopes have no repo", () => {
  assert.equal(repoFromScope("origin:https://example.com"), null);
  assert.equal(repoFromScope(NO_CONTEXT_SCOPE), null);
});

test("repoFromScope: rejects malformed repo scopes (no slash / empty side)", () => {
  assert.equal(repoFromScope("repo:noslash"), null);
  assert.equal(repoFromScope("repo:/name"), null);
  assert.equal(repoFromScope("repo:owner/"), null);
});

// ── readHistoryMap ──────────────────────────────────────────────────

test("readHistoryMap: missing key -> empty object", async () => {
  reset();
  const map = await readHistoryMap();
  assert.deepEqual(map, {});
});

test("readHistoryMap: returns the stored object as-is", async () => {
  reset();
  await chrome.storage.local.set({
    [HISTORY_KEY]: {
      "repo:a/b": [{ role: "user", content: "hi" }],
      "origin:https://x.com": [{ role: "assistant", content: "yo" }],
    },
  });
  const map = await readHistoryMap();
  assert.equal(Object.keys(map).length, 2);
  assert.equal(map["repo:a/b"][0].content, "hi");
});

test("readHistoryMap: legacy v1 flat-array shape is treated as empty (no migration)", async () => {
  reset();
  // v1 stored a bare ChatMessage[]; we no longer support it. Treat it
  // as a clean slate rather than guessing a scope.
  await chrome.storage.local.set({
    [HISTORY_KEY]: [{ role: "user", content: "from v1" }],
  });
  const map = await readHistoryMap();
  assert.deepEqual(map, {});
});

test("readHistoryMap: junk values (string, null) -> empty", async () => {
  reset();
  await chrome.storage.local.set({ [HISTORY_KEY]: "corrupted" });
  assert.deepEqual(await readHistoryMap(), {});
  await chrome.storage.local.set({ [HISTORY_KEY]: null });
  assert.deepEqual(await readHistoryMap(), {});
});

// ── readScopeHistory / writeScopeHistory ────────────────────────────

test("writeScopeHistory: writes a fresh scope into an empty store", async () => {
  reset();
  const msgs = [{ role: "user", content: "hello" }];
  await writeScopeHistory("repo:org/repo", msgs);
  assert.deepEqual(await readScopeHistory("repo:org/repo"), msgs);
});

test("writeScopeHistory: missing scope -> read returns empty array", async () => {
  reset();
  assert.deepEqual(await readScopeHistory("repo:never-written"), []);
});

test("writeScopeHistory: empty input deletes the bucket", async () => {
  reset();
  await writeScopeHistory("repo:org/repo", [{ role: "user", content: "x" }]);
  await writeScopeHistory("repo:org/repo", []);
  const map = await readHistoryMap();
  assert.equal(map["repo:org/repo"], undefined,
    "Clear must remove the scope key entirely so the storage map stays tidy");
});

test("writeScopeHistory: scopes are isolated", async () => {
  reset();
  await writeScopeHistory("repo:a/a", [{ role: "user", content: "from A" }]);
  await writeScopeHistory("repo:b/b", [{ role: "user", content: "from B" }]);
  // Update A; B must be untouched.
  await writeScopeHistory("repo:a/a", [{ role: "user", content: "from A v2" }]);
  assert.equal((await readScopeHistory("repo:a/a"))[0].content, "from A v2");
  assert.equal((await readScopeHistory("repo:b/b"))[0].content, "from B");
});

test("writeScopeHistory: clearing one scope doesn't drop the others", async () => {
  reset();
  await writeScopeHistory("repo:a/a", [{ role: "user", content: "from A" }]);
  await writeScopeHistory("repo:b/b", [{ role: "user", content: "from B" }]);
  // Real-world: user clicks Clear on tab A.
  await writeScopeHistory("repo:a/a", []);
  const map = await readHistoryMap();
  assert.equal(map["repo:a/a"], undefined);
  assert.equal(map["repo:b/b"][0].content, "from B");
});

test("writeScopeHistory: read-modify-write keeps unrelated scopes intact across concurrent writes", async () => {
  reset();
  // Two side panels writing to different scopes "at the same time".
  // RMW means each operation reads the current map first, so neither
  // stomps on the other - simulated here by interleaving the awaits.
  await writeScopeHistory("repo:a/a", [{ role: "user", content: "A" }]);
  await Promise.all([
    writeScopeHistory("repo:a/a", [{ role: "user", content: "A2" }]),
    writeScopeHistory("repo:b/b", [{ role: "user", content: "B" }]),
  ]);
  const map = await readHistoryMap();
  assert.ok(map["repo:a/a"], "A bucket must survive the concurrent write to B");
  assert.ok(map["repo:b/b"], "B bucket must survive the concurrent write to A");
});

test("updateScopeHistory: concurrent appends to the same bucket all survive", async () => {
  // Real bug this guards: in the multi-tab routing path, an async reply
  // lands and we run "read existing -> append -> write". Two concurrent
  // appends to the same bucket would each read the same baseline, each
  // append their own message, and each write back the whole array -
  // the second write silently clobbers the first reply. updateScopeHistory
  // performs the read+modify+write inside the serialized writeQueue so
  // each producer sees the previous one's result.
  reset();
  await writeScopeHistory("repo:a/a", [{ role: "user", content: "seed" }]);

  const producer = async (label) =>
    updateScopeHistory("repo:a/a", (existing) => [
      ...existing,
      { role: "assistant", content: label },
    ]);
  await Promise.all([producer("A1"), producer("A2"), producer("A3")]);

  const final = await readScopeHistory("repo:a/a");
  // Order depends on scheduler but ALL three replies must survive
  // alongside the seed.
  assert.equal(final.length, 4, `expected 4 messages, got ${JSON.stringify(final.map((m) => m.content))}`);
  const contents = new Set(final.map((m) => m.content));
  assert.ok(contents.has("seed"));
  assert.ok(contents.has("A1"));
  assert.ok(contents.has("A2"));
  assert.ok(contents.has("A3"));
});

test("updateScopeHistory: concurrent appends across DIFFERENT scopes don't lose either bucket", async () => {
  // Cross-scope variant: appendToScope(A) racing with persistHistory()
  // for scope B. Both writes touch the same map key (the histories
  // object), and a naive RMW would lose whichever delta wrote second.
  // The serialized queue makes both writes apply.
  reset();
  await Promise.all([
    updateScopeHistory("repo:a/a", () => [{ role: "user", content: "A" }]),
    updateScopeHistory("repo:b/b", () => [{ role: "user", content: "B" }]),
  ]);
  const map = await readHistoryMap();
  assert.equal(map["repo:a/a"]?.[0]?.content, "A");
  assert.equal(map["repo:b/b"]?.[0]?.content, "B");
});

test("updateScopeHistory: empty result deletes the bucket (matches writeScopeHistory semantics)", async () => {
  reset();
  await writeScopeHistory("repo:a/a", [{ role: "user", content: "x" }]);
  await updateScopeHistory("repo:a/a", () => []);
  const map = await readHistoryMap();
  assert.equal(map["repo:a/a"], undefined);
});

test("writeScopeHistory: a failed write doesn't poison subsequent writes", async () => {
  // The write queue is the chain that serializes everything. If one
  // failed write rejects the chain, every subsequent write would
  // inherit that rejection. The catch in the producer prevents that;
  // verify here that a transient storage error doesn't lock out new
  // writes for the rest of the session.
  reset();
  // Make ONE storage.set call fail.
  const realSet = chrome.storage.local.set;
  let calls = 0;
  chrome.storage.local.set = async (obj) => {
    calls++;
    if (calls === 1) throw new Error("transient storage error");
    return realSet(obj);
  };
  try {
    // First write fails.
    await assert.rejects(
      writeScopeHistory("repo:a/a", [{ role: "user", content: "lost" }]),
      /transient/,
    );
    // Second write must succeed - the chain is not poisoned.
    await writeScopeHistory("repo:a/a", [{ role: "user", content: "recovered" }]);
    const final = await readScopeHistory("repo:a/a");
    assert.equal(final.length, 1);
    assert.equal(final[0].content, "recovered");
  } finally {
    chrome.storage.local.set = realSet;
  }
});

// ── proposalKeysFor ─────────────────────────────────────────────────

test("proposalKeysFor: collects every preview proposal id with the storage prefix", () => {
  const messages = [
    { role: "user", content: "edit foo" },
    {
      role: "assistant",
      content: "Proposed change",
      attachment: { kind: "preview", data: { proposalId: "abc-123" } },
    },
    {
      role: "assistant",
      content: "Another proposal",
      attachment: { kind: "preview", data: { proposalId: "def-456" } },
    },
  ];
  assert.deepEqual(proposalKeysFor(messages), ["proposal:abc-123", "proposal:def-456"]);
});

test("proposalKeysFor: ignores resolved/commit/pr attachments and bare messages", () => {
  // Only "preview" attachments hold a live proposal in session storage.
  // commit/pr/preview_resolved have already been consumed; ignoring them
  // means we don't try to delete keys that don't exist.
  const messages = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "ok",
      attachment: { kind: "commit", data: { url: "https://github.com/x/y/commit/abc", sha: "abc" } },
    },
    {
      role: "assistant",
      content: "PR opened",
      attachment: { kind: "pr", data: { url: "https://github.com/x/y/pull/1", number: 1 } },
    },
    {
      role: "assistant",
      content: "applied",
      attachment: { kind: "preview_resolved", data: { proposalId: "resolved-1", outcome: "applied" } },
    },
  ];
  assert.deepEqual(proposalKeysFor(messages), []);
});

test("proposalKeysFor: tolerates missing or empty proposalId without throwing", () => {
  const messages = [
    { role: "assistant", content: "x", attachment: { kind: "preview", data: {} } },
    { role: "assistant", content: "y", attachment: { kind: "preview", data: { proposalId: "" } } },
    { role: "assistant", content: "z", attachment: { kind: "preview", data: { proposalId: "real-id" } } },
  ];
  // Only the message with a non-empty proposalId should produce a key.
  assert.deepEqual(proposalKeysFor(messages), ["proposal:real-id"]);
});

test("proposalKeysFor: empty input -> empty output", () => {
  assert.deepEqual(proposalKeysFor([]), []);
});

// ── isStaleReply ────────────────────────────────────────────────────

test("isStaleReply: same scope -> not stale", () => {
  assert.equal(isStaleReply("repo:a/b", "repo:a/b"), false);
  assert.equal(isStaleReply(NO_CONTEXT_SCOPE, NO_CONTEXT_SCOPE), false);
});

test("isStaleReply: different scopes -> stale", () => {
  // The bug class this guard exists for: user sends a chat on Site A,
  // tab-switches to Site B before the reply lands. Without the check,
  // the reply gets persisted to Site B's bucket. With the check, it's
  // dropped.
  assert.equal(isStaleReply("repo:a/b", "repo:c/d"), true);
  assert.equal(isStaleReply("repo:a/b", "origin:https://other.com"), true);
  assert.equal(isStaleReply("origin:https://x.com", "origin:https://y.com"), true);
  assert.equal(isStaleReply("repo:a/b", NO_CONTEXT_SCOPE), true);
});

// ── tab-switch-during-flight: integration smoke test ────────────────

test("send -> tab switch -> reply: persisting only to sentScope keeps Site B's history clean", async () => {
  // End-to-end simulation of the cross-scope-bleed bug. Sequence:
  //   1. user is on Site A, sends a chat (snapshot scope = repo:A)
  //   2. user switches to Site B (currentScope changes)
  //   3. reply arrives - WITHOUT the isStaleReply guard, it would call
  //      writeScopeHistory(currentScope=B, [...]) and pollute B's bucket
  //   4. WITH the guard, the handler bails and writes nothing
  // The assertion: Site B's bucket still reflects only what the user
  // actually did on Site B, not the leaked reply from Site A.
  reset();
  const sentScope = "repo:org/site-a";
  const currentScope = "repo:org/site-b";

  // User had a separate chat going on Site B.
  await writeScopeHistory(currentScope, [
    { role: "user", content: "B's question", timestamp: 1 },
  ]);

  // Reply for Site A arrives while the user is on Site B.
  if (!isStaleReply(sentScope, currentScope)) {
    await writeScopeHistory(currentScope, [
      { role: "user", content: "B's question", timestamp: 1 },
      { role: "assistant", content: "leaked reply from A", timestamp: 2 },
    ]);
  }

  // Site B must still have only its own message; the leaked reply
  // never made it into B's bucket.
  const bHistory = await readScopeHistory(currentScope);
  assert.equal(bHistory.length, 1);
  assert.equal(bHistory[0].content, "B's question");

  // And Site A's bucket was never written to (the reply was dropped).
  // In the real handler, dropping the reply means the user re-prompts
  // on Site A to recover - acceptable for a tab-switch race.
  const aHistory = await readScopeHistory(sentScope);
  assert.deepEqual(aHistory, []);
});

test("send -> NO tab switch -> reply persists to the originating scope", async () => {
  // Sanity-check the happy path so the guard isn't accidentally
  // dropping legitimate replies.
  reset();
  const sentScope = "repo:org/site-a";
  const currentScope = "repo:org/site-a";

  if (!isStaleReply(sentScope, currentScope)) {
    await writeScopeHistory(currentScope, [
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", content: "hello", timestamp: 2 },
    ]);
  }

  const history = await readScopeHistory(currentScope);
  assert.equal(history.length, 2);
  assert.equal(history[1].role, "assistant");
});

// ── HISTORY_LIMIT contract ──────────────────────────────────────────

test("HISTORY_LIMIT is a sane bounded number", () => {
  // The side panel trims oldest messages beyond this. It's exposed so
  // a future change in scoping or storage doesn't accidentally drop the
  // bound and let a runaway transcript consume chrome.storage.local.
  assert.equal(typeof HISTORY_LIMIT, "number");
  assert.ok(HISTORY_LIMIT > 0 && HISTORY_LIMIT <= 10_000,
    `expected a reasonable HISTORY_LIMIT, got ${HISTORY_LIMIT}`);
});
