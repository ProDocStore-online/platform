// Edit + create-page proposals: build a before/after preview + a board task from
// the model's edit_file / create_page call. No commit happens here - Apply calls
// applyPendingProposal() later. Split out of proposal-engine.ts.

import type { ChatMessage, CommitMode, PageContext, PendingProposal, Task } from "../types";
import type { MultiTurnResult } from "../lib/openai";
import type { CreateProposal } from "../lib/tools";
import { getTask, upsertTask } from "../lib/tasks";
import { GitHubClient } from "../lib/github";
import { applyEdits } from "../lib/edits";
import { isValidReadPath } from "./openai-tools";
import { loadPendingProposal, savePendingProposal } from "../lib/proposals";
import { anchorFromFind } from "./proposal-shared";
import { parseMentions, mergeMentions } from "../lib/mentions";

// The board task an edit/create proposal opens (or reopens, for a follow-up).
// Identical shape for both builders - only sourcePath differs - so it lives here
// once. Follow-ups keep identity/title/createdAt and re-open as "proposed".
function buildProposalTask(
  prior: Task | null,
  args: {
    taskId: string;
    owner: string;
    repo: string;
    context: PageContext;
    sourcePath: string;
    summary: string;
    rationale?: string;
    proposalId: string;
    anchorText?: string;
    userPrompt: string;
    requestedBy?: string;
    now: number;
  },
): Task {
  const { taskId, owner, repo, context, sourcePath, summary, rationale, proposalId, anchorText, userPrompt, requestedBy, now } = args;
  const assistantLine = rationale ? `${summary}\n\n${rationale}` : summary;
  const mergedMentions = mergeMentions(prior?.mentions, parseMentions(userPrompt));
  // Keep the field off tasks that tag nobody so the mirrored JSON stays clean.
  const mentions = mergedMentions.length ? mergedMentions : undefined;
  return prior
    ? {
        // Follow-up: keep identity/title/createdAt; re-open as proposed with
        // the new proposal and append the new turn to the thread.
        ...prior,
        status: "proposed",
        sourcePath,
        proposalId,
        summary,
        rationale,
        anchorText: anchorText ?? prior.anchorText,
        // Attribution is set once at creation; a follow-up keeps the original
        // requester (falling back to the current identity for pre-attribution
        // tasks that never had one).
        requestedBy: prior.requestedBy ?? requestedBy,
        mentions,
        conversation: [
          ...prior.conversation,
          // Attribute the user turn to whoever drove THIS turn (not the original
          // requester), so a follow-up by a teammate shows their avatar.
          { role: "user", content: userPrompt, timestamp: now, author: requestedBy },
          { role: "assistant", content: assistantLine, timestamp: now },
        ],
        updatedAt: now,
      }
    : {
        id: taskId,
        title: summary,
        status: "proposed",
        repo: `${owner}/${repo}`,
        sourcePath,
        pageUrl: context.url,
        selection: context.selection ?? null,
        anchorText,
        requestedBy,
        mentions,
        summary,
        rationale,
        proposalId,
        conversation: [
          { role: "user", content: userPrompt, timestamp: now, author: requestedBy },
          { role: "assistant", content: assistantLine, timestamp: now },
        ],
        createdAt: now,
        updatedAt: now,
      };
}

/**
 * Build a PendingEditProposal from the model's edit_file call. Targets
 * proposal.path (or context.sourcePath when omitted). Fetches the target file,
 * applies edits in memory, and returns a preview message with the diff data
 * attached - no commit happens here.
 */
