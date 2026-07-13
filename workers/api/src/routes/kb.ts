import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { type Env, type Variables, type Session } from "../types";
import {
  type Role,
  roleAtLeast,
  upsertUser,
  createOrg,
  listOrgsForUser,
  getOrgBySlug,
  getRole,
  createKb,
  listKbs,
  getKb,
  listPages,
  getPage,
  upsertPage,
  createProposal,
  listProposals,
  getProposal,
  applyProposal,
  decideProposal,
} from "../lib/db";

type App = Hono<{ Bindings: Env; Variables: Variables }>;
type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function readBody<T>(c: Ctx): Promise<Partial<T>> {
  return c.req.json<Partial<T>>().catch(() => ({}) as Partial<T>);
}

async function authed(c: Ctx): Promise<Session> {
  const session = c.get("session");
  if (!session) throw new HTTPException(401, { message: "Authentication required" });
  await upsertUser(c.env.DB, {
    id: session.user.id, email: session.user.email, name: session.user.name, avatarUrl: session.user.avatarUrl,
  });
  return session;
}

/** Resolve the caller's role for a KB (via its org). Returns null if not a member. */
async function kbAccess(env: Env, kbId: string, userId: string): Promise<{ kb: Awaited<ReturnType<typeof getKb>>; role: Role | null }> {
  const kb = await getKb(env.DB, kbId);
  if (!kb) return { kb: null, role: null };
  const role = await getRole(env.DB, kb.org_id, userId);
  return { kb, role };
}

