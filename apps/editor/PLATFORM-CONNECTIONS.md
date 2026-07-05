# FreeDocStore Editor Platform Connections

FreeDocStore Editor must not ask for provider keys per knowledge base. Provider credentials are platform-level connections.

## PAS Proxy Connections

Configure these for the `freedocstore-editor` PAS app:

```sh
pas secret set GITHUB_TOKEN <token> --app freedocstore-editor
pas proxy allow 'https://api.github.com/' --inject bearer --secret GITHUB_TOKEN --app freedocstore-editor

pas secret set OPENAI_API_KEY <key> --app freedocstore-editor
pas proxy allow 'https://api.openai.com/' --inject bearer --secret OPENAI_API_KEY --app freedocstore-editor
```

The editor calls GitHub and OpenAI through `app.proxy.fetch()`, so these secrets are injected server-side and never stored in KB drafts or browser session fields.

## Deploy Connection

Generated KB repositories use `.github/workflows/deploy.yml` and expect Cloudflare deploy credentials from platform/org Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Those secrets must be available to new FreeDocStore KB repositories without asking the user to enter them for each KB.
