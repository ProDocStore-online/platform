# ProDocStore Console Connections

The console uses the independent ProDocStore API worker, not PAS and not FreeDocStore.

Canonical GitHub organization:

```text
https://github.com/ProDocStore-online
```

The platform repo, generated KB repos, reusable deploy workflows, and shared GitHub Actions configuration are owned by the ProDocStore-online org.

Default API base:

```text
https://api.prodocstore.online
```

Override locally with:

```bash
VITE_PDS_API_BASE=http://127.0.0.1:8787 pnpm dev
```

## API Worker Secrets

Configure these in `workers/api` through SOPS-sourced values:

```bash
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put GITHUB_TOKEN
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put PDS_KEY_ENCRYPTION_KEY
wrangler secret put CLOUDFLARE_API_TOKEN
wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

`GITHUB_TOKEN` is the server-side platform token used for repository creation and content writes. The browser never receives it.

`PDS_KEY_ENCRYPTION_KEY` is the API worker KEK for the per-user key vault. Use a 32-byte base64 or hex value.

OpenAI is BYOK only. Users save their own OpenAI key once in the ProDocStore console Profile page. The API proxy resolves that encrypted key server-side for AI generation. Do not configure or use a platform-wide `OPENAI_API_KEY`.

## OAuth

GitHub console callback:

```text
https://api.prodocstore.online/auth/github/callback
```

Google console callback:

```text
https://api.prodocstore.online/auth/google/callback
```

MCP GitHub callback:

```text
https://mcp.prodocstore.online/callback
```

## Cloudflare Deploy

Generated KB repositories use `.github/workflows/deploy.yml` and expect Cloudflare deploy credentials from ProDocStore Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

GitHub free org-level Actions secrets apply to public repositories only. For private KB repositories, the ProDocStore API installs these as repo-level Actions secrets before the first workflow commit. The browser never receives Cloudflare credentials.

Private KB workflows also create and verify a Cloudflare Access application for the Pages URL before treating the deploy as successful. The Cloudflare token must include Pages edit, DNS edit, Workers/KV edit for the platform, and Zero Trust Access application/policy edit permissions.
