// Platform-native private KB store over D1. No GitHub source of truth.
// All functions take the D1Database binding directly so they stay Env-agnostic.

export type Role = "owner" | "admin" | "editor" | "reviewer" | "viewer";
const ROLE_RANK: Record<Role, number> = { owner: 5, admin: 4, editor: 3, reviewer: 2, viewer: 1 };
export function roleAtLeast(role: Role | null, min: Role): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[min];
}

export interface Org { id: string; slug: string; name: string; plan: string; seats: number; created_by: string; created_at: number }
export interface KnowledgeBase { id: string; org_id: string; slug: string; title: string; description: string | null; visibility: string; custom_domain: string | null; created_by: string; created_at: number; updated_at: number }
export interface Page { id: string; kb_id: string; path: string; title: string | null; content: string; updated_by: string | null; updated_at: number }
export interface Proposal { id: string; kb_id: string; page_id: string; status: string; summary: string | null; rationale: string | null; base_content: string; content: string; origin: string; created_by: string; created_at: number; decided_by: string | null; decided_at: number | null }

const now = () => Date.now();
const uuid = () => crypto.randomUUID();

export async function upsertUser(db: D1Database, u: { id: string; email?: string; name?: string; avatarUrl?: string }): Promise<void> {
  await db.prepare(
    `INSERT INTO users (id, email, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, avatar_url = excluded.avatar_url`,
  ).bind(u.id, u.email ?? null, u.name ?? null, u.avatarUrl ?? null, now()).run();
}