export function registerKbRoutes(app: App): void {
  // — Orgs —
  app.post("/api/orgs", async (c) => {
    const session = await authed(c);
    const body = await readBody<{ slug?: string; name?: string }>(c);
    const slug = (body.slug ?? "").trim().toLowerCase();
    const name = (body.name ?? "").trim();
    if (!SLUG.test(slug)) return c.json({ error: "slug must be lowercase letters, digits, dashes" }, 400);
    if (!name) return c.json({ error: "name is required" }, 400);
    if (await getOrgBySlug(c.env.DB, slug)) return c.json({ error: "that org slug is taken" }, 409);
    const org = await createOrg(c.env.DB, { slug, name, userId: session.user.id });
    return c.json({ org: { ...org, role: "owner" } });
  });

  app.get("/api/orgs", async (c) => {
    const session = await authed(c);
    return c.json({ orgs: await listOrgsForUser(c.env.DB, session.user.id) });
  });

  // — KBs —
  app.post("/api/orgs/:slug/kbs", async (c) => {
    const session = await authed(c);
    const org = await getOrgBySlug(c.env.DB, c.req.param("slug"));
    if (!org) return c.json({ error: "org not found" }, 404);
    const role = await getRole(c.env.DB, org.id, session.user.id);
    if (!roleAtLeast(role, "editor")) return c.json({ error: "editor role required" }, 403);
    const body = await readBody<{ slug?: string; title?: string; description?: string }>(c);
    const slug = (body.slug ?? "").trim().toLowerCase();
    const title = (body.title ?? "").trim();
    if (!SLUG.test(slug)) return c.json({ error: "slug must be lowercase letters, digits, dashes" }, 400);
    if (!title) return c.json({ error: "title is required" }, 400);
    const kb = await createKb(c.env.DB, { orgId: org.id, slug, title, description: body.description, userId: session.user.id });
    return c.json({ kb });
  });

  app.get("/api/orgs/:slug/kbs", async (c) => {
    const session = await authed(c);
    const org = await getOrgBySlug(c.env.DB, c.req.param("slug"));
    if (!org) return c.json({ error: "org not found" }, 404);
    if (!(await getRole(c.env.DB, org.id, session.user.id))) return c.json({ error: "not a member" }, 403);
    return c.json({ kbs: await listKbs(c.env.DB, org.id) });
  });

  app.get("/api/kbs/:kbId", async (c) => {
    const session = await authed(c);
    const { kb, role } = await kbAccess(c.env, c.req.param("kbId"), session.user.id);
    if (!kb) return c.json({ error: "not found" }, 404);
    if (!role) return c.json({ error: "not a member" }, 403);
    return c.json({ kb, role });
  });

  // — Pages —
  app.get("/api/kbs/:kbId/pages", async (c) => {
    const session = await authed(c);
    const { kb, role } = await kbAccess(c.env, c.req.param("kbId"), session.user.id);
    if (!kb || !role) return c.json({ error: "not found" }, 404);
    return c.json({ pages: await listPages(c.env.DB, kb.id) });
  });

  app.get("/api/kbs/:kbId/pages/:path{.+}", async (c) => {
    const session = await authed(c);
    const { kb, role } = await kbAccess(c.env, c.req.param("kbId"), session.user.id);
    if (!kb || !role) return c.json({ error: "not found" }, 404);
    const page = await getPage(c.env.DB, kb.id, c.req.param("path"));
    if (!page) return c.json({ error: "page not found" }, 404);
    return c.json({ page });
  });

  app.put("/api/kbs/:kbId/pages/:path{.+}", async (c) => {
    const session = await authed(c);
    const { kb, role } = await kbAccess(c.env, c.req.param("kbId"), session.user.id);
    if (!kb) return c.json({ error: "not found" }, 404);
    if (!roleAtLeast(role, "editor")) return c.json({ error: "editor role required" }, 403);
    const body = await readBody<{ title?: string; content?: string }>(c);
    if (typeof body.content !== "string") return c.json({ error: "content is required" }, 400);
    const page = await upsertPage(c.env.DB, { kbId: kb.id, path: c.req.param("path"), title: body.title, content: body.content, userId: session.user.id });
    return c.json({ page });
  });

  // — Proposals (the review gate) —
  app.post("/api/kbs/:kbId/proposals", async (c) => {
    const session = await authed(c);
    const { kb, role } = await kbAccess(c.env, c.req.param("kbId"), session.user.id);
    if (!kb) return c.json({ error: "not found" }, 404);
    if (!roleAtLeast(role, "editor")) return c.json({ error: "editor role required" }, 403);
    const body = await readBody<{ path?: string; title?: string; summary?: string; rationale?: string; content?: string; origin?: string }>(c);
    const path = (body.path ?? "").trim();
    if (!path) return c.json({ error: "path is required" }, 400);
    if (typeof body.content !== "string") return c.json({ error: "content is required" }, 400);
    const proposal = await createProposal(c.env.DB, {
      kbId: kb.id, path, title: body.title, summary: body.summary, rationale: body.rationale, content: body.content, origin: body.origin, userId: session.user.id,
    });
    return c.json({ proposal });
  });

  app.get("/api/kbs/:kbId/proposals", async (c) => {
    const session = await authed(c);
    const { kb, role } = await kbAccess(c.env, c.req.param("kbId"), session.user.id);
    if (!kb || !role) return c.json({ error: "not found" }, 404);
    return c.json({ proposals: await listProposals(c.env.DB, kb.id, c.req.query("status") || undefined) });
  });

  app.post("/api/proposals/:id/apply", async (c) => {
    const session = await authed(c);
    const p = await getProposal(c.env.DB, c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    const role = (await kbAccess(c.env, p.kb_id, session.user.id)).role;
    if (!roleAtLeast(role, "reviewer")) return c.json({ error: "reviewer role required to approve" }, 403);
    const applied = await applyProposal(c.env.DB, p.id, session.user.id);
    if (!applied) return c.json({ error: "proposal is not open" }, 409);
    return c.json({ proposal: applied });
  });

  app.post("/api/proposals/:id/reject", async (c) => {
    const session = await authed(c);
    const p = await getProposal(c.env.DB, c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    const role = (await kbAccess(c.env, p.kb_id, session.user.id)).role;
    if (!roleAtLeast(role, "reviewer")) return c.json({ error: "reviewer role required" }, 403);
    await decideProposal(c.env.DB, p.id, "rejected", session.user.id);
    return c.json({ ok: true });
  });
}
