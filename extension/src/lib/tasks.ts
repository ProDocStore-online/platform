// Task store: every content edit is a task (one board card, one thread).
//
// Two layers, mirroring lib/freedocstore-chat.ts:
//   - Primary: chrome.storage.local under TASKS_KEY. Instant reads for the
//     board + in-page markers, available in every extension context.
//   - Shared:  best-effort mirror to .freedocstore/tasks/<id>.json on the
//     `freedocstore-chat` branch, so teammates' extensions and Claude Code
//     see the same tasks. One file per task = no write conflicts between
//     concurrent tasks.
//
// The backend is swappable by design: a future IssuesTaskStore can satisfy
// the same create/advance surface (the user asked for GitHub Issues as an
// alternative). Everything UI-facing reads through list/getTask, so the
// store can change underneath without touching the board.

import type { Task, TaskStatus } from "../types";
import { GitHubClient } from "./github";
import { loadStoredSettings } from "../settings";
import { CHAT_BRANCH } from "./freedocstore-chat";

export const TASKS_KEY = "docs-chat.tasks";
export const TASKS_DIR = ".freedocstore/tasks";

export function taskFilePath(id: string): string {
  return `${TASKS_DIR}/${id}.json`;
}

/** Deterministic on-disk JSON for a task (pure, for the folder mirror). */
export function serializeTask(task: Task): string {
  return `${JSON.stringify(task, null, 2)}\n`;
}

/**
 * Board column ordering. Cancelled is intentionally omitted - the board
 * hides cancelled tasks by default (still on disk for the record).
 */
export const BOARD_COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "proposed", label: "Proposed" },
  { status: "in_review", label: "In Review" },
  { status: "deployed", label: "Deployed" },
  { status: "done", label: "Done" },
];

// ── local primary store ──────────────────────────────────────────────

export async function listTasks(): Promise<Task[]> {
  const got = await chrome.storage.local.get(TASKS_KEY);
  const arr = got[TASKS_KEY];
  return Array.isArray(arr) ? (arr as Task[]) : [];
}

export async function getTask(id: string): Promise<Task | null> {
  const all = await listTasks();
  return all.find((t) => t.id === id) ?? null;
}

// Serialize read-modify-write on the shared TASKS_KEY array. chrome.storage
// has no atomic RMW, so two overlapping writes each read the same base list
// and the second set() clobbers the first - losing whole tasks, not just
// fields (the exact guard history.ts uses for its transcript store).
//
// This serializes writers WITHIN one JS realm. The intended single writer of
// tasks is the BACKGROUND service worker: the side panel routes its writes
// through TASK_* runtime messages rather than calling these directly, so all
// task writes funnel through this one in-SW queue and never race.
let writeQueue: Promise<unknown> = Promise.resolve();

export async function updateTasks(transform: (tasks: Task[]) => Task[]): Promise<Task[]> {
  const run = writeQueue.then(async () => {
    const all = await listTasks();
    const next = transform(all);
    await chrome.storage.local.set({ [TASKS_KEY]: next });
    return next;
  });
  // Keep the chain alive even if a transform throws, so one failed write
  // doesn't wedge every subsequent one.
  writeQueue = run.catch(() => undefined);
  return run;
}

/**
 * Insert or replace a task by id. New tasks go to the front so the board's
 * most-recent-first ordering is free. Returns the full updated list.
 */
export async function upsertTask(task: Task): Promise<Task[]> {
  return updateTasks((all) => {
    const i = all.findIndex((t) => t.id === task.id);
    if (i >= 0) {
      const copy = all.slice();
      copy[i] = task;
      return copy;
    }
    return [task, ...all];
  });
}

/**
 * Apply a mutator to a single task by id, serialized against all other
 * writes. Returns the updated task, or null if no task with that id exists.
 * The mutator receives a shallow copy and must return the next task value.
 */
export async function mutateTask(
  id: string,
  mutator: (task: Task) => Task,
): Promise<Task | null> {
  let updated: Task | null = null;
  await updateTasks((all) => {
    const i = all.findIndex((t) => t.id === id);
    if (i < 0) return all;
    updated = mutator({ ...all[i] });
    const copy = all.slice();
    copy[i] = updated;
    return copy;
  });
  return updated;
}

