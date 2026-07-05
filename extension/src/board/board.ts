// Tasks board: renders every edit task as a card in its lifecycle column.
// Reads chrome.storage.local (the task store's primary layer) and re-renders
// live on storage changes, so a proposal/apply/cancel in the side panel
// shows up here without a refresh. Click a card for the full thread.

import type { Task, TaskStatus } from "../types";
import { listTasks, fetchAllSharedTasks, mergeTasks, BOARD_COLUMNS, TASKS_KEY } from "../lib/tasks";
import { isHttpUrl } from "../lib/text";
import { statusLabelFor, ageLabel } from "../lib/task-format";
import { $, el } from "../lib/dom";
import { avatarEl } from "../lib/avatar";
import { sendToBg } from "../lib/messaging";

const boardEl = $("#board");
const repoFilterEl = $<HTMLSelectElement>("#repo-filter");
const taskCountEl = $("#task-count");
const detailEl = $<HTMLElement>("#detail");
const detailScrim = $<HTMLElement>("#detail-scrim");
const detailTitle = $("#detail-title");
const detailBody = $("#detail-body");
const viewKanbanBtn = $<HTMLButtonElement>("#view-kanban");
const viewListBtn = $<HTMLButtonElement>("#view-list");
const showArchivedEl = $<HTMLInputElement>("#show-archived");
const showCancelledEl = $<HTMLInputElement>("#show-cancelled");
const personFilterEl = $<HTMLSelectElement>("#person-filter");
const syncBtn = $<HTMLButtonElement>("#sync-btn");

let repoFilter = "";
let personFilter = "";
// Teammates' tasks pulled from the repo mirror (.freedocstore/tasks/*.json),
// merged with the local store on render. Populated by syncRemote(); empty
// until the first sync completes so the board shows instantly from local.
let remoteTasks: Task[] = [];
// Ids present in THIS browser's local store. A synced teammate's task exists
// only in `remoteTasks`, so its lifecycle/archive actions (which mutate local
// storage via the SW) would silently no-op - gate them off for those.
let localTaskIds = new Set<string>();
// The current user's GitHub login (lowercase), for the "you're mentioned"
// highlight. Resolved from settings on the first sync; null until then.
let myLogin: string | null = null;
let showArchived = false;
// Cancelled tasks are hidden by default in BOTH views (so the Kanban/List
// count never jumps when you toggle views). Turn this on to surface them - the
// Kanban then grows a Cancelled column and the List includes them.
let showCancelled = false;
// Kanban (lifecycle columns) or List (flat, newest-first, every stage incl.
// cancelled). Persisted so the choice sticks across opens.
let view: "kanban" | "list" = "kanban";
try {
  const v = localStorage.getItem("docs-chat.board-view");
  if (v === "list" || v === "kanban") view = v;
} catch {
  /* localStorage blocked - default kanban */
}

// True when the current user is @-mentioned in the task's thread.
function mentionsMe(task: Task): boolean {
  return !!myLogin && !!task.mentions?.includes(myLogin);
}

// "avatar + @login" chip for a task's requester, used in card + list meta.
function requesterChip(login: string): HTMLElement {
  const s = el("span", "by-who");
  s.appendChild(avatarEl(login, 16));
  s.appendChild(el("span", undefined, `@${login}`));
  return s;
}

function renderCard(task: Task): HTMLElement {
  const card = el("div", `card status-${task.status}${task.archived ? " archived" : ""}${mentionsMe(task) ? " mentions-me" : ""}`);
  const title = el("div", "card-title", task.title);
  if (mentionsMe(task)) title.appendChild(el("span", "mention-chip", "@you"));
  card.appendChild(title);

  const meta = el("div", "card-meta");
  meta.appendChild(el("span", undefined, task.sourcePath));
  if (task.requestedBy) meta.appendChild(requesterChip(task.requestedBy));
  if (task.pr) meta.appendChild(el("span", undefined, `PR #${task.pr.number}`));
  meta.appendChild(el("span", undefined, ageLabel(task.updatedAt)));
  card.appendChild(meta);

  if (task.selection?.text) {
    const sel = el("div", "card-sel", `“${task.selection.text}”`);
    card.appendChild(sel);
  }

  card.addEventListener("click", () => openDetail(task));
  return card;
}

