# ProDocStore Platform

ProDocStore is the paid, private knowledge-base publishing platform for customer and staff documentation. It uses the same Zensical-only publishing contract as FreeDocStore, but the product boundary is different: private repos, secure access, customer workspaces, custom domains, and account-level BYOK.

Canonical GitHub organization: <https://github.com/ProDocStore-online>. The platform repo, generated customer KB repos, reusable workflows, and shared Actions configuration belong to that org.

## Product Rule

Knowledge bases are GitHub-backed Zensical books.

- One GitHub repo per KB.
- Markdown source lives in `docs/`.
- Zensical config lives in `zensical.toml`.
- Generated static output is build output, not source.
- Manual editing happens in GitHub.
- The console and extension are AI-first: prompt, review generated Markdown/diffs, then publish.

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

## Published Knowledge Bases

Each customer knowledge base is its own GitHub repository. Local checkouts follow the other store convention: published KB repos sit beside `platform`, not inside it.

```text
~/dev/stores/pdocs/
  platform/           ProDocStore platform monorepo
  <kb-slug>/          Published customer KB repo
```

The platform registry records repo, Zensical source layout, Cloudflare Pages project, production URL, custom domains, and visibility metadata. ProDocStore starts with an empty registry; customer KBs are added as they are created.

## Console

Production console:

- Source: `apps/editor/`
- URL: <https://console.prodocstore.online/>
- Cloudflare Pages project: `prodocstore-editor`

The console supports Google/GitHub sign-in, multiple KB drafts per account, profile-level OpenAI BYOK, one GitHub repo per KB, Zensical-only Markdown source, Cloudflare Pages publishing, and optional custom domains per KB.

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
- Discovery: <https://prodocstore.online/.well-known/mcp.json>
- Local connector: `.mcp.json`
- Worker: `prodocstore-mcp`

The MCP server exposes account visibility, workspace drafts, Zensical validation, registry reads, deploy checks, and prompt-to-publish planning. Authenticated write tools use the same ProDocStore user workspace and KV binding as the console.

## Cloudflare And Secrets

Secrets are documented in `~/dev/secrets/inventory.yaml` and stored in `~/dev/secrets/secrets.enc.yaml` through SOPS. Do not use Doppler.

Required ProDocStore org Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

GitHub free organizations expose org Actions secrets only to public repos. If ProDocStore creates private customer repos without a paid GitHub org plan, required deploy secrets must be set at the repo level or publishing must use a separate deploy path.

The Cloudflare token needs `Workers Scripts:Edit`, `Workers Routes:Edit`, `Workers KV Storage:Edit`, `Cloudflare Pages:Edit`, `DNS:Edit`, and account read/settings access for the `prodocstore.online` zone.

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