export async function createOrg(db: D1Database, input: { slug: string; name: string; userId: string }): Promise<Org> {
  const org: Org = { id: uuid(), slug: input.slug, name: input.name, plan: "trial", seats: 3, created_by: input.userId, created_at: now() };
  await db.batch([
    db.prepare(`INSERT INTO orgs (id, slug, name, plan, seats, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(org.id, org.slug, org.name, org.plan, org.seats, org.created_by, org.created_at),
    db.prepare(`INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`)
      .bind(org.id, input.userId, now()),
  ]);
  return org;
}

export async function getOrgBySlug(db: D1Database, slug: string): Promise<Org | null> {
  return db.prepare(`SELECT * FROM orgs WHERE slug = ?`).bind(slug).first<Org>();
}

export async function listOrgsForUser(db: D1Database, userId: string): Promise<Array<Org & { role: Role }>> {
  const { results } = await db.prepare(
    `SELECT o.*, m.role FROM orgs o JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.created_at DESC`,
  ).bind(userId).all<Org & { role: Role }>();
  return results ?? [];
}

export async function getRole(db: D1Database, orgId: string, userId: string): Promise<Role | null> {
  const row = await db.prepare(`SELECT role FROM memberships WHERE org_id = ? AND user_id = ?`).bind(orgId, userId).first<{ role: Role }>();
  return row?.role ?? null;
}

export async function createKb(db: D1Database, input: { orgId: string; slug: string; title: string; description?: string; userId: string }): Promise<KnowledgeBase> {
  const kb: KnowledgeBase = {
    id: uuid(), org_id: input.orgId, slug: input.slug, title: input.title, description: input.description ?? null,
    visibility: "private", custom_domain: null, created_by: input.userId, created_at: now(), updated_at: now(),
  };
  await db.prepare(
    `INSERT INTO knowledge_bases (id, org_id, slug, title, description, visibility, custom_domain, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'private', NULL, ?, ?, ?)`,
  ).bind(kb.id, kb.org_id, kb.slug, kb.title, kb.description, kb.created_by, kb.created_at, kb.updated_at).run();
  return kb;
}

export async function listKbs(db: D1Database, orgId: string): Promise<KnowledgeBase[]> {
  const { results } = await db.prepare(`SELECT * FROM knowledge_bases WHERE org_id = ? ORDER BY updated_at DESC`).bind(orgId).all<KnowledgeBase>();
  return results ?? [];
}

export async function getKb(db: D1Database, kbId: string): Promise<KnowledgeBase | null> {
  return db.prepare(`SELECT * FROM knowledge_bases WHERE id = ?`).bind(kbId).first<KnowledgeBase>();
}

export async function listPages(db: D1Database, kbId: string): Promise<Array<Omit<Page, "content">>> {
  const { results } = await db.prepare(`SELECT id, kb_id, path, title, updated_by, updated_at FROM pages WHERE kb_id = ? ORDER BY path`).bind(kbId).all<Omit<Page, "content">>();
  return results ?? [];
}

export async function getPage(db: D1Database, kbId: string, path: string): Promise<Page | null> {
  return db.prepare(`SELECT * FROM pages WHERE kb_id = ? AND path = ?`).bind(kbId, path).first<Page>();
}

export async function upsertPage(db: D1Database, input: { kbId: string; path: string; title?: string; content: string; userId: string }): Promise<Page> {
  const existing = await getPage(db, input.kbId, input.path);
  const ts = now();
  if (existing) {
    await db.prepare(`UPDATE pages SET title = ?, content = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
      .bind(input.title ?? existing.title, input.content, input.userId, ts, existing.id).run();
    await touchKb(db, input.kbId, ts);
    return { ...existing, title: input.title ?? existing.title, content: input.content, updated_by: input.userId, updated_at: ts };
  }
  const page: Page = { id: uuid(), kb_id: input.kbId, path: input.path, title: input.title ?? null, content: input.content, updated_by: input.userId, updated_at: ts };
  await db.prepare(`INSERT INTO pages (id, kb_id, path, title, content, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(page.id, page.kb_id, page.path, page.title, page.content, page.updated_by, page.updated_at).run();
  await touchKb(db, input.kbId, ts);
  return page;
}

async function touchKb(db: D1Database, kbId: string, ts: number): Promise<void> {
  await db.prepare(`UPDATE knowledge_bases SET updated_at = ? WHERE id = ?`).bind(ts, kbId).run();
}

export async function createProposal(db: D1Database, input: {
  kbId: string; path: string; title?: string; summary?: string; rationale?: string; content: string; origin?: string; userId: string;
}): Promise<Proposal> {
  // Ensure the target page exists (empty base if brand-new) so the diff has a baseline.
  const page = (await getPage(db, input.kbId, input.path)) ?? (await upsertPage(db, { kbId: input.kbId, path: input.path, title: input.title, content: "", userId: input.userId }));
  const p: Proposal = {
    id: uuid(), kb_id: input.kbId, page_id: page.id, status: "open", summary: input.summary ?? null, rationale: input.rationale ?? null,
    base_content: page.content, content: input.content, origin: input.origin ?? "console", created_by: input.userId, created_at: now(), decided_by: null, decided_at: null,
  };
  await db.prepare(
    `INSERT INTO proposals (id, kb_id, page_id, status, summary, rationale, base_content, content, origin, created_by, created_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(p.id, p.kb_id, p.page_id, p.summary, p.rationale, p.base_content, p.content, p.origin, p.created_by, p.created_at).run();
  return p;
}

export async function listProposals(db: D1Database, kbId: string, status?: string): Promise<Proposal[]> {
  const q = status
    ? db.prepare(`SELECT * FROM proposals WHERE kb_id = ? AND status = ? ORDER BY created_at DESC`).bind(kbId, status)
    : db.prepare(`SELECT * FROM proposals WHERE kb_id = ? ORDER BY created_at DESC`).bind(kbId);
  const { results } = await q.all<Proposal>();
  return results ?? [];
}

export async function getProposal(db: D1Database, id: string): Promise<Proposal | null> {
  return db.prepare(`SELECT * FROM proposals WHERE id = ?`).bind(id).first<Proposal>();
}

/** Approve + apply: write the proposal content onto its page, mark it applied. */
export async function applyProposal(db: D1Database, id: string, userId: string): Promise<Proposal | null> {
  const p = await getProposal(db, id);
  if (!p || p.status !== "open") return null;
  const ts = now();
  await db.batch([
    db.prepare(`UPDATE pages SET content = ?, updated_by = ?, updated_at = ? WHERE id = ?`).bind(p.content, userId, ts, p.page_id),
    db.prepare(`UPDATE proposals SET status = 'applied', decided_by = ?, decided_at = ? WHERE id = ?`).bind(userId, ts, id),
    db.prepare(`UPDATE knowledge_bases SET updated_at = ? WHERE id = ?`).bind(ts, p.kb_id),
  ]);
  return { ...p, status: "applied", decided_by: userId, decided_at: ts };
}

export async function decideProposal(db: D1Database, id: string, status: "rejected", userId: string): Promise<void> {
  await db.prepare(`UPDATE proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'open'`).bind(status, userId, now(), id).run();
}

export async function recordUsage(db: D1Database, input: { orgId: string; userId?: string; provider: string; model: string; prompt: number; completion: number; total: number }): Promise<void> {
  await db.prepare(
    `INSERT INTO ai_usage (id, org_id, user_id, provider, model, prompt_tokens, completion_tokens, total_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(uuid(), input.orgId, input.userId ?? null, input.provider, input.model, input.prompt, input.completion, input.total, now()).run();
}