function renderBoard(tasks: Task[]): void {
  boardEl.replaceChildren();

  const visible = tasks
    .filter((t) => showCancelled || t.status !== "cancelled")
    .filter((t) => showArchived || !t.archived)
    .filter((t) => !repoFilter || t.repo === repoFilter)
    .filter((t) => matchesPerson(t));

  taskCountEl.textContent = `${visible.length} task${visible.length === 1 ? "" : "s"}`;

  if (visible.length === 0) {
    boardEl.appendChild(
      el(
        "div",
        "empty-state",
        "No tasks yet. Propose an edit in the side panel and it shows up here.",
      ),
    );
    return;
  }

  // The Cancelled column only appears when the user opts in, so an abandoned
  // task stays reachable (to reopen) without cluttering the default board.
  const columns = showCancelled
    ? [...BOARD_COLUMNS, { status: "cancelled" as TaskStatus, label: "Cancelled" }]
    : BOARD_COLUMNS;
  for (const col of columns) {
    const column = el("div", "column");
    const head = el("div", "column-head");
    head.appendChild(el("span", undefined, col.label));
    const inCol = visible
      .filter((t) => t.status === col.status)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    head.appendChild(el("span", "count", String(inCol.length)));
    column.appendChild(head);

    if (inCol.length === 0) {
      column.appendChild(el("div", "column-empty", "—"));
    } else {
      for (const task of inCol) column.appendChild(renderCard(task));
    }
    boardEl.appendChild(column);
  }
}

// Flat list view: every task (all stages, including cancelled) as a row with
// a prominent status badge, newest-updated first, respecting the repo filter.
function renderList(tasks: Task[]): void {
  boardEl.replaceChildren();

  const visible = tasks
    .filter((t) => showCancelled || t.status !== "cancelled")
    .filter((t) => !repoFilter || t.repo === repoFilter)
    .filter((t) => showArchived || !t.archived)
    .filter((t) => matchesPerson(t))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  taskCountEl.textContent = `${visible.length} task${visible.length === 1 ? "" : "s"}`;

  if (visible.length === 0) {
    boardEl.appendChild(
      el("div", "empty-state", "No tasks yet. Propose an edit in the side panel and it shows up here."),
    );
    return;
  }

  const list = el("div", "list");
  for (const task of visible) {
    const row = el("div", `list-row status-${task.status}${task.archived ? " archived" : ""}${mentionsMe(task) ? " mentions-me" : ""}`);
    row.appendChild(el("span", `badge status-${task.status}`, statusLabelFor(task.status)));

    const main = el("div", "list-main");
    const title = el("div", "list-title", task.title);
    if (mentionsMe(task)) title.appendChild(el("span", "mention-chip", "@you"));
    main.appendChild(title);
    const meta = el("div", "list-meta");
    meta.appendChild(el("span", undefined, task.repo));
    meta.appendChild(el("span", undefined, task.sourcePath));
    if (task.requestedBy) meta.appendChild(requesterChip(task.requestedBy));
    if (task.pr) meta.appendChild(el("span", undefined, `PR #${task.pr.number}`));
    meta.appendChild(el("span", undefined, ageLabel(task.updatedAt)));
    main.appendChild(meta);
    row.appendChild(main);

    row.addEventListener("click", () => openDetail(task));
    list.appendChild(row);
  }
  boardEl.appendChild(list);
}

// Dispatch to the active view. Also toggles the layout class on the board
// container (kanban is a flex row of columns; list is a single block).
function render(tasks: Task[]): void {
  boardEl.classList.toggle("as-list", view === "list");
  if (view === "list") renderList(tasks);
  else renderBoard(tasks);
}

function renderRepoFilter(tasks: Task[]): void {
  const repos = Array.from(new Set(tasks.map((t) => t.repo))).sort();
  const current = repoFilter;
  repoFilterEl.replaceChildren();
  repoFilterEl.appendChild(new Option("All repos", ""));
  for (const r of repos) repoFilterEl.appendChild(new Option(r, r));
  repoFilterEl.value = repos.includes(current) ? current : "";
  repoFilter = repoFilterEl.value;
}

// Synthetic person-filter values. Underscores can't appear in a GitHub login,
// so these never collide with a real person: NO_PERSON selects pre-attribution
// tasks; MENTIONS_ME selects tasks that tag the current user.
const NO_PERSON = "__none__";
const MENTIONS_ME = "__mentions_me__";

function matchesPerson(t: Task): boolean {
  if (!personFilter) return true;
  if (personFilter === MENTIONS_ME) return mentionsMe(t);
  if (personFilter === NO_PERSON) return !t.requestedBy;
  return t.requestedBy === personFilter;
}

function renderPersonFilter(tasks: Task[]): void {
  const people = Array.from(
    new Set(tasks.map((t) => t.requestedBy).filter((p): p is string => !!p)),
  ).sort();
  const hasUnattributed = tasks.some((t) => !t.requestedBy);
  const canMentionMe = !!myLogin && tasks.some((t) => mentionsMe(t));
  const current = personFilter;
  personFilterEl.replaceChildren();
  personFilterEl.appendChild(new Option("Everyone", ""));
  if (canMentionMe) personFilterEl.appendChild(new Option("Mentions me", MENTIONS_ME));
  for (const p of people) personFilterEl.appendChild(new Option(`@${p}`, p));
  if (hasUnattributed) personFilterEl.appendChild(new Option("(unattributed)", NO_PERSON));
  const valid =
    current === MENTIONS_ME ? canMentionMe
    : current === NO_PERSON ? hasUnattributed
    : people.includes(current);
  personFilterEl.value = valid ? current : "";
  personFilter = personFilterEl.value;
}