export async function buildEditProposalPreview(
  gh: GitHubClient,
  owner: string,
  repo: string,
  context: PageContext,
  upfrontFile: { content: string; sha: string | null } | null,
  result: Extract<MultiTurnResult, { kind: "edit" }>,
  commitMode: CommitMode,
  userPrompt: string,
  existingTaskId?: string,
): Promise<ChatMessage> {
  const { edits, summary, rationale } = result.proposal;
  const requestedPath = result.proposal.path?.trim();
  const targetPath = requestedPath || context.sourcePath;

  // Validate the EFFECTIVE target, not just a model-supplied path. When the
  // model omits `path` we fall back to context.sourcePath, which is derived
  // from an attacker-controllable page; without this check a spoofed
  // source-path meta could steer a commit to .github/workflows/*.yml or
  // other non-docs files in any repo the user can push to.
  if (!isValidReadPath(targetPath)) {
    return {
      role: "assistant",
      content: `Refusing to edit ${targetPath} - edits are restricted to docs/<name> with a .html/.md/.mdx extension.`,
    };
  }

  if (!edits?.length) {
    return {
      role: "assistant",
      content: "Model returned an empty edit list. Try a more specific prompt.",
    };
  }

  // Cross-page edit: fetch the target file fresh. Same-page: reuse the
  // upfront fetch (which may be an unapplied draft, whose sha is null for a
  // still-uncreated page) so we don't burn an API call.
  let target: { content: string; sha: string | null };
  if (targetPath === context.sourcePath && upfrontFile) {
    target = upfrontFile;
  } else {
    try {
      const fetched = await gh.getFile(owner, repo, targetPath);
      target = { content: fetched.content, sha: fetched.sha };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A 404 means the model tried to EDIT a file that doesn't exist yet -
      // almost always because it should have created a new page. Say so plainly
      // instead of a raw API error, so the user knows to ask for a new page.
      if (/\b404\b|not found/i.test(msg)) {
        return {
          role: "assistant",
          content: `\`${targetPath}\` doesn't exist yet, so there's nothing to edit. To add it as a NEW page, ask me to "create a ${targetPath.replace(/^docs\//, "").replace(/\.(md|mdx|html)$/, "")} page" and I'll draft the whole file.`,
        };
      }
      return { role: "assistant", content: `Couldn't fetch ${targetPath}: ${msg}` };
    }
  }

  const { content: editedContent, outcomes, changed } = applyEdits(target.content, edits);

  if (!changed) {
    const lines = outcomes.map((o, i) => {
      const reason = o.reason ?? "not_found";
      return `  ${i + 1}. ${reason}: ${o.op.find.slice(0, 60)}...`;
    });
    return {
      role: "assistant",
      content:
        `No edit applied to ${targetPath}. The model proposed ${edits.length} edit(s) but none matched the live file:\n\n` +
        lines.join("\n"),
    };
  }

  // Reuse an existing edit thread's task when this is a follow-up edit, so
  // the change revises the SAME card/file instead of spawning a new one.
  // Otherwise mint a fresh id up front so the proposal can reference it.
  const prior = existingTaskId ? await getTask(existingTaskId) : null;
  // Honour a caller-supplied id even when the task doesn't exist yet: a new
  // edit thread mints its id client-side so its messages are already tagged
  // to it, and the first proposal must create the task under that same id.
  const taskId = prior?.id ?? existingTaskId ?? crypto.randomUUID();
  const proposalId = await savePendingProposal({
    kind: "edit",
    taskId,
    owner,
    repo,
    path: targetPath,
    summary,
    rationale,
    outcomes: outcomes.map((o) => ({
      find: o.op.find,
      replace: o.op.replace,
      applied: o.applied,
      reason: o.reason,
    })),
    editedContent,
    fileSha: target.sha,
    commitMode,
  });

  // Open a board task in the "proposed" column. Local-only at propose time:
  // the board updates instantly from chrome.storage.local, and we DON'T
  // commit to the repo yet (proposals are frequent and many get cancelled -
  // mirroring each one would add a GitHub round-trip to every preview and
  // churn the branch). The repo mirror happens on Apply, when the change
  // becomes real (see advanceTaskOnApply).
  // Best-effort on-page anchor for the in-page highlight when the user didn't
  // select anything: the longest contiguous rendered-text run from an applied
  // edit's find (markdown delimiters stripped). A selection, when present, is
  // more precise and takes priority (anchorText stays undefined).
  const anchorText = context.selection?.text
    ? undefined
    : outcomes
        .filter((o) => o.applied)
        .map((o) => anchorFromFind(o.op.find))
        .find(Boolean);

  const now = Date.now();
  const task = buildProposalTask(prior, {
    taskId, owner, repo, context, sourcePath: targetPath,
    summary, rationale, proposalId, anchorText, userPrompt,
    requestedBy: gh.login ?? undefined, now,
  });
  await upsertTask(task);

  const skipped = outcomes.filter((o) => !o.applied).length;
  const skipNote = skipped ? ` (${skipped} skipped)` : "";
  const stored = await loadPendingProposal(proposalId);
  return {
    role: "assistant",
    // Name the repo explicitly: repo identity comes from a page meta tag
    // with no origin binding, so the user must see WHERE a commit lands
    // before clicking Apply.
    content: `Proposed change to ${owner}/${repo} · ${targetPath}: ${summary}${skipNote}`,
    attachment: { kind: "preview", data: stored as PendingProposal },
  };
}

