# ProDocStore Platform

ProDocStore is the paid, private knowledge-base platform for customer and staff documentation:
**the private knowledge base your AI agents read and maintain** — MCP-native, human-reviewed.

> **Architecture: platform-native, NOT GitHub-backed.** ProDocStore's source of truth is
> **D1 + R2**, not GitHub. The earlier GitHub-backed framing in this README (private repos per
> KB in the ProDocStore org) is **superseded** — see [`STRATEGY.md`](./STRATEGY.md) for the full
> rationale (data ownership, buyer fit, family precedent with PWS). GitHub becomes an *optional*
> connect/import feature, not the foundation. The sections below are being updated as the
> platform-native build lands; where they still describe "one GitHub repo per KB", read D1.

## Build status (2026-07-13)

Platform-native foundation is live on `prodocstore-api`:

- **D1 store** (`prodocstore`): orgs, memberships (RBAC), knowledge_bases, pages, proposals
  (the review gate), ai_usage (quota metering). Schema in `workers/api/migrations/`.
- **API** (`workers/api/src/routes/kb.ts`): org / KB / page / proposal endpoints, role-gated
  (owner > admin > editor > reviewer > viewer).
- **Access-controlled publishing** (`workers/api/src/routes/publish.ts`): private KBs render as
  HTML at `/kb/:kbId` behind org membership.

Next: console wired to the D1 proposal/approve flow → org-scoped MCP → Stripe per-seat billing +
AI-quota metering. See `STRATEGY.md` build order.

## Product rule

- Knowledge lives in the platform (D1 + R2), scoped to an org, behind access control.
- Changes go through a **proposal → review → approve** flow (AI or human proposes, a reviewer
  approves; approval writes the page). Platform-native — no GitHub PR required.
- The console and MCP are AI-first: prompt, review the diff, approve.

## Scope

- Product site in `site/`.
- React/PWA console app in `apps/editor/`.
- ProDocStore API Worker in `workers/api/`.
- Remote MCP Worker in `workers/mcp/`.
- Browser extension in `extension/` for AI-first editing of published KB pages.
- Reusable Zensical templates, deploy workflows, generators, and lint rules in `templates/`.

## Repository Layout

```text
site/                 ProDocStore product site
apps/editor/          React console for customer KB publishing and profile/BYOK
workers/api/          API, GitHub/Google OAuth, user KV, and encrypted BYOK vault
workers/mcp/          Cloudflare Worker remote MCP server
docs/                 Product and engine docs
extension/            MV3 Chrome extension for AI-first docs editing
templates/            Reusable Zensical templates, workflows, lint, and generators
brand/                Brand assets
.github/workflows/    Deploy, release, lint, and test workflows
```

## Knowledge bases (platform-native)

Each KB is a row in D1 scoped to an org, with its pages stored in D1 (markdown inline for the
MVP; large assets move to R2). There is **no GitHub repo per KB** — access control, versioning,
and the review flow are owned by the platform, which is exactly what ProDocStore sells. KBs render
behind org-membership auth at `/kb/:kbId`, and later at `<org>.prodocstore.online` / custom domains.

## Console

Production console:

- Source: `apps/editor/`
- URL: <https://console.prodocstore.online/>
- Cloudflare Pages project: `prodocstore-editor`

The console supports Google/GitHub sign-in, multiple KB drafts per account, profile-level OpenAI BYOK, company-scoped KB settings, one GitHub repo per KB, Zensical-only Markdown source, Cloudflare Pages publishing, Cloudflare Access policies for private KBs, and optional custom domains per KB.

## API

Production API:

- Source: `workers/api/`
- URL: <https://api.prodocstore.online/>
- Health check: <https://api.prodocstore.online/api/health>
- Worker: `prodocstore-api`

Required API Worker secrets:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_TOKEN`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `PDS_KEY_ENCRYPTION_KEY`

OpenAI is BYOK only. Users save their own OpenAI key once on the console Profile page; the API stores it encrypted in the per-user vault and resolves it server-side for AI generation.

## MCP

Production MCP:

- Endpoint: <https://mcp.prodocstore.online/mcp>
- Health check: <https://mcp.prodocstore.online/health>
- Discovery: <https://prodocstore.online/.well-known/mcp.json>
- Local connector: `.mcp.json`
- Worker: `prodocstore-mcp`

The MCP server exposes account visibility, workspace drafts, Zensical validation, registry reads, deploy checks, and prompt-to-publish planning. Authenticated workspace write tools use the same ProDocStore user workspace and KV binding as the console.

Production MCP OAuth is configured through the ProDocStore-specific GitHub OAuth app. The deploy workflow checks that OAuth and storage are configured before it treats `prodocstore-mcp` as healthy.

## Cloudflare And Secrets

Secrets are documented in `~/dev/secrets/inventory.yaml` and stored in `~/dev/secrets/secrets.enc.yaml` through SOPS. Do not use Doppler.

Required ProDocStore org Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

GitHub free organizations expose org Actions secrets only to public repos. If ProDocStore creates private customer repos without a paid GitHub org plan, required deploy secrets must be set at the repo level or publishing must use a separate deploy path.

The Cloudflare token needs `Workers Scripts:Edit`, `Workers Routes:Edit`, `Workers KV Storage:Edit`, `Cloudflare Pages:Edit`, `DNS:Edit`, and account read/settings access for the `prodocstore.online` zone.

Private/customer KB publishing also needs Cloudflare Zero Trust Access application and policy edit permissions. ProDocStore defaults private KBs to closed access and then opens them through explicit policy rules such as allowed email addresses or email domains.

## Local Commands

```bash
pnpm install
pnpm test

pnpm --dir apps/editor dev
npm --prefix workers/api run dev
npm --prefix workers/mcp run dev

cd extension
npm install
npm run build
npm test
```

## Boundary With FreeDocStore

FreeDocStore is the free/public publishing product. ProDocStore is the private/customer product. They can share the Zensical publishing contract and implementation patterns, but they must not share KV namespaces, OAuth apps, Chrome Web Store listings, Cloudflare routes, customer data, or product copy.
