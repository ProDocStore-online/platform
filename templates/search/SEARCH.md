# Adding Search to a ProDocStore Doc Site

This is the canonical recipe for adding client-side search to any
static doc site under `ProDocStore`. It uses
[Pagefind](https://pagefind.app) - a wasm-based static-site search
library - built in CI by the shared deploy workflow.

Live examples: any ProDocStore-deployed site with search enabled.

## What you get

- A search box at the right of the topbar with `Cmd+K` / `Ctrl+K` hotkey
- ProDocStore theme matching the rest of the UI (inherited from `styles.css`)
- Sub-results that deep-link to in-page anchors
- No external service, no API keys, no runtime backend
- Index built fresh in CI on every deploy - never drifts from content

## Recipe

Run from the repo root.

### 1. Copy build files into your site's deploy dir

Assuming `docs/` is your deploy directory:

```sh
mkdir -p docs/scripts
curl -fsSL https://raw.githubusercontent.com/ProDocStore-online/platform/main/templates/search/package.json     -o docs/package.json
curl -fsSL https://raw.githubusercontent.com/ProDocStore-online/platform/main/templates/search/scripts/add-heading-ids.mjs -o docs/scripts/add-heading-ids.mjs
curl -fsSL https://raw.githubusercontent.com/ProDocStore-online/platform/main/templates/search/.gitignore       -o docs/.gitignore
```

Then update the `name` field in `docs/package.json` and generate the lockfile:

```sh
cd docs && npm install --package-lock-only
```

### 2. Add the snippet to every HTML page

See `templates/search/snippet.html` for the three blocks to paste:

- A `<link>` to `pagefind-ui.css` in `<head>`
- A `<div class="site-search" id="search"></div>` inside `<header class="topbar">`,
  after the `.topbar-links` nav
- An init `<script>` and the `pagefind-ui.js` `<script>` just before `</body>`

The ProDocStore theme is already in the shared `styles.css` (under
`.site-search { ... }`) - no extra CSS needed.

### 3. Wire the build into CI

In your repo's `.github/workflows/deploy.yml`, pass `pre-deploy-steps`
to the reusable workflow:

```yaml
jobs:
  deploy:
    uses: ProDocStore-online/platform/.github/workflows/deploy-pages.yml@main
    with:
      project-name: your-pages-project
      fetch-brand-assets: true
      pre-deploy-steps: '["cd docs && npm ci && npm run build"]'
    secrets: inherit
```

### 4. Relax the CSP for Pagefind

In `docs/_headers`, the Content-Security-Policy needs `wasm-unsafe-eval`
and `worker-src blob:`:

```
Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:; img-src 'self' data:
```

### 5. Push

That's it. The reusable workflow will:

1. Fetch the shared `styles.css` (which contains the search theme)
2. Run `cd docs && npm ci && npm run build`
   - `prebuild` slugifies all `<h1>` to `<h6>` and adds `id` attributes
   - `build` runs `pagefind --site .` and generates `docs/pagefind/`
3. Deploy `docs/` to Cloudflare Pages

## How it works

- **`add-heading-ids.mjs`** is the secret to anchor deep-links. Pagefind
  emits sub-results that link to heading IDs, but it won't invent IDs that
  aren't in the source HTML. The script slugifies every heading on every
  build so the index and the anchors always agree.
- **`pagefind/` is gitignored.** The index is regenerated on every deploy
  from the current HTML, so it can never drift from content.
- **`npm ci`** against the committed `package-lock.json` keeps CI builds
  reproducible.

## Local development

```sh
cd docs
npm ci
npm run build      # adds heading ids + builds the index into docs/pagefind/
npm run serve      # optional: serves the site with the search index
```

## Optional add-ons

The same `templates/search/scripts/` directory ships three more
build-time helpers - drop them next to `add-heading-ids.mjs` and
add them to the `pre-deploy-steps` list:

```yaml
pre-deploy-steps: '[
  "node scripts/generate-changelog.mjs",
  "node scripts/generate-sitemap.mjs",
  "node scripts/inject-page-meta.mjs",
  "cd docs && npm ci && npm run build"
]'
```

- **`generate-changelog.mjs`** - walks `git log` and emits
  `docs/changelog.html` with one card per commit, files grouped by
  category. Add a `Log` link to your topbar.
- **`generate-sitemap.mjs`** - emits `docs/sitemap.html` listing every
  page grouped by section, with title + first paragraph as the
  summary.
- **`inject-page-meta.mjs`** - injects an idempotent footer block
  into every `docs/*.html` containing a "Updated <date>" stamp
  (from `git log -1`) and an "Edit on GitHub →" link. Auto-detects
  the GitHub repo from the `origin` remote.
- **`templates/search/404.html`** - drop into `docs/404.html` and
  Cloudflare Pages will serve it on missing pages.

The `.page-meta` styles for the footer block live in the shared
`styles.css`, so they're themed automatically.

## Customizing

- **Theme**: edit `.site-search` in the ProDocStore `docs/styles.css`. Every
  site that fetches the shared stylesheet picks up the change automatically.
- **Hotkey**: edit the inline init script in `snippet.html`.
- **Result count, fuzziness, etc.**: see the
  [Pagefind UI options](https://pagefind.app/docs/ui/) and pass them in
  the `new PagefindUI({...})` call.
