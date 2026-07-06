// Content script: runs in the docs page itself. Extracts context and
// responds to requests from the side panel.

import type { FeatureConfig, NavConfig, RuntimeMessage, PageContext, Task } from "../types";
import { parseFeatureConfig, parseNavConfig, resolveContext } from "../resolver";
import { listTasks, TASKS_KEY } from "../lib/tasks";
import { sendToBg } from "../lib/messaging";

// Idempotency guard. This script is declared for *.pages.dev in the manifest
// AND may be programmatically injected by the side panel (for tabs opened
// before install). Chrome does NOT dedupe those, so without a guard every
// injection re-registers all listeners - stacking duplicate handlers,
// buttons, and network fetches. The isolated-world `window` persists across
// injections, so this flag survives and we register listeners exactly once.
declare global {
  interface Window {
    __prodocstoreInjected?: boolean;
  }
}
const alreadyInjected = window.__prodocstoreInjected === true;
window.__prodocstoreInjected = true;

type RepoRef = { owner: string; name: string } | null;

/**
 * Two-tier JSON fetch for site-side config files (nav.json, features.json).
 *
 * Primary: same-origin fetch. Fast, uses the Cloudflare Access session
 * cookie if any, works without GitHub auth. A proper JSON response wins
 * immediately.
 *
 * Fallback: service-worker proxy to GitHub raw. Triggers when same-origin
 * either fails (network, 404, 302 to login HTML) OR returns content that
 * doesn't parse as the expected JSON shape - CF Pages serves a branded
 * HTML 404 for missing files that's indistinguishable from a real page
 * to the fetch client, so we only trust parse() not the HTTP status.
 */
async function fetchJsonOrRepo<T>(
  path: string,
  repo: RepoRef,
  repoPath: string,
  parse: (raw: string) => T | null,
): Promise<T | null> {
  // Primary: same-origin.
  try {
    const r = await fetch(path, { credentials: "same-origin" });
    if (r.ok) {
      const parsed = parse(await r.text());
      if (parsed) return parsed;
    }
  } catch {
    // network / CORS / etc. - fall through to repo fetch.
  }

  // Fallback: ask the service worker to read the file from GitHub. Skips
  // when we don't know the repo (non-ProDocStore hosts) or the user hasn't
  // signed in (the SW returns { error: "no_github_auth" }).
  if (!repo) return null;
  try {
    const resp = (await sendToBg({
      type: "READ_REPO_FILE",
      owner: repo.owner,
      repo: repo.name,
      path: repoPath,
    })) as { type: string; payload: { content?: string; error?: string } };
    if (resp?.payload?.content) return parse(resp.payload.content);
  } catch {
    // SW unreachable (unlikely in a live extension).
  }
  return null;
}

// ── In-page selection ────────────────────────────────────────────────
//
// The user highlights text on the rendered page to mark exactly what they
// want changed. A floating "Ask / Edit" button appears by the selection;
// clicking it PINS the selection (so it survives clicking into the side
// panel or elsewhere) and opens the unified Ask/Edit start card in the panel.
// The side panel polls GET_SELECTION to show a chip
// and sends the pinned text to the agent as the change target. Because we
// capture rendered TEXT (plus the nearest heading for scope), this works
// regardless of how the page was generated - the agent matches the text
// against the source file, whatever its format.

type SelectionPayload = { text: string; heading?: string };

let pinnedSelection: SelectionPayload | null = null;
// Text the user dismissed via the chip's ✕, so we don't immediately
// re-surface the still-highlighted selection. Cleared when the selection
// changes to something else.
let dismissedText: string | null = null;
let floatBtn: HTMLButtonElement | null = null;
// Whether the side panel is open in this tab's window. All in-page affordances
// (✎ button, edit badge, highlight overlays) are gated on this: when the panel
// is closed the page shows nothing. Seeded from IS_PANEL_OPEN at startup and
// kept live by PANEL_STATE broadcasts from the service worker.
let panelOpen = false;

