import { Hono, type Context } from "hono";
import { marked } from "marked";
import { type Env, type Variables } from "../types";
import { getKb, getRole, getPage, listPages } from "../lib/db";

type App = Hono<{ Bindings: Env; Variables: Variables }>;
type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

marked.setOptions({ gfm: true });

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shell(title: string, kbTitle: string, nav: string, bodyHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(kbTitle)}</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;font-family:Inter,system-ui,-apple-system,sans-serif;color:#111;background:#fff;line-height:1.6}
  @media (prefers-color-scheme:dark){body{color:#e6edf6;background:#0d1420}a{color:#89cbe5}}
  .wrap{display:grid;grid-template-columns:240px 1fr;min-height:100dvh}
  aside{border-right:1px solid #8883;padding:20px 16px}
  aside h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;opacity:.6;margin:0 0 10px}
  aside a{display:block;padding:5px 8px;border-radius:7px;text-decoration:none;color:inherit;font-size:14px}
  aside a.active,aside a:hover{background:#7c3aed18}
  main{padding:28px 40px;max-width:820px}
  a{color:#7c3aed}
  pre{background:#101828;color:#f8fafc;padding:14px;border-radius:8px;overflow:auto}
  code{background:#8882;padding:.1em .35em;border-radius:4px}
  pre code{background:none;padding:0}
  table{border-collapse:collapse}th,td{border:1px solid #8884;padding:5px 9px}
</style></head><body><div class="wrap">
<aside><h2>${escapeHtml(kbTitle)}</h2>${nav}</aside>
<main>${bodyHtml}</main></div></body></html>`;
}

/** Access-controlled rendering of a private KB. Members only. */
export function registerPublishRoutes(app: App): void {
  app.get("/kb/:kbId", async (c) => renderKb(c, "docs/index.md"));
  app.get("/kb/:kbId/view/:path{.+}", async (c) => renderKb(c, c.req.param("path")));

  async function renderKb(c: Ctx, path: string): Promise<Response> {
    const session = c.get("session");
    if (!session) return c.redirect(`${c.env.EDITOR_BASE_URL}/?next=${encodeURIComponent(c.req.url)}`, 302);
    const kb = await getKb(c.env.DB, c.req.param("kbId") ?? "");
    if (!kb) return c.html("<h1>Not found</h1>", 404);
    const role = await getRole(c.env.DB, kb.org_id, session.user.id);
    if (!role) return c.html("<h1>You don't have access to this knowledge base.</h1>", 403);

    const pages = await listPages(c.env.DB, kb.id);
    const nav = pages.length
      ? pages.map((p) => `<a class="${p.path === path ? "active" : ""}" href="/kb/${kb.id}/view/${p.path}">${escapeHtml(p.title || p.path)}</a>`).join("")
      : `<p style="opacity:.6;font-size:13px">No pages yet.</p>`;

    const page = await getPage(c.env.DB, kb.id, path);
    const body = page
      ? (marked.parse(page.content, { async: false }) as string)
      : `<h1>${escapeHtml(kb.title)}</h1><p style="opacity:.7">This page doesn't exist yet. Create it in the console.</p>`;
    return c.html(shell(page?.title || kb.title, kb.title, nav, body));
  }
}
