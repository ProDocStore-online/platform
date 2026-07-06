# FreeDocStore Platform

FreeDocStore is the public knowledge-base publishing layer in the Open Frontier store ecosystem.

Canonical GitHub organization: <https://github.com/FreeDocStore>. The platform repo, published KB repos, reusable workflows, and shared Actions secrets belong to that org, the same way the other stores keep their infrastructure under their own store orgs.

It turns GitHub-backed Zensical documentation repositories into free public knowledge bases with AI-first editing, reviewable proposals, Cloudflare publishing, search, and agent-readable metadata.

## Product Rule

Editing is AI-first.

Users describe what should change. The AI drafts the change. The user reviews the diff. Manual text editing happens in GitHub, not in a CMS textarea.

## Current Scope

- Product site in `site/`.
- Legacy AI-first web workbench at `site/editor.html`.
- FreeDocStore-owned React console app in `apps/editor/`.
- Independent FreeDocStore API Worker in `workers/api/`.
- Remote MCP Worker in `workers/mcp/`.
- Browser extension in `extension/` for editing published docs pages from the side panel.
- Reusable docs templates, deploy workflows, generators, and lint rules in `templates/`.
- GitHub-backed proposal, PR, and extension workflows inherited from the seed engine and kept under FreeDocStore ownership.
- KB publishing supports Zensical-format Markdown repos only for now.

## Local Preview

The public site is static:

```bash
open site/index.html
open site/editor.html
```

Build the extension:

```bash
cd extension
npm install
npm run build
npm test
```

Load `extension/dist/` as an unpacked extension in Chrome.

## Free Layer

FreeDocStore is for public knowledge bases:

- Public docs hosting.
- One GitHub repo per KB.
- Markdown source in `docs/`.
- Zensical config in `zensical.toml`.
- Cloudflare Pages publishing for each KB.
- Optional custom domains per KB.
- AI proposal workflow.
- Manual edits via GitHub.
- Zensical-generated search, sitemap, and metadata.
- Public MCP/read endpoints later.

Free public docs should be cheap to host and easy to mirror, but FreeDocStore does not host copied HTML folders inside the platform repo.

## Pro Pair

ProDocStore is the future private paid layer:

- Private staff/customer knowledge bases.
- Authenticated access.
- Team roles: owner, editor, viewer.
- Private search.
- Audit logs.
- Scoped MCP tokens.
- Custom domains.
- SSO later.

Do not build Pro-only private access into FreeDocStore first. Keep the Free platform public-first, but define interfaces so ProDocStore can reuse the AI editing and publishing engine.

## Repository Layout

```text
site/                 Public FreeDocStore marketing site and legacy AI editor
apps/editor/          FreeDocStore-owned React console for prompt-to-KB publishing
workers/api/          FreeDocStore API, GitHub/Google OAuth, user KV, and platform proxy
workers/mcp/          Cloudflare Worker remote MCP server
docs/                 Product and engine docs
extension/            MV3 Chrome extension for AI-first docs editing
templates/            Reusable docs templates, add-ons, lint, and generators
brand/                Brand assets inherited from the seed repo
.github/workflows/    Deploy, release, lint, and test workflows
```

## Published Knowledge Bases

Each knowledge base is its own GitHub repository. The platform registry records the repo, Zensical source layout, Cloudflare Pages project, production URL, and any custom domains.

Local checkouts follow the same store convention as FAS and FGS: each published KB repo is checked out beside `platform`, not inside it.

```text
~/dev/stores/fdocs/
  platform/           FreeDocStore platform monorepo
  true-non-profit/    Published KB repo: FreeDocStore/true-non-profit
  <kb-slug>/          Future published KB repos
```

The first KB is `FreeDocStore/true-non-profit`:

- Source: <https://github.com/FreeDocStore/true-non-profit>
- Production: <https://true-non-profit.pages.dev/>
- Engine: Zensical
- Source directory: `docs/`
- Config: `zensical.toml`

The platform repo does not contain generated KB pages and does not publish `/books/<slug>/` routes.

## MCP

FreeDocStore has a remote MCP server for agents:

- Current endpoint: <https://mcp.freedocstore.online/mcp>
- Discovery: <https://freedocstore.online/.well-known/mcp.json>
- Local connector: `.mcp.json`
- Source: `workers/mcp/`

Current MCP tools are public/read and planning tools: list KBs, inspect registered KB metadata, validate Zensical repos, read source files, check deploy status, and create a publish plan from a topic prompt.

Authenticated write tools come next: create KB repo, update Markdown files, register custom domains, and publish from prompt.

## Console

The production console is a FreeDocStore app:

- Source: `apps/editor/`
- Production: <https://console.freedocstore.online/>
- Deploy target: Cloudflare Pages project `freedocstore-editor`

The console supports Google and GitHub sign-in, multiple KB drafts per account, one GitHub repo per KB, Zensical-only Markdown source, Cloudflare Pages publishing, and optional custom domains per KB.

## API

The production editor talks to the independent FreeDocStore API Worker:

- Source: `workers/api/`
- Production: <https://api.freedocstore.online/>
- Health check: <https://api.freedocstore.online/api/health>
- Deploy target: Cloudflare Worker `freedocstore-api`

The API owns GitHub sign-in, per-user workspace KV, and server-side proxy injection for platform secrets. The browser never stores GitHub, OpenAI, or Cloudflare deploy tokens per KB.

Cloudflare deploy credentials must be configured as FreeDocStore organization-level GitHub Actions secrets so `FreeDocStore/platform` and every `FreeDocStore/<kb-slug>` repo can deploy through the shared workflows without per-repo key entry.

Required worker secrets:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_TOKEN`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `OPENAI_API_KEY`

Required FreeDocStore org Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The Cloudflare token must include `Workers Scripts:Edit`, `Workers Routes:Edit`, `Workers KV Storage:Edit`, `Cloudflare Pages:Edit`, `DNS:Edit`, and `Account Settings:Read` for the `freedocstore.online` zone. API and MCP deploys update Worker routes for `api.freedocstore.online/*` and `mcp.freedocstore.online/*`.

## AI Editor Flow

1. Connect a GitHub file.
2. Describe the desired content change.
3. AI returns a complete replacement proposal.
4. The UI shows a read-only diff.
5. User copies/downloads the proposal or opens GitHub's file editor.

The browser extension has a stronger workflow: it can create proposal previews and apply through GitHub commits/PRs after user approval.

## Near-Term Plan

See `docs/FREEDOCSTORE-PLAN.md`.