/** True when the node sits inside site chrome (topbar nav) we never edit. */
function inSiteChrome(node: Node | null): boolean {
  let el: Element | null = node instanceof Element ? node : node?.parentElement ?? null;
  while (el) {
    if (el.tagName === "NAV" || el.getAttribute?.("role") === "navigation") return true;
    el = el.parentElement;
  }
  return false;
}

/** Nearest heading at or above the node - gives the agent a scope anchor. */
function nearestHeading(node: Node | null): string | undefined {
  let el: Element | null = node instanceof Element ? node : node?.parentElement ?? null;
  while (el) {
    let sib: Element | null = el;
    while (sib) {
      if (/^H[1-6]$/.test(sib.tagName)) {
        const t = (sib.textContent ?? "").replace(/\s+/g, " ").trim();
        if (t) return t;
      }
      sib = sib.previousElementSibling;
    }
    el = el.parentElement;
  }
  return undefined;
}

/** The live (unpinned) selection, or null when there's nothing useful. */
function liveSelection(): SelectionPayload | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = sel.toString().replace(/\s+/g, " ").trim();
  if (text.length < 2) return null;
  if (inSiteChrome(sel.anchorNode)) return null;
  return { text, heading: nearestHeading(sel.anchorNode) };
}

/** What GET_SELECTION / page context report: pinned wins, else live. */
function currentSelection(): SelectionPayload | null {
  if (pinnedSelection) return pinnedSelection;
  const live = liveSelection();
  if (!live) return null;
  if (dismissedText && live.text === dismissedText) return null;
  return live;
}

function ensureFloatBtn(): HTMLButtonElement {
  if (floatBtn) return floatBtn;
  const btn = document.createElement("button");
  btn.id = "prodocstore-edit-btn";
  btn.type = "button";
  btn.textContent = "✎ Ask / Edit";
  btn.style.cssText = [
    "position:fixed", "z-index:2147483647", "display:none",
    "padding:5px 10px", "font:600 12px/1.2 system-ui,sans-serif",
    "color:#fff", "background:#1f6feb", "border:0", "border-radius:6px",
    "box-shadow:0 2px 8px rgba(0,0,0,.3)", "cursor:pointer",
    "user-select:none", "-webkit-user-select:none",
  ].join(";");
  // mousedown (not click) so we capture the selection BEFORE the click
  // collapses it, and preventDefault keeps the highlight visible.
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const live = liveSelection();
    if (!live) return;
    pinnedSelection = live;
    dismissedText = null;
    hideFloatBtn();
    // Best-effort nudge so an already-open side panel updates instantly
    // instead of waiting for its next poll. Ignored if nothing listens.
    try {
      void sendToBg({ type: "SELECTION_RESULT", payload: live });
    } catch {
      /* no receiver (panel closed) - the poll will pick it up */
    }
  });
  document.body.appendChild(btn);
  floatBtn = btn;
  return btn;
}

function hideFloatBtn(): void {
  if (floatBtn) floatBtn.style.display = "none";
}

function positionFloatBtn(): void {
  // Only offer the in-page edit affordance while the side panel is open.
  if (!panelOpen) return hideFloatBtn();
  // Don't show a second affordance once a selection is pinned - the chip
  // in the side panel is the live indicator at that point.
  if (pinnedSelection) return hideFloatBtn();
  const live = liveSelection();
  if (!live) return hideFloatBtn();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return hideFloatBtn();
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return hideFloatBtn();
  const btn = ensureFloatBtn();
  // Anchor just below the end of the selection, clamped to the viewport.
  const top = Math.min(rect.bottom + 6, window.innerHeight - 34);
  const left = Math.min(Math.max(rect.left, 8), window.innerWidth - 96);
  btn.style.top = `${Math.max(8, top)}px`;
  btn.style.left = `${left}px`;
  btn.style.display = "block";
}