/**
 * Merge teammates' tasks (from the repo mirror) with the local ones by id.
 * The newer `updatedAt` wins so a task another person has since advanced shows
 * its latest state, while my own in-flight local edits (not yet mirrored) stay
 * authoritative until I push them. Order is not guaranteed - callers sort.
 */
export function mergeTasks(local: Task[], remote: Task[]): Task[] {
  const byId = new Map<string, Task>();
  for (const t of local) byId.set(t.id, t);
  for (const t of remote) {
    const cur = byId.get(t.id);
    if (!cur || (t.updatedAt ?? 0) > (cur.updatedAt ?? 0)) byId.set(t.id, t);
  }
  return [...byId.values()];
}

/**
 * Read every teammate's task from .freedocstore/tasks/*.json on the conversation
 * branch. Best-effort: returns [] when the folder/branch doesn't exist yet and
 * skips any file that isn't a well-formed task, so a hand-edited or partial
 * file can't break the board. One GitHub request to list the dir + one per
 * file (team task counts are small).
 */
export async function fetchSharedTasks(
  gh: GitHubClient,
  owner: string,
  repo: string,
): Promise<Task[]> {
  const entries = await gh.listDir(owner, repo, TASKS_DIR, CHAT_BRANCH);
  const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".json"));
  const out: Task[] = [];
  for (const f of files) {
    try {
      const file = await gh.getFileOrNull(owner, repo, f.path, CHAT_BRANCH);
      if (!file) continue;
      const parsed = JSON.parse(file.content) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as Task).id === "string") {
        out.push(parsed as Task);
      }
    } catch {
      // best-effort: skip a malformed or unreadable shared task file
    }
  }
  return out;
}

/**
 * Pull every teammate's tasks across all repos present locally, so a UI can
 * merge them without knowing about auth, settings, or the repo set. Builds the
 * GitHub client from stored settings, derives the repos from the local tasks,
 * and reads each repo's shared folder. Best-effort throughout: no client (not
 * signed in) or an unreadable repo just yields fewer remote tasks, never an
 * error. Also returns the current user's login (lowercased) so the caller can
 * highlight "mentions me" without re-reading settings. Keeping this behind the
 * store keeps the board a pure renderer and preserves the swappable-backend
 * contract (everything task-shaped flows through this module).
 *
 * `extraRepos` ("owner/name") are queried in addition to the repos derived from
 * local tasks - so opening the board for a repo you've never personally edited
 * (e.g. via the in-page marker's ?repo=) still surfaces teammates' work there.
 */
export async function fetchAllSharedTasks(
  extraRepos: string[] = [],
): Promise<{ remote: Task[]; myLogin: string | null }> {
  const settings = await loadStoredSettings();
  const myLogin = settings.claude?.githubApp?.username?.toLowerCase() ?? null;
  let gh: GitHubClient | null = null;
  try {
    gh = await GitHubClient.fromSettings(settings);
  } catch {
    return { remote: [], myLogin }; // not signed in / no client - local only
  }
  const repos = Array.from(
    new Set([...(await listTasks()).map((t) => t.repo), ...extraRepos]),
  );
  const remote: Task[] = [];
  for (const full of repos) {
    const [owner, name] = full.split("/");
    if (!owner || !name) continue;
    try {
      remote.push(...(await fetchSharedTasks(gh, owner, name)));
    } catch {
      // best-effort: skip a repo we can't read (no access / offline)
    }
  }
  return { remote, myLogin };
}

// ── shared folder mirror (best-effort) ───────────────────────────────

/**
 * Commit one task's JSON to .freedocstore/tasks/<id>.json on the conversation
 * branch. Creates the branch/file on first write. Callers should treat
 * this as best-effort (wrap in catch) - a mirror failure must never block
 * the local task update or the chat UI.
 */
export async function mirrorTaskToRepo(
  gh: GitHubClient,
  owner: string,
  repo: string,
  task: Task,
): Promise<{ commitUrl: string }> {
  const branch = await gh.ensureBranch(owner, repo, CHAT_BRANCH);
  const path = taskFilePath(task.id);
  const existing = await gh.getFileOrNull(owner, repo, path, branch);
  const commit = await gh.updateFile(
    owner,
    repo,
    path,
    serializeTask(task),
    existing?.sha ?? null,
    branch,
    `task: ${task.status} — ${task.title.slice(0, 60)}`,
  );
  return { commitUrl: commit.html_url };
}
