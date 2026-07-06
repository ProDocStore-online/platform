# ProDocStore Plan

## Goal

Create the paid/private knowledge-base publishing platform for customer and staff documentation.

ProDocStore publishes Zensical Markdown knowledge bases from GitHub repos. It should support closed customer workspaces, private repos, secure staff access, custom domains, BYOK, and MCP-visible account workflows.

## MVP

### Customer KB Registry

Track knowledge bases with:

- id
- title
- owner GitHub repo
- source path
- visibility
- docs engine
- production URL
- custom domains
- last build status
- last published commit

### Supported Sources

Start with one source shape only:

- Zensical-format Markdown repositories
- one GitHub repository per KB
- `docs/` as the source directory
- `zensical.toml` as the build config
- Cloudflare Pages as the publishing target

Do not support copied static HTML folders as source.

### AI-First Editing

Console:

- sign in with Google/GitHub
- save OpenAI BYOK in the Profile page
- create multiple KB drafts
- generate Zensical source files from a prompt
- show source/preview/diff side by side
- publish to a GitHub repo
- record custom domain intent

Extension:

- detect a published page's backing repo
- use page context
- ask/edit threads
- preview proposals
- apply through commit or PR

### Publishing

First pass stays Zensical-only:

- Markdown source in each KB repo
- Zensical build in GitHub Actions
- Cloudflare Pages deploy per KB
- custom domains attached per KB project
- private repo deploy secrets set repo-level unless the GitHub org moves to a paid plan

### Access And Security

ProDocStore needs:

- account workspace state in platform KV
- encrypted per-user BYOK
- repo visibility controls
- private/customer access model
- audit trail for AI proposals and publishes
- scoped MCP tokens
- SSO later

## Boundary

FreeDocStore is the free/public product. ProDocStore is paid/private. They can share Zensical templates and workflow patterns, but they must not share:

- Cloudflare KV namespaces
- OAuth apps
- Chrome Web Store listings
- customer data
- product copy
- production routes

## First Implementation Milestones

1. Keep the ProDocStore platform productized under `ProDocStore-online`. Done.
2. Use ProDocStore-specific Cloudflare KV namespaces and routes. Done.
3. Save ProDocStore secrets in the SOPS repo from day one. Done.
4. Deploy console, API, MCP, and product site to `prodocstore.online`. Done.
5. Create OAuth apps for console and MCP. Done.
6. Add GitHub PAT, OAuth, BYOK encryption, and Cloudflare token secrets from SOPS to their consumers. Done for the deployed platform workers.
7. Publish the first private/customer KB repo through the console or MCP. Next.

## Current Production Status

As of 2026-07-07:

- Product site: <https://prodocstore.online/>
- Console: <https://console.prodocstore.online/>
- API health: <https://api.prodocstore.online/api/health>
- MCP endpoint: <https://mcp.prodocstore.online/mcp>
- MCP health: <https://mcp.prodocstore.online/health>

Console and MCP are independent from FreeDocStore and use ProDocStore-specific OAuth apps, KV namespaces, Cloudflare routes, and SOPS-managed secrets.

The console supports profile-level BYOK, multiple KB drafts, company KB controls, custom domain intent, repo visibility, and private Access rules. Cloudflare Access is the default security model for private/customer KBs: private KBs should be closed first and opened only by explicit rules such as allowed email addresses or allowed email domains.

The MCP server supports GitHub OAuth sign-in, account visibility, workspace draft reads, workspace draft creation, Zensical validation, registry reads, deploy checks, and prompt-to-publish planning. MCP writes currently stop at console-visible workspace drafts; direct GitHub repo creation, file commits, custom-domain registration, and publish execution remain the next step.

## Next Session

1. Smoke test MCP sign-in from Claude and Codex against `https://mcp.prodocstore.online/mcp`.
2. Create a sample workspace draft only through MCP and confirm it appears in the console.
3. Publish the first private KB repo from the console using profile BYOK and platform-held GitHub/Cloudflare connections.
4. Verify Cloudflare Access closes the Pages URL by default and opens it only through configured email/domain policies.
5. Add direct MCP publish tools after the console path is proven end to end.