let selDebounce: number | undefined;
function onSelectionActivity(): void {
  window.clearTimeout(selDebounce);
  selDebounce = window.setTimeout(positionFloatBtn, 120);
}
if (!alreadyInjected) {
  document.addEventListener("mouseup", onSelectionActivity, true);
  document.addEventListener("keyup", onSelectionActivity, true);
  document.addEventListener("selectionchange", () => {
    // A brand-new selection clears a prior dismissal so the chip can return.
    const live = liveSelection();
    if (live && dismissedText && live.text !== dismissedText) dismissedText = null;
    onSelectionActivity();
  });
}

async function getPageContext(): Promise<PageContext> {
  const html = document.documentElement.outerHTML;
  // Visible text: strip script/style/nav before reading textContent.
  // We KEEP <header> and <footer> - they usually carry real content
  // (page hero, copyright, edit links) that users ask about. <nav> is
  // the topbar, identical on every page, so it's just token noise.
  const clone = document.body.cloneNode(true) as HTMLElement;
  // Also drop OUR injected "✎ Ask / Edit" button: it lives in the light DOM, so
  // it survives the clone and would otherwise concatenate its label into
  // the page text we send the model in read mode. (The marker/highlight hosts
  // are closed shadow roots - their content isn't cloned - so they don't leak.)
  clone.querySelectorAll("script, style, nav, #prodocstore-edit-btn").forEach((n) => n.remove());
  const text = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
  // Resolve the repo up front so both fetches share the fallback target.
  const shell = resolveContext(location.href, html, text, document.title);
  // Parallel: the two fetches are independent, usually resolve in one
  // round-trip each, so Promise.all cuts panel-open latency in half.
  const [navConfig, features] = await Promise.all([
    fetchJsonOrRepo<NavConfig>("/nav.json", shell.repo, "docs/nav.json", parseNavConfig),
    fetchJsonOrRepo<FeatureConfig>("/features.json", shell.repo, "docs/features.json", parseFeatureConfig),
  ]);
  return { ...shell, navConfig, features, selection: currentSelection() };
}

// ── In-page progress marker ──────────────────────────────────────────
//
// A small badge shown on any page that has active edit tasks (proposed /
// in review) targeting THIS page's source file. Clicking it opens the tasks
// board, focused on the task (or filtered to the repo when there are
// several). Data comes from chrome.storage.local (the task store's primary
// layer), which content scripts can read directly; it refreshes live as
// tasks change.

let markerBtn: HTMLButtonElement | null = null;

// The marker renders inside a CLOSED shadow root. Content scripts share the
// page DOM, so a plain element's text/title (which include task titles the
// user or agent authored) would be readable by the page's own scripts - and
// the repo/path that select which tasks show are derived from page-supplied
// meta, so a hostile *.pages.dev site could name any repo and read them.
// A closed shadow root is not reachable via `host.shadowRoot` (returns null),
// so page scripts cannot read the marker's contents.
function ensureMarker(): HTMLButtonElement {
  if (markerBtn) return markerBtn;
  const host = document.createElement("div");
  host.style.cssText = "all:initial";
  const shadow = host.attachShadow({ mode: "closed" });
  const btn = document.createElement("button");
  btn.type = "button";
  btn.style.cssText = [
    "position:fixed", "right:16px", "bottom:16px", "z-index:2147483646",
    "display:none", "align-items:center", "gap:6px",
    "padding:7px 12px", "font:600 12px/1.2 system-ui,sans-serif",
    "color:#fff", "background:#1f6feb", "border:0", "border-radius:999px",
    "box-shadow:0 3px 12px rgba(0,0,0,.35)", "cursor:pointer",
  ].join(";");
  shadow.appendChild(btn);
  document.body.appendChild(host);
  markerBtn = btn;
  return btn;
}

function hideMarker(): void {
  if (markerBtn) markerBtn.style.display = "none";
}

