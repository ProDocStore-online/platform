// Operator → chat reverse channel: lets a local debug bridge drive the panel
// (inject a prompt, or apply/cancel a pending preview) for scripted testing.
// Extracted from sidepanel.ts. Self-contained: it drives the real form + real
// preview buttons (so the whole normal flow runs) and reads its poll target
// from ./debug-bridge, which returns a URL only when injection is opted in
// (settings.debug.allowInject + a loopback sink). No-op otherwise.

import { dlog, injectBaseUrl } from "./debug-bridge";
import { $ } from "../lib/dom";
import { state } from "./state";

// Resolved in initReverseChannel(), not at module load, so this module stays
// import-safe (no DOM access at import time - it can be bundle-imported in tests
// and never touches the DOM unless injection is actually started).
let promptEl: HTMLTextAreaElement;
let formEl: HTMLFormElement;
let messagesEl: HTMLElement;

// Thread-switch handlers, injected at init rather than imported. Importing
// thread-ui statically would pull in dom-refs' import-time querySelector and
// break this module's import-safety (it must stay bundle-importable in tests);
// the callback slot keeps the dependency one-way and DOM-free at load.
let onNewEdit: (() => void) | null = null;
let onSelectAsk: (() => void) | null = null;

let pendingInject: string | null = null;

function maybeSubmitInject(): void {
  if (!pendingInject || state.sending) return;
  const p = pendingInject;
  pendingInject = null;
  dlog("inject submit", { prompt: p.slice(0, 80) });
  promptEl.value = p;
  formEl.requestSubmit();
}

// Perform an apply/cancel command queued by a local debug collector. We drive
// the REAL button so the whole resolvePreview flow runs. Targets a specific
// proposalId when given, else the latest pending preview on screen.
function handleInjectCommand(cmd: { kind?: string; proposalId?: string }): void {
  // Thread-switch commands let a headless driver reach the edit flow without a
  // manual ✎ click: switch to a fresh edit thread (or back to read-only Ask),
  // then a following injected prompt runs there. Instant (no turn), so the
  // next poll picks up the prompt normally.
  if (cmd.kind === "new_edit") {
    dlog("inject new_edit");
    onNewEdit?.();
    return;
  }
  if (cmd.kind === "select_ask") {
    dlog("inject select_ask");
    onSelectAsk?.();
    return;
  }
  const action = cmd.kind === "cancel" ? "cancel" : "apply";
  let btn: HTMLButtonElement | null = null;
  if (cmd.proposalId) {
    btn = messagesEl.querySelector<HTMLButtonElement>(
      `.preview[data-proposal-id="${CSS.escape(cmd.proposalId)}"] .preview-${action}`,
    );
  }
  if (!btn) {
    const all = messagesEl.querySelectorAll<HTMLButtonElement>(`.preview-${action}`);
    btn = all[all.length - 1] ?? null;
  }
  if (btn && !btn.disabled) {
    dlog(`inject ${action}`, { proposalId: cmd.proposalId ?? "(latest)" });
    btn.click();
  } else {
    dlog(`inject ${action} skipped - no pending preview to act on`, { proposalId: cmd.proposalId });
  }
}

async function pollInjectQueue(): Promise<void> {
  const base = injectBaseUrl();
  if (!base) return;
  // Hold off fetching another while one is staged or a turn is running;
  // just try to flush the staged one (e.g. once the in-flight turn ends).
  if (pendingInject || state.sending) { maybeSubmitInject(); return; }
  try {
    const resp = await fetch(`${base}/pending`, { headers: { "x-freedocstore-debug": "1" } });
    if (!resp.ok) return;
    const data = (await resp.json()) as {
      prompts?: string[];
      commands?: Array<{ kind?: string; proposalId?: string }>;
    };
    const cmd = (data.commands ?? [])[0];
    if (cmd) { handleInjectCommand(cmd); return; }
    const p = (data.prompts ?? [])[0];
    if (typeof p === "string" && p.trim()) {
      pendingInject = p;
      maybeSubmitInject();
    }
  } catch {
    /* collector down - ignore */
  }
}

/** Start polling the debug bridge for injected prompts/commands. Call once.
 * `onNewEdit`/`onSelectAsk` switch threads for the new_edit/select_ask commands
 * (injected here to keep the module import-safe - see the slot declarations). */
export function initReverseChannel(handlers: { onNewEdit: () => void; onSelectAsk: () => void }): void {
  onNewEdit = handlers.onNewEdit;
  onSelectAsk = handlers.onSelectAsk;
  promptEl = $<HTMLTextAreaElement>("#prompt");
  formEl = $<HTMLFormElement>("#chat-form");
  messagesEl = $<HTMLElement>("#messages");
  setInterval(() => { void pollInjectQueue(); }, 1500);
}
