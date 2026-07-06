// Memory proposals: merge a `remember` entry into MEMORY.md and build a preview.
// Split out of proposal-engine.ts. mergeMemoryEntry is pure (unit-tested).

import type { ChatMessage, CommitMode, PendingProposal } from "../types";
import { GitHubClient } from "../lib/github";
import { loadPendingProposal, savePendingProposal } from "../lib/proposals";
import { MEMORY_PATH } from "./repo-context";

/**
 * Merge a new memory entry into the existing MEMORY.md content under the right
 * section. Creates the section if it doesn't exist; creates the file (with a
 * header) if `current` is empty. Pure so the merge logic can be tested without
 * GitHub.
 */
export function mergeMemoryEntry(
  current: string,
  entry: string,
  section: string | undefined,
): string {
  const sectionName = (section ?? "Notes").trim() || "Notes";
  const sectionHeader = `## ${sectionName}`;
  const bullet = `- ${entry.trim()}`;

  // Empty file: write a fresh skeleton.
  if (!current.trim()) {
    return `# Shared FreeDocStore memory\n\nThis file is loaded by the FreeDocStore extension on every chat turn. Keep entries durable and short - things the team should remember across sessions and users.\n\n${sectionHeader}\n${bullet}\n`;
  }

  // Existing section: append the bullet at the end of that section
  // (right before the next ## or end of file).
  const lines = current.split("\n");
  let inTarget = false;
  let lastBulletIdx = -1;
  let nextSectionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.trim() === sectionHeader) {
      inTarget = true;
      continue;
    }
    if (inTarget && /^##\s/.test(ln)) {
      nextSectionIdx = i;
      break;
    }
    if (inTarget && /^[-*]\s/.test(ln)) lastBulletIdx = i;
  }

  if (inTarget) {
    // Insert after the last bullet in the section, or right after the
    // header if there are no bullets yet.
    const insertAt = lastBulletIdx >= 0 ? lastBulletIdx + 1 : nextSectionIdx >= 0 ? nextSectionIdx : lines.length;
    lines.splice(insertAt, 0, bullet);
    return lines.join("\n");
  }

  // Section doesn't exist - append at the end of the file.
  const trailing = current.endsWith("\n") ? "" : "\n";
  return `${current}${trailing}\n${sectionHeader}\n${bullet}\n`;
}

/**
 * Build a PendingMemoryProposal from the model's `remember` tool call. Fetches
 * the current MEMORY.md (may be null if the file doesn't exist yet), merges the
 * new entry, and saves the proposal for preview/apply.
 */
export async function buildMemoryProposalPreview(
  gh: GitHubClient,
  owner: string,
  repo: string,
  proposal: { entry: string; section?: string },
  commitMode: CommitMode,
): Promise<ChatMessage> {
  const entry = (proposal.entry ?? "").trim();
  if (!entry) {
    return {
      role: "assistant",
      content: "Model wanted to remember an empty entry. Try a more specific prompt.",
    };
  }

  const file = await gh.getFileOrNull(owner, repo, MEMORY_PATH);
  const currentContent = file?.content ?? "";
  const fileSha = file?.sha ?? null;
  const newContent = mergeMemoryEntry(currentContent, entry, proposal.section);

  // PR title - first 60 chars of entry, prefixed so it's recognisable
  // in the team's PR list as a memory commit and not a docs change.
  const summary = `memory: ${entry.length > 60 ? entry.slice(0, 60) + "…" : entry}`;

  const proposalId = await savePendingProposal({
    kind: "memory",
    owner,
    repo,
    entry,
    section: proposal.section,
    currentContent,
    newContent,
    fileSha,
    summary,
    commitMode,
  });

  const stored = await loadPendingProposal(proposalId);
  return {
    role: "assistant",
    content: `Proposed memory entry under "${proposal.section ?? "Notes"}"`,
    attachment: { kind: "preview", data: stored as PendingProposal },
  };
}