function renderMarker(active: Task[], repoKey: string): void {
  if (active.length === 0) return hideMarker();
  const btn = ensureMarker();
  const inReview = active.filter((t) => t.status === "in_review").length;
  const label = active.length === 1 ? "1 edit in progress" : `${active.length} edits in progress`;
  const dot = inReview > 0 ? "◉" : "◍"; // filled once something's in review
  btn.textContent = `${dot} ${label}`;
  btn.title = active.map((t) => `• ${t.title} [${t.status}]`).join("\n");
  btn.onclick = (e) => {
    // Ignore synthetic clicks: only a real user gesture opens the board.
    if (!e.isTrusted) return;
    void sendToBg({
      type: "OPEN_BOARD",
      taskId: active.length === 1 ? active[0].id : undefined,
      repo: repoKey,
    });
  };
  btn.style.display = "inline-flex";
}

// ── In-page edit highlight ───────────────────────────────────────────
//
// Beyond the corner badge, draw an outline over the EXACT section each
// in-progress edit targets. An edit targets repo *source* (markdown), which
// doesn't map cleanly to the rendered DOM - but the task stores the user's
// on-page SELECTION (rendered text + nearest heading), which does. We locate
// the tightest element containing that text and outline it. When the side
// panel focuses an edit thread (FOCUS_EDIT), that one gets a bright outline +
// scroll-into-view; the rest stay as subtle passive outlines.
//
// Overlay boxes are position:fixed, pointer-events:none, inside a CLOSED shadow
// root - we NEVER mutate page DOM (no reflow, fully reversible). Boxes track
// their element on scroll/resize.

let highlightHost: HTMLElement | null = null;
let highlightLayer: HTMLElement | null = null;
type Highlight = { el: Element; box: HTMLElement };
let highlights: Highlight[] = [];
let focusedEditTaskId: string | null = null;
// Set when focus is (re)assigned; consumed by the next render that manages to
// draw the focused box. Survives a render where the task isn't on the page yet
// (e.g. right after a cross-page navigation) so the scroll still happens once
// the section appears - without re-scrolling on every passive re-render.
let pendingFocusScroll = false;
let repositionQueued = false;

function ensureHighlightLayer(): HTMLElement {
  if (highlightLayer) return highlightLayer;
  const host = document.createElement("div");
  host.style.cssText = "all:initial";
  const shadow = host.attachShadow({ mode: "closed" });
  const layer = document.createElement("div");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483645";
  shadow.appendChild(layer);
  document.body.appendChild(host);
  highlightHost = host;
  highlightLayer = layer;
  return layer;
}

function normText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Find the tightest element whose visible text contains `target`. When a
// heading is given, prefer a match sitting under that same heading (the same
// text can appear in several sections); fall back to an unscoped match.
function findEditElement(target: string, heading?: string): Element | null {
  const want = normText(target);
  if (want.length < 2) return null;
  const SEL =
    "p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,pre,code,figcaption,caption,dd,dt,a,span,table,tr,thead,tbody,section,article,div";
  const pick = (requireHeading: boolean): Element | null => {
    let best: Element | null = null;
    let bestLen = Infinity;
    for (const el of Array.from(document.body.querySelectorAll(SEL))) {
      if (highlightHost?.contains(el)) continue; // skip our own overlay
      if (inSiteChrome(el)) continue;
      const t = normText(el.textContent ?? "");
      if (!t.includes(want)) continue;
      if (requireHeading && normText(nearestHeading(el) ?? "") !== normText(heading ?? "")) continue;
      if (t.length < bestLen) {
        best = el;
        bestLen = t.length;
      }
    }
    return best;
  };
  return (heading ? pick(true) : null) ?? pick(false);
}

function positionBox(box: HTMLElement, el: Element): void {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  box.style.top = `${r.top}px`;
  box.style.left = `${r.left}px`;
  box.style.width = `${r.width}px`;
  box.style.height = `${r.height}px`;
}

function repositionHighlights(): void {
  for (const h of highlights) positionBox(h.box, h.el);
}

function scheduleReposition(): void {
  if (repositionQueued) return;
  repositionQueued = true;
  requestAnimationFrame(() => {
    repositionQueued = false;
    repositionHighlights();
  });
}

function clearHighlights(): void {
  for (const h of highlights) h.box.remove();
  highlights = [];
}

