# FreeDocStore Console Connections

The console uses the independent FreeDocStore API worker, not PAS.

Canonical GitHub organization:

```text
https://github.com/FreeDocStore
```

The platform repo, generated KB repos, reusable deploy workflows, and shared GitHub Actions secrets are owned by the FreeDocStore org.

Default API base:

```text
https://api.freedocstore.online
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
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put FDS_KEY_ENCRYPTION_KEY
```

`GITHUB_TOKEN` is the server-side platform token used for repository creation and content writes. The browser never receives it.

`FDS_KEY_ENCRYPTION_KEY` is the API worker KEK for the per-user key vault. Use a 32-byte base64 or hex value.

OpenAI is BYOK only. Users save their own OpenAI key once in the FreeDocStore console, and the API proxy resolves that encrypted key server-side for AI generation. Do not configure or use a platform-wide `OPENAI_API_KEY`.

## GitHub OAuth

Create a GitHub OAuth app with callback:

```text
https://api.freedocstore.online/auth/github/callback
```

## Google OAuth

Create a Google OAuth web client with callback:

```text
https://api.freedocstore.online/auth/google/callback
```

## Cloudflare Deploy

Generated KB repositories use `.github/workflows/deploy.yml` and expect Cloudflare deploy credentials from FreeDocStore organization-level GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The console does not ask users for these keys per KB. Do not set empty repo-level secrets on `FreeDocStore/platform`, because they can shadow real org-level secrets.
