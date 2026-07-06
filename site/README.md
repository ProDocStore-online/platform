# ProDocStore - marketing site

Public product site for ProDocStore. Lives alongside `docs/`, `extension/`,
`brand/`, `templates/` in this repo. Separate from `docs/` (which is the
product's own documentation). Knowledge bases are separate Zensical GitHub
repositories and are not embedded in this site.

## Stack

Handwritten HTML + CSS. No framework, no build step, no dependencies.

## Preview

```
open site/index.html
```

That is the dev workflow.

## Structure

```
site/
  index.html           landing page (single-page)
  styles.css           all styles
  assets/
    logo-dark.svg      ProDocStore wordmark copy for existing deploy scripts
    logo.svg           original (uses currentColor, for reference)
    favicon.svg        favicon (ProDocStore document mark)
    monogram.svg       standalone brand mark
```

## Deploy

`/.github/workflows/deploy-store.yml` publishes only `site/` to Cloudflare
Pages on every push to `main` that touches public content. KBs deploy from
their own repositories with Zensical.