function styleBox(box: HTMLElement, focus: boolean): void {
  box.style.cssText = [
    "position:fixed",
    "pointer-events:none",
    "box-sizing:border-box",
    "border-radius:4px",
    focus ? "border:2px solid #06f4b1" : "border:2px dashed #1f6feb",
    focus ? "background:rgba(6,244,177,.14)" : "background:rgba(31,111,235,.07)",
    "box-shadow:0 0 0 2px rgba(0,0,0,.04)",
    "transition:top .12s ease,left .12s ease,width .12s ease,height .12s ease",
  ].join(";");
}

// The 💬 button pinned to a highlight box: clicking it opens that edit's thread
// in the (already-open) side panel. pointer-events:auto so only the button is
// clickable - the rest of the box stays click-through to the page.
function makeOpenThreadButton(taskId: string, focus: boolean): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "💬";
  btn.title = "Open this edit in the panel";
  btn.style.cssText = [
    "position:absolute",
    "top:-11px",
    "right:-11px",
    "width:22px",
    "height:22px",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "padding:0",
    "font:12px/1 system-ui,sans-serif",
    "color:#fff",
    focus ? "background:#06b98a" : "background:#1f6feb",
    "border:none",
    "border-radius:50%",
    "box-shadow:0 1px 5px rgba(0,0,0,.45)",
    "cursor:pointer",
    "pointer-events:auto",
  ].join(";");
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Fire-and-forget: the panel handles FOCUS_EDIT_THREAD; the SW just acks.
    void chrome.runtime.sendMessage({ type: "FOCUS_EDIT_THREAD", taskId }).catch(() => {});
  });
  return btn;
}

function renderHighlights(active: Task[]): void {
  clearHighlights();
  if (active.length === 0) return;
  const layer = ensureHighlightLayer();
  // Dedupe by matched element: two edits whose anchors resolve to the SAME
  // rendered element would otherwise stack two boxes on the identical rect.
  const boxByEl = new Map<Element, HTMLElement>();
  for (const t of active) {
    // Precise anchor = the user's selection; fallback = a phrase pulled from
    // the edit's find text (for edits typed without selecting anything).
    const text = t.selection?.text ?? t.anchorText;
    if (!text) continue; // no on-page anchor at all -> badge still shows
    const el = findEditElement(text, t.selection?.heading ?? undefined);
    if (!el) continue;
    const focus = focusedEditTaskId === t.id;
    const existing = boxByEl.get(el);
    if (existing) {
      // Element already outlined by another edit: just upgrade to the focused
      // style if THIS task is the focused one.
      if (focus) styleBox(existing, true);
      continue;
    }
    const box = document.createElement("div");
    styleBox(box, focus);
    box.appendChild(makeOpenThreadButton(t.id, focus));
    layer.appendChild(box);
    positionBox(box, el);
    highlights.push({ el, box });
    boxByEl.set(el, box);
    if (focus && pendingFocusScroll) {
      pendingFocusScroll = false;
      try {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch {
        /* older engines: ignore */
      }
    }
  }
}

let markerTimer: number | undefined;
let lastActive: Task[] = [];
async function updateMarker(): Promise<void> {
  // The edit badge + section highlights only show while the side panel is open.
  if (!panelOpen) {
    lastActive = [];
    hideMarker();
    clearHighlights();
    return;
  }
  try {
    const ctx = resolveContext(location.href, document.documentElement.outerHTML, "", document.title);
    if (!ctx.repo) {
      lastActive = [];
      hideMarker();
      clearHighlights();
      return;
    }
    const repoKey = `${ctx.repo.owner}/${ctx.repo.name}`;
    const tasks = await listTasks();
    // Outline every live edit for THIS page - proposed, in_review, deployed, or
    // done - until it's archived. Archiving is how you clear a page's outlines;
    // a cancelled edit never happened, so it's excluded.
    const onThisPage = tasks.filter(
      (t) => t.repo === repoKey && t.sourcePath === ctx.sourcePath && !t.archived && t.status !== "cancelled",
    );
    // The corner badge stays "in progress" (proposed / in_review) so it doesn't
    // count edits that have already shipped.
    const inProgress = onThisPage.filter((t) => t.status === "proposed" || t.status === "in_review");
    lastActive = onThisPage;
    renderMarker(inProgress, repoKey);
    renderHighlights(onThisPage);
  } catch {
    lastActive = []; // match the early-return branches so a later FOCUS_EDIT
    hideMarker();     // can't redraw stale highlights from a failed pass
    clearHighlights();
  }
}
function scheduleMarker(): void {
  window.clearTimeout(markerTimer);
  markerTimer = window.setTimeout(updateMarker, 200);
}

// Ask the SW whether the panel is already open in this window (it may have
// opened before this content script loaded), then paint. Best-effort: on any
// failure panelOpen stays false and the page shows no in-page UI until a
// PANEL_STATE broadcast says otherwise.
async function initPanelState(): Promise<void> {
  try {
    const resp = (await sendToBg({ type: "IS_PANEL_OPEN" })) as
      | { type: "IS_PANEL_OPEN_RESULT"; payload: { open: boolean } }
      | undefined;
    panelOpen = resp?.payload?.open === true;
  } catch {
    panelOpen = false;
  }
  scheduleMarker();
}

// Initial paint + live updates as tasks change in storage.
if (!alreadyInjected) {
  void initPanelState();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[TASKS_KEY]) scheduleMarker();
  });
  // Edit-highlight boxes are position:fixed at their element's viewport rect,
  // so they must be re-placed whenever the page scrolls or reflows.
  window.addEventListener("scroll", scheduleReposition, { passive: true, capture: true });
  window.addEventListener("resize", scheduleReposition, { passive: true });
}