// ── detail drawer ────────────────────────────────────────────────────

function addLink(parent: HTMLElement, label: string, url: string): void {
  // Task data is nominally untrusted (persisted, rendered later); never
  // assign a non-http(s) scheme to href (blocks javascript:/data: links).
  if (!isHttpUrl(url)) {
    parent.appendChild(el("span", "detail-row", label));
    return;
  }
  const a = el("a", "detail-link", label) as HTMLAnchorElement;
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener";
  parent.appendChild(a);
}

function openDetail(task: Task): void {
  detailTitle.textContent = task.title;
  detailBody.replaceChildren();

  // Status + links
  detailBody.appendChild(el("h3", undefined, "Status"));
  const statusRow = el("div", "detail-row");
  statusRow.appendChild(el("span", `badge status-${task.status}`, statusLabelFor(task.status)));
  detailBody.appendChild(statusRow);
  if (task.pr) {
    const row = el("div", "detail-row");
    addLink(row, `Pull request #${task.pr.number}`, task.pr.url);
    detailBody.appendChild(row);
  }
  if (task.commit) {
    const row = el("div", "detail-row");
    addLink(row, `Commit ${task.commit.sha.slice(0, 7)}`, task.commit.url);
    detailBody.appendChild(row);
  }

  // Target
  detailBody.appendChild(el("h3", undefined, "Target"));
  detailBody.appendChild(el("div", "detail-row", `${task.repo} · ${task.sourcePath}`));
  if (task.requestedBy) {
    const row = el("div", "detail-row");
    row.appendChild(document.createTextNode("Requested by "));
    row.appendChild(requesterChip(task.requestedBy));
    detailBody.appendChild(row);
  }
  if (task.mentions?.length) {
    const row = el("div", "detail-row");
    row.appendChild(document.createTextNode("Tagged: "));
    for (const m of task.mentions) row.appendChild(requesterChip(m));
    detailBody.appendChild(row);
  }
  if (task.pageUrl) {
    const row = el("div", "detail-row");
    addLink(row, "Open the published page", task.pageUrl);
    detailBody.appendChild(row);
  }

  // Selection
  if (task.selection?.text) {
    detailBody.appendChild(el("h3", undefined, "Selected content"));
    if (task.selection.heading) {
      detailBody.appendChild(el("div", "detail-row", `Under “${task.selection.heading}”`));
    }
    detailBody.appendChild(el("div", "sel-quote", task.selection.text));
  }

  // Thread
  detailBody.appendChild(el("h3", undefined, "Thread"));
  for (const m of task.conversation) {
    const msg = el("div", "thread-msg");
    const roleRow = el("div", "role");
    // User turns get the author's avatar (the per-turn author, falling back to
    // the task's requester); assistant turns get a neutral bot glyph.
    if (m.role === "user") {
      roleRow.appendChild(avatarEl(m.author ?? task.requestedBy ?? null, 16));
      roleRow.appendChild(el("span", undefined, m.author ? `@${m.author}` : "user"));
    } else {
      roleRow.appendChild(el("span", undefined, "🤖 assistant"));
    }
    msg.appendChild(roleRow);
    msg.appendChild(el("div", undefined, m.content));
    detailBody.appendChild(msg);
  }

  if (!localTaskIds.has(task.id)) {
    // A synced teammate's task lives only in the shared repo, not this browser's
    // local store — the lifecycle/archive actions mutate local storage, so they'd
    // silently do nothing. Show a read-only note instead of dead buttons.
    const note = el(
      "div",
      "detail-actions",
      task.requestedBy
        ? `Read-only — @${task.requestedBy}'s edit, synced from the repo. They can act on it from their own panel.`
        : "Read-only — this edit was synced from the shared repo, not created in this browser.",
    );
    note.style.color = "var(--text-muted)";
    detailBody.appendChild(note);
  } else {
    // Actions — drive the lifecycle (the automatic apply/PR transitions can only
    // reach proposed/in_review/deployed; Done and Reopen are manual), plus
    // Archive. Routed through the SW so the board never writes storage directly.
    const actions = el("div", "detail-actions");
    const stageBtn = (label: string, next: TaskStatus) => {
      const b = el("button", "detail-stage", label);
      b.addEventListener("click", async () => {
        await setStatus(task.id, next);
        closeDetail();
      });
      actions.appendChild(b);
    };
    if (task.status === "in_review" || task.status === "deployed") stageBtn("Mark done", "done");
    if (task.status === "done" || task.status === "cancelled") {
      stageBtn("Reopen", task.pr ? "in_review" : task.commit ? "deployed" : "proposed");
    }
    if (task.status === "proposed" || task.status === "in_review" || task.status === "deployed") {
      stageBtn("Cancel", "cancelled");
    }
    const archBtn = el("button", "detail-archive", task.archived ? "Unarchive" : "Archive");
    archBtn.addEventListener("click", async () => {
      await setArchived(task.id, !task.archived);
      closeDetail();
    });
    actions.appendChild(archBtn);
    detailBody.appendChild(actions);
  }

  detailEl.hidden = false;
  detailScrim.hidden = false;
}

