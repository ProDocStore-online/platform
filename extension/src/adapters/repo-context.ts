// Per-repo context the adapters load into the system prompt each chat turn:
// the shared team memory (.prodocstore/MEMORY.md) and the recent-activity log.
//
// Both are fetched from GitHub and cached in a service-worker memory map
// (lifetime = SW, TTL = 5 min) because they ride in the system prompt on EVERY
// turn and can't be refetched each time without burning the rate limit. Apply
// invalidates the relevant cache so the next turn sees the just-committed state.
//
// Extracted from proposal-engine.ts (which re-exports these for the adapter
// barrel + tests) to keep that file focused on building/applying proposals.

import type { GitHubClient, RecentCommit } from "../lib/github";
import type { PendingProposal } from "../types";

/** Shared per-repo memory file. Lives outside docs/ so it doesn't deploy. */
export const MEMORY_PATH = ".prodocstore/MEMORY.md";

// Match Claude Code's documented eager-load cap so the model anchors on
// recent durable facts without burning context on a runaway memory file.
const MEMORY_CAP_BYTES = 25_000;
const MEMORY_CAP_LINES = 200;

// Per-(owner/repo) caches. TTL = 5 minutes - same trade-off as permsCache.
const ACTIVITY_TTL_MS = 5 * 60_000;
const activityCache = new Map<string, { value: RecentCommit[]; fetchedAt: number }>();
// Same shape, separate cache so memory + activity are invalidated
// independently (memory rarely changes; activity changes per push).
const memoryCache = new Map<string, { value: string | null; fetchedAt: number }>();

export async function getRecentActivity(
  gh: GitHubClient,
  owner: string,
  repo: string,
): Promise<RecentCommit[]> {
  const key = `${gh.authFingerprint()}:${owner}/${repo}`;
  const cached = activityCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ACTIVITY_TTL_MS) return cached.value;
  try {
    const commits = await gh.listRecentCommits(owner, repo, "docs", 30, 20);
    activityCache.set(key, { value: commits, fetchedAt: Date.now() });
    return commits;
  } catch {
    // Network glitch / rate limit / 404 - skip the activity block this
    // turn rather than failing the whole chat. Don't cache failures so
    // a transient error doesn't lock the user out for 5 minutes.
    return [];
  }
}

/**
 * Drop the cached memory and/or activity for a repo after a successful
 * Apply. Without this the next chat turn would still see the pre-apply
 * snapshot for up to 5 minutes:
 *  - memory apply -> memoryCache shows old MEMORY.md, model thinks the
 *    entry it just added doesn't exist
 *  - edit/nav apply -> activityCache hides the new commit
 * Direct cache.delete is fine because both caches lazy-fetch on miss.
 *
 * Exported for tests so we can assert the call in isolation.
 */
export function invalidateCachesAfterApply(
  proposal: PendingProposal,
  owner: string,
  repo: string,
  gh: GitHubClient,
): void {
  const key = `${gh.authFingerprint()}:${owner}/${repo}`;
  // Edit + nav land a new commit, which means the activity log is stale.
  if (proposal.kind === "edit" || proposal.kind === "nav") {
    activityCache.delete(key);
  }
  // Memory writes mutate MEMORY.md AND land a commit, so both go.
  if (proposal.kind === "memory") {
    memoryCache.delete(key);
    activityCache.delete(key);
  }
}

/**
 * Read .prodocstore/MEMORY.md from the repo. Returns null when the file
 * doesn't exist (unsigned-in users, KBs that haven't adopted memory
 * yet) and on transient fetch failures. Cached per-(owner/repo) for
 * 5 minutes since memory edits are infrequent compared to chat turns.
 */
export async function getRepoMemory(
  gh: GitHubClient,
  owner: string,
  repo: string,
): Promise<string | null> {
  const key = `${gh.authFingerprint()}:${owner}/${repo}`;
  const cached = memoryCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ACTIVITY_TTL_MS) return cached.value;
  try {
    const file = await gh.getFileOrNull(owner, repo, MEMORY_PATH);
    const value = file ? file.content : null;
    memoryCache.set(key, { value, fetchedAt: Date.now() });
    return value;
  } catch {
    // Don't cache failures - same trade-off as the activity log: a
    // transient blip shouldn't lock the user out of memory for 5 min.
    return null;
  }
}

/**
 * Format MEMORY.md as a system-prompt prefix block. Capped at the same
 * eager-load limit Claude Code uses (200 lines / 25KB whichever is
 * smaller) so a runaway memory file can't crowd out the live page
 * content. Returns "" when there's no memory so callers can blindly
 * concatenate.
 */
export function formatMemoryBlock(content: string | null): string {
  if (!content) return "";
  const trimmed = content.trim();
  if (!trimmed) return "";
  // Cap by lines first (cheap), then by bytes if still over.
  const lines = trimmed.split("\n").slice(0, MEMORY_CAP_LINES).join("\n");
  const capped = lines.length > MEMORY_CAP_BYTES
    ? lines.slice(0, MEMORY_CAP_BYTES) + "\n[...memory truncated at 25KB...]"
    : lines;
  return [
    "Shared team memory for this repo (.prodocstore/MEMORY.md):",
    capped,
    "",
  ].join("\n");
}

/**
 * Format the activity log as a system-prompt prefix block. Yields an
 * empty string when there are no commits, so the caller can blindly
 * concatenate without producing a stray "(none)" header.
 */
export function formatActivityBlock(commits: RecentCommit[]): string {
  if (!commits.length) return "";
  const lines = commits.map((c) => {
    const day = c.date.slice(0, 10) || "????-??-??";
    return `- ${day} ${c.author}: "${c.message}"`;
  });
  return [
    "Recent docs activity in this repo (latest first, last 30 days):",
    ...lines,
    "",
  ].join("\n");
}