/**
 * Build a preview for CREATING a brand-new page (create_page tool). Unlike an
 * edit, there's no existing file to fetch or find/replace against: we take the
 * model's full content, store it as an edit proposal with a null fileSha (which
 * makes Apply create rather than update the file), and open a board task. The
 * preview reuses the edit UI - a single "applied" outcome whose replace is the
 * whole new page, rendered as markdown.
 */
export async function buildCreatePageProposalPreview(
  owner: string,
  repo: string,
  context: PageContext,
  proposal: CreateProposal,
  commitMode: CommitMode,
  userPrompt: string,
  existingTaskId?: string,
  requestedBy?: string,
): Promise<ChatMessage> {
  const path = proposal.path?.trim();
  if (!path || !isValidReadPath(path)) {
    return {
      role: "assistant",
      content: `Refusing to create ${path || "(no path)"} - new pages must be docs/<name> with a .html/.md/.mdx extension.`,
    };
  }
  const content = proposal.content ?? "";
  if (!content.trim()) {
    return {
      role: "assistant",
      content: "The model returned empty content for the new page. Try again with more detail about what the page should contain.",
    };
  }
  const summary = proposal.summary?.trim() || `Add ${path}`;
  const rationale = proposal.rationale;

  const prior = existingTaskId ? await getTask(existingTaskId) : null;
  const taskId = prior?.id ?? existingTaskId ?? crypto.randomUUID();
  const proposalId = await savePendingProposal({
    kind: "edit",
    taskId,
    owner,
    repo,
    path,
    summary,
    rationale,
    // Single synthetic outcome: the whole file is the "replace". find is empty
    // (unused on apply - editedContent + null sha drive the create).
    outcomes: [{ find: "", replace: content, applied: true }],
    editedContent: content,
    fileSha: null,
    commitMode,
  });

  const anchorText = context.selection?.text ? undefined : anchorFromFind(content);
  const now = Date.now();
  const task = buildProposalTask(prior, {
    taskId, owner, repo, context, sourcePath: path,
    summary, rationale, proposalId, anchorText, userPrompt, requestedBy, now,
  });
  await upsertTask(task);

  const stored = await loadPendingProposal(proposalId);
  // Menu tip depends on how the site builds its nav. HTML (FreeDocStore) sites use
  // docs/nav.json (editable via update_nav_config). Markdown (MkDocs/Zensical/
  // Docusaurus) sites drive the menu from the generator's config or auto-nav -
  // which docs-chat can't edit (it's outside docs/), so don't send the user
  // down a dead-end "add to nav.json" path there.
  const isMarkdown = /\.(md|mdx)$/i.test(path);
  const menuTip = isMarkdown
    ? `_Tip: on a Markdown site the page joins the menu when the generator's nav includes it. If your nav is auto-generated from the \`docs/\` folder it's already covered once this deploys; if it's an explicit list in the generator config, add \`${path}\` there._`
    : `_Tip: to add it to the site menu, ask me to "add ${path} to the nav" after this lands._`;
  return {
    role: "assistant",
    content: `Proposed NEW page ${owner}/${repo} · ${path}: ${summary}\n\n${menuTip}`,
    attachment: { kind: "preview", data: stored as PendingProposal },
  };
}
