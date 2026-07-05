// Unit tests for the task store (lib/tasks.ts): the local primary layer,
// the pure serializer/path helpers, and the best-effort repo mirror.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

// chrome.storage.local mock backed by a Map (same shape as history.test).
function installChromeMock() {
  const store = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        get: async (key) => {
          if (key == null) return Object.fromEntries(store);
          const k = typeof key === "string" ? key : Array.isArray(key) ? key[0] : Object.keys(key)[0];
          const v = store.get(k);
          return v === undefined ? {} : { [k]: v };
        },
      },
    },
  };
  return store;
}

const store = installChromeMock();

const {
  TASKS_KEY,
  TASKS_DIR,
  BOARD_COLUMNS,
  taskFilePath,
  serializeTask,
  listTasks,
  getTask,
  upsertTask,
  mutateTask,
  mirrorTaskToRepo,
  mergeTasks,
} = await import(await bundle("src/lib/tasks.ts"));

function mkTask(over = {}) {
  return {
    id: "t1",
    title: "tighten the pickup rule",
    status: "proposed",
    repo: "acme/docs",
    sourcePath: "docs/operations.md",
    summary: "tighten the pickup rule",
    conversation: [{ role: "assistant", content: "did it", timestamp: 1 }],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

test("taskFilePath nests under the tasks dir", () => {
  assert.equal(taskFilePath("abc"), `${TASKS_DIR}/abc.json`);
});

test("mergeTasks: remote-only tasks are added, dedup by id", () => {
  const local = [mkTask({ id: "a" })];
  const remote = [mkTask({ id: "a" }), mkTask({ id: "b" })];
  const merged = mergeTasks(local, remote);
  assert.deepEqual(new Set(merged.map((t) => t.id)), new Set(["a", "b"]));
});

test("mergeTasks: newer updatedAt wins for a shared id", () => {
  const local = [mkTask({ id: "a", updatedAt: 100, summary: "local" })];
  const remoteNewer = [mkTask({ id: "a", updatedAt: 200, summary: "remote" })];
  assert.equal(mergeTasks(local, remoteNewer).find((t) => t.id === "a").summary, "remote");
  const remoteOlder = [mkTask({ id: "a", updatedAt: 50, summary: "remote" })];
  assert.equal(mergeTasks(local, remoteOlder).find((t) => t.id === "a").summary, "local");
});

test("mergeTasks: equal updatedAt keeps the local copy (my in-flight edits win)", () => {
  const local = [mkTask({ id: "a", updatedAt: 100, summary: "local" })];
  const remote = [mkTask({ id: "a", updatedAt: 100, summary: "remote" })];
  assert.equal(mergeTasks(local, remote).find((t) => t.id === "a").summary, "local");
});

test("serializeTask round-trips with a trailing newline", () => {
  const t = mkTask();
  const s = serializeTask(t);
  assert.ok(s.endsWith("\n"));
  assert.deepEqual(JSON.parse(s), t);
});

test("BOARD_COLUMNS exclude cancelled and order the lifecycle", () => {
  assert.deepEqual(
    BOARD_COLUMNS.map((c) => c.status),
    ["proposed", "in_review", "deployed", "done"],
  );
});

test("upsert inserts new tasks at the front, replaces by id", async () => {
  store.clear();
  await upsertTask(mkTask({ id: "a", title: "first" }));
  await upsertTask(mkTask({ id: "b", title: "second" }));
  let all = await listTasks();
  assert.deepEqual(all.map((t) => t.id), ["b", "a"]); // newest first

  // Replace 'a' in place (no reordering, no duplicate).
  await upsertTask(mkTask({ id: "a", title: "first-edited" }));
  all = await listTasks();
  assert.equal(all.length, 2);
  assert.equal(all.find((t) => t.id === "a").title, "first-edited");
});

test("getTask returns the task or null", async () => {
  store.clear();
  await upsertTask(mkTask({ id: "x" }));
  assert.equal((await getTask("x")).id, "x");
  assert.equal(await getTask("nope"), null);
});

test("mirrorTaskToRepo ensures the branch and writes one file per task", async () => {
  const calls = [];
  const gh = {
    ensureBranch: async (o, r, b) => { calls.push(["ensureBranch", o, r, b]); return b; },
    getFileOrNull: async (o, r, p, ref) => { calls.push(["getFileOrNull", p, ref]); return null; },
    updateFile: async (o, r, p, content, sha, branch, msg) => {
      calls.push(["updateFile", p, sha, branch]);
      return { html_url: `https://github.com/${o}/${r}/commit/deadbeef` };
    },
  };
  const t = mkTask({ id: "z9", status: "in_review" });
  const res = await mirrorTaskToRepo(gh, "acme", "docs", t);
  assert.match(res.commitUrl, /commit\/deadbeef/);
  assert.deepEqual(calls[0], ["ensureBranch", "acme", "docs", "freedocstore-chat"]);
  // File path + create (null sha) on the chat branch.
  const upd = calls.find((c) => c[0] === "updateFile");
  assert.deepEqual(upd, ["updateFile", `${TASKS_DIR}/z9.json`, null, "freedocstore-chat"]);
});

test("TASKS_KEY is the storage key the board listens on", () => {
  assert.equal(typeof TASKS_KEY, "string");
  assert.ok(TASKS_KEY.length > 0);
});

test("updateTasks serializes concurrent writes across a slow storage (no lost tasks)", async () => {
  // A storage.get that yields lets a second write interleave. With a naive
  // read-modify-write both callers read the same base list and the second
  // set() clobbers the first, losing a task. The serialized write queue
  // must preserve BOTH.
  const saved = globalThis.chrome;
  const s = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => {
          await new Promise((r) => setTimeout(r, 5)); // force interleave
          const k = typeof key === "string" ? key : Array.isArray(key) ? key[0] : Object.keys(key)[0];
          const v = s.get(k);
          return v === undefined ? {} : { [k]: v };
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) s.set(k, v);
        },
      },
    },
  };
  try {
    await Promise.all([
      upsertTask({ id: "a", title: "A" }),
      upsertTask({ id: "b", title: "B" }),
      upsertTask({ id: "c", title: "C" }),
    ]);
    const ids = (await listTasks()).map((t) => t.id).sort();
    assert.deepEqual(ids, ["a", "b", "c"]);
  } finally {
    globalThis.chrome = saved;
  }
});

test("mutateTask applies a serialized field update and returns the task", async () => {
  const saved = globalThis.chrome;
  const s = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => {
          const k = typeof key === "string" ? key : Array.isArray(key) ? key[0] : Object.keys(key)[0];
          const v = s.get(k);
          return v === undefined ? {} : { [k]: v };
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) s.set(k, v);
        },
      },
    },
  };
  try {
    await upsertTask({ id: "z", title: "Z", conversation: [] });
    const updated = await mutateTask("z", (t) => ({ ...t, conversation: [...t.conversation, { role: "user", content: "hi", timestamp: 1 }] }));
    assert.equal(updated.conversation.length, 1);
    assert.equal((await getTask("z")).conversation[0].content, "hi");
    assert.equal(await mutateTask("missing", (t) => t), null);
  } finally {
    globalThis.chrome = saved;
  }
});
