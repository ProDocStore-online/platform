# ProDocStore Editor

Self-serve editor and publisher for ProDocStore knowledge bases.

Canonical product target: ProDocStore-owned hosting.

Canonical source: `apps/editor/` in <https://github.com/ProDocStore-online/platform>.

The app is Zensical-only:

- one GitHub repo per KB
- Markdown source in `docs/`
- `zensical.toml` at repo root
- Cloudflare Pages project per KB
- optional custom domain per KB
- private KBs closed by default with Cloudflare Access policies
- OpenAI BYOK stored once in the Profile page, not per KB

## Workflows

- Publish a new KB from a prompt: generate a Zensical repo plan, draft Markdown files, and push them to GitHub through platform-held connections.
- Edit an existing KB page: load Markdown from GitHub, ask AI for a complete replacement, review the diff, then copy or open GitHub for manual edits.
- Manage company KB settings: set repo visibility, custom domains, and private access rules such as allowed emails or allowed email domains.

## Development

```bash
pnpm install
pnpm dev
pnpm build
```

## Deploy

Push to `main`; `.github/workflows/deploy-editor.yml` builds `apps/editor/web` and deploys from the ProDocStore platform repo when the ProDocStore Cloudflare Pages credentials are configured.
