// Proposal preview card: the structured diff (edit / memory / nav) plus the
// Apply / Cancel actions, rendered under an assistant message. Pure DOM build
// extracted from sidepanel.ts; the two state-coupled actions (apply, cancel)
// are injected so this module owns no panel state. The "Applying…" button
// feedback stays here (pure DOM); the side effects it triggers live in onApply.

import type { PendingProposal } from "../types";
import { renderMarkdown } from "../lib/markdown";

export interface PreviewActions {
  onApply: (proposalId: string, container: HTMLElement) => void;
  onCancel: (proposalId: string, container: HTMLElement) => void;
}

export function renderPreview(
  proposal: PendingProposal,
  container: HTMLElement,
  act: PreviewActions,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "preview";
  wrap.dataset.proposalId = proposal.proposalId;

  const targetPath =
    proposal.kind === "edit" ? proposal.path
    : proposal.kind === "memory" ? ".freedocstore/MEMORY.md"
    : (proposal.path ?? "docs/nav.json");
  const header = document.createElement("div");
  header.className = "preview-header";
  header.textContent = targetPath;
  wrap.appendChild(header);

  if (proposal.kind === "edit") {
    // Show only the FINAL version of each change, rendered as real markdown
    // (so a table shows as a table, not raw pipes). The original text isn't
    // shown here — it stays on the page you're editing.
    for (const o of proposal.outcomes) {
      const block = document.createElement("div");
      block.className = `preview-edit ${o.applied ? "applied" : "skipped"}`;
      if (!o.applied) {
        // A skipped op never produced a final version — say why, and show the
        // snippet we couldn't place so the miss is diagnosable.
        const note = document.createElement("div");
        note.className = "preview-note";
        note.textContent = `skipped: ${o.reason ?? "not_found"} (couldn't locate the text to change)`;
        block.appendChild(note);
      } else {
        const body = document.createElement("div");
        body.className = "preview-body md";
        body.appendChild(renderMarkdown(o.replace));
        block.appendChild(body);
      }
      wrap.appendChild(block);
    }
  } else if (proposal.kind === "memory") {
    const sectionNote = document.createElement("div");
    sectionNote.className = "preview-note";
    sectionNote.textContent = `Adding under "## ${proposal.section ?? "Notes"}":`;
    wrap.appendChild(sectionNote);
    const body = document.createElement("div");
    body.className = "preview-body md";
    body.appendChild(renderMarkdown(`- ${proposal.entry}`));
    wrap.appendChild(body);
  } else {
    // Nav
    const note = document.createElement("div");
    note.className = "preview-note";
    note.textContent = `Proposed ${targetPath}:`;
    wrap.appendChild(note);
    const pre = document.createElement("pre");
    pre.className = "diff-replace";
    pre.textContent = proposal.newContent;
    wrap.appendChild(pre);
  }

  const actions = document.createElement("div");
  actions.className = "preview-actions";
  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "preview-apply";
  const isDirectPush = proposal.commitMode === "direct";
  applyBtn.textContent = isDirectPush ? "Apply (push to main)" : "Apply (open PR)";
  // SINGLE click. Apply is already the deliberate confirm step - you reviewed
  // the preview and chose to apply - so a second "Confirm" click here just read
  // as "nothing happened" (people clicked once, saw the label flip, and thought
  // the status hadn't changed). The commit fires on the first click.
  applyBtn.addEventListener("click", () => {
    if (applyBtn.disabled) return;
    // Immediate, unmistakable feedback: the button becomes a disabled
    // "Applying…"; onApply drives the banner pill + the actual commit.
    applyBtn.textContent = "Applying…";
    applyBtn.classList.add("applying");
    applyBtn.disabled = true;
    act.onApply(proposal.proposalId, container);
  });
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "preview-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => act.onCancel(proposal.proposalId, container));
  actions.appendChild(applyBtn);
  actions.appendChild(cancelBtn);
  wrap.appendChild(actions);

  return wrap;
}
