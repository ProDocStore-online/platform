# FreeDocStore Editor Connections

The editor uses the independent FreeDocStore API worker, not PAS.

Canonical GitHub organization:

```text
https://github.com/FreeDocStore
```

The platform repo, generated KB repos, reusable deploy workflows, and shared GitHub Actions secrets are owned by the FreeDocStore org.

Default API base:

```text
https://freedocstore-api.serge-the-dev.workers.dev
```

Override locally with:

```bash
VITE_FDS_API_BASE=http://127.0.0.1:8787 pnpm dev
```

## API Worker Secrets

Configure these in `workers/api`:

```bash
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put GITHUB_TOKEN
wrangler secret put OPENAI_API_KEY
```

`GITHUB_TOKEN` is the server-side platform token used for repository creation and content writes. The browser never receives it.

`OPENAI_API_KEY` is injected server-side when the editor calls the FreeDocStore API proxy for OpenAI generation.

## GitHub OAuth

Create a GitHub OAuth app with callback:

```text
https://freedocstore-api.serge-the-dev.workers.dev/auth/github/callback
```

When `api.freedocstore.online` is attached, add the production callback too:

```text
https://api.freedocstore.online/auth/github/callback
```

## Cloudflare Deploy

Generated KB repositories use `.github/workflows/deploy.yml` and expect Cloudflare deploy credentials from FreeDocStore organization-level GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The editor does not ask users for these keys per KB. Do not set empty repo-level secrets on `FreeDocStore/platform`, because they can shadow real org-level secrets.