function closeDetail(): void {
  detailEl.hidden = true;
  detailScrim.hidden = true;
}

$("#detail-close").addEventListener("click", closeDetail);
detailScrim.addEventListener("click", closeDetail);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDetail();
});

repoFilterEl.addEventListener("change", () => {
  repoFilter = repoFilterEl.value;
  void refresh();
});

personFilterEl.addEventListener("change", () => {
  personFilter = personFilterEl.value;
  void refresh();
});

showArchivedEl.addEventListener("change", () => {
  showArchived = showArchivedEl.checked;
  void refresh();
});

showCancelledEl.addEventListener("change", () => {
  showCancelled = showCancelledEl.checked;
  void refresh();
});

syncBtn.addEventListener("click", () => void syncRemote());

// Archive/unarchive via the service worker (single-writer discipline - the
// board never writes chrome.storage.local directly).
async function setArchived(taskId: string, archived: boolean): Promise<void> {
  try {
    await sendToBg({ type: "SET_TASK_ARCHIVED", taskId, archived });
  } catch {
    /* SW asleep/unreachable - the storage listener will refresh on next change */
  }
}

async function setStatus(taskId: string, status: TaskStatus): Promise<void> {
  try {
    await sendToBg({ type: "SET_TASK_STATUS", taskId, status });
  } catch {
    /* SW asleep/unreachable - the storage listener will refresh on next change */
  }
}

// Kanban ⇄ List toggle.
function setView(next: "kanban" | "list"): void {
  view = next;
  try {
    localStorage.setItem("docs-chat.board-view", next);
  } catch {
    /* ignore */
  }
  viewKanbanBtn.setAttribute("aria-pressed", String(next === "kanban"));
  viewListBtn.setAttribute("aria-pressed", String(next === "list"));
  void refresh();
}
viewKanbanBtn.addEventListener("click", () => setView("kanban"));
viewListBtn.addEventListener("click", () => setView("list"));
// Reflect the persisted view on the toggle at startup.
viewKanbanBtn.setAttribute("aria-pressed", String(view === "kanban"));
viewListBtn.setAttribute("aria-pressed", String(view === "list"));

// ── load + live updates ──────────────────────────────────────────────

// Deep-link params from the in-page marker: ?repo filters the board and
// ?task auto-opens that task's thread on first load.
const urlParams = new URLSearchParams(location.search);
const focusTaskId = urlParams.get("task");
const repoParam = urlParams.get("repo");
if (repoParam) repoFilter = repoParam;

async function refresh(focus = false): Promise<void> {
  let tasks: Task[];
  try {
    const local = await listTasks();
    localTaskIds = new Set(local.map((t) => t.id));
    tasks = mergeTasks(local, remoteTasks);
  } catch (err) {
    boardEl.replaceChildren(
      el("div", "empty-state", `Couldn't load tasks: ${(err as Error)?.message ?? "storage error"}`),
    );
    return;
  }
  renderRepoFilter(tasks);
  renderPersonFilter(tasks);
  render(tasks);
  if (focus && focusTaskId) {
    const t = tasks.find((x) => x.id === focusTaskId);
    if (t) openDetail(t);
  }
}

// Pull teammates' tasks (the store handles auth + the repo set) and merge them
// in. Best-effort: a missing token or an offline box just leaves the board on
// its local view. Spins the button while it runs so the sync is visible.
let syncing = false;
async function syncRemote(): Promise<void> {
  if (syncing) return;
  syncing = true;
  syncBtn.classList.add("spinning");
  try {
    // Include the deep-linked repo (?repo=) even if we have no local tasks there
    // yet, so opening the board from a page's marker shows teammates' edits.
    const { remote, myLogin: who } = await fetchAllSharedTasks(repoParam ? [repoParam] : []);
    remoteTasks = remote;
    myLogin = who;
    await refresh();
  } finally {
    syncing = false;
    syncBtn.classList.remove("spinning");
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[TASKS_KEY]) void refresh();
});

void refresh(true);
// Pull teammates' tasks in the background once the local board is up.
void syncRemote();
