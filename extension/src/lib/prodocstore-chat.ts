// Mirror a side-panel conversation into the backing GitHub repo.
//
// The side panel keeps the live thread in chrome.storage.local (see
// lib/history.ts). This module is the durable, shareable mirror: it
// commits the same thread as JSON to
//
//   .prodocstore/chat/history.json   on branch `prodocstore-chat`
//
// in the repo the page resolves to. Why a dedicated branch and not the
// default branch:
//   - the site's production deploy runs on the default branch only, so
//     writing the log here never triggers a rebuild/redeploy per turn;
//   - the default branch's history stays free of one-commit-per-turn noise.
//
// Reading it back is deliberately trivial: anything with repo access can
// `git fetch` the branch (or `gh api ...?ref=prodocstore-chat`) and parse
// the JSON - no extension internals required. That's the whole point:
// the repo becomes the shared source of truth for the conversation.

import type { ChatMessage } from "../types";
import type { GitHubClient } from "./github";

export const CHAT_BRANCH = "prodocstore-chat";
export const CHAT_DIR = ".prodocstore/chat";
export const CHAT_FILE = `${CHAT_DIR}/history.json`;

/** On-disk shape of `.prodocstore/chat/history.json`. */
export interface ConversationFile {
  /** Schema version, so a future shape change can be detected on read. */
  version: 1;
  /** "owner/name" of the backing repo, for self-describing files. */
  repo: string;
  /** ISO-8601 timestamp of this write. */
  updatedAt: string;
  /** Convenience count; always equals messages.length. */
  messageCount: number;
  messages: ChatMessage[];
}

/**
 * Render the on-disk JSON for a conversation. Pure (takes `now` rather
 * than reading the clock) so it's deterministically testable. Trailing
 * newline keeps the file POSIX-clean and diff-friendly.
 */
export function serializeConversation(
  repo: string,
  messages: ChatMessage[],
  now: string,
): string {
  const doc: ConversationFile = {
    version: 1,
    repo,
    updatedAt: now,
    messageCount: messages.length,
    messages,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Commit `messages` to `.prodocstore/chat/history.json` on the dedicated
 * conversation branch, creating the branch (and the file) on first write.
 * Returns the commit URL. Idempotent in shape: each call overwrites the
 * single per-repo file with the full current thread.
 */
export async function persistConversation(
  gh: GitHubClient,
  owner: string,
  repo: string,
  messages: ChatMessage[],
  now: string,
): Promise<{ commitUrl: string }> {
  const branch = await gh.ensureBranch(owner, repo, CHAT_BRANCH);
  // Read the existing file ON THE CHAT BRANCH to get its blob sha;
  // updateFile needs it to overwrite (null = create new).
  const existing = await gh.getFileOrNull(owner, repo, CHAT_FILE, branch);
  const content = serializeConversation(`${owner}/${repo}`, messages, now);
  const commit = await gh.updateFile(
    owner,
    repo,
    CHAT_FILE,
    content,
    existing?.sha ?? null,
    branch,
    `chat: update conversation log (${messages.length} message${messages.length === 1 ? "" : "s"})`,
  );
  return { commitUrl: commit.html_url };
}