if (!alreadyInjected)
  chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.type === "GET_PAGE_CONTEXT") {
    // Async response: return true to keep the message channel open until
    // sendResponse is called. A rejected promise here would hang the
    // sidepanel (no response ever arrives), so always reply - null payload
    // if we couldn't build a context.
    getPageContext()
      .then((ctx) => sendResponse({ type: "PAGE_CONTEXT_RESULT", payload: ctx }))
      .catch(() => sendResponse({ type: "PAGE_CONTEXT_RESULT", payload: null }));
    return true;
  }
  if (msg.type === "GET_SELECTION") {
    // Synchronous: the side panel polls this to drive the selection chip.
    sendResponse({ type: "SELECTION_RESULT", payload: currentSelection() });
    return; // no async work
  }
  if (msg.type === "CLEAR_SELECTION") {
    // Chip ✕ or post-send cleanup. Drop the pin and remember the text so a
    // still-highlighted selection doesn't immediately re-surface.
    dismissedText = pinnedSelection?.text ?? liveSelection()?.text ?? null;
    pinnedSelection = null;
    hideFloatBtn();
    return;
  }
  if (msg.type === "PANEL_STATE") {
    // Panel opened/closed in this window: show or hide all in-page affordances
    // live. On close, tear everything down now; on open, repaint the badge +
    // highlights (the ✎ button reappears on the next selection).
    panelOpen = msg.open;
    if (!panelOpen) {
      // Panel closed: its compose state is torn down, so any pinned selection is
      // now orphaned. Release it (and any dismissal) so a fresh panel session
      // starts clean and the "Ask / Edit" button reappears on the next
      // selection instead of staying suppressed by a stale pin.
      pinnedSelection = null;
      dismissedText = null;
      hideFloatBtn();
      hideMarker();
      clearHighlights();
    } else {
      scheduleMarker();
    }
    return;
  }
  if (msg.type === "FOCUS_EDIT") {
    // Panel selected/left an edit thread: brighten + scroll to that section
    // (or clear focus). Re-render against the last-known active tasks so the
    // focused box restyles immediately without waiting on a storage tick. Arm
    // a one-shot scroll when focusing a task - if the task isn't on the page
    // yet (just navigated here), the pending flag makes the next render scroll.
    focusedEditTaskId = msg.taskId;
    pendingFocusScroll = msg.taskId != null;
    renderHighlights(lastActive);
    return;
  }
});
