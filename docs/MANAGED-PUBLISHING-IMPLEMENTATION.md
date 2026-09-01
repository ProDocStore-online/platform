# ProDocStore Managed Publishing Implementation

## Decision

ProDocStore should keep GitHub as the canonical source for published knowledge-base content, but it should not require each customer repo to own the full deployment implementation.

The platform should support two publishing modes:

1. PDocs-managed publishing, the default product path.
   - Customer or platform-created GitHub repo stores source Markdown and `zensical.toml`.
   - ProDocStore receives push events through a GitHub App installation.
   - ProDocStore mints short-lived GitHub installation tokens to read source.
   - ProDocStore builds, protects, deploys, and records status using platform-owned infrastructure.
   - Customer repos do not need Cloudflare secrets.

2. Client-hosted publishing, the advanced/enterprise path.
   - Customer repo keeps a small GitHub Actions workflow.
   - Workflow calls a reusable ProDocStore publisher workflow.
   - Customer Cloudflare account owns Pages, Access, custom domains, and deploy credentials.
   - This remains useful for customers that require their own Cloudflare boundary.

The current generated workflow is too large and embeds platform deployment behavior into every KB repo. The first implementation step is to centralize that logic behind a reusable Zensical publisher workflow and generate only a thin caller workflow.

## Why Change

The current approach works for simple repos, but it has product and operational limits:

- Every generated KB repo receives a bespoke deployment workflow.
- Improvements to Access safety, project creation, and deployment verification do not automatically reach existing KBs.
- Private KB safety depends on customer repo secrets and generated YAML.
- Cloudflare Pages project creation can fail because the account has finite project capacity.
- Access policy sync currently owns too much of the app state and can delete manual policies.
- The platform UI is trying to be a publisher, registry, secret installer, and deploy orchestrator at the same time.

GlassDocs is closer to the right shape because KB repos use small workflows that call a centralized publisher. ProDocStore should take that idea, then go further for the default path by moving deploy execution into platform-managed jobs.

## Target Architecture

### Source Of Truth

Published KB source lives in GitHub:

- `docs/**/*.md`
- `zensical.toml`
- repo metadata and commit history
- optional generated assets that should be reviewed as source

The ProDocStore database stores platform state:

- KB registry
- owning user/org
- GitHub owner/repo/default branch
- current publishing mode
- Access intent and allow rules
- custom domain settings
- latest build/deploy status
- edit drafts and proposed changes
- audit trail

The database should not become the canonical published document store unless we intentionally build a GitHub-less product mode later.

### Publishing Modes

#### PDocs-Managed

Flow:

1. User connects GitHub through a ProDocStore GitHub App.
2. User creates or selects a KB repo.
3. ProDocStore commits source files to GitHub.
4. GitHub push webhook creates a publish job.
5. Worker/queue runner checks out the commit with an installation token.
6. Runner builds Zensical.
7. Runner deploys built assets to platform hosting.
8. Edge auth gates private KBs before content can be served.
9. Platform records status and exposes logs in the console.

Hosting options:

- Preferred: Worker router plus R2/static asset storage, keyed by `org/kb/version`.
- Acceptable interim: platform-owned Cloudflare Pages project used by a managed deployment runner.

The Worker/R2 option avoids one Pages project per KB and removes the 100 Pages project limit as a product constraint.

#### Client-Hosted

Flow:

1. Generated repo contains `.github/workflows/deploy.yml`.
2. Workflow calls `ProDocStore-online/platform/.github/workflows/deploy-zensical-kb.yml@publisher-v3`.
3. Customer stores Cloudflare secrets in their repo or org.
4. Reusable publisher builds Zensical, manages Access, deploys to Pages, and verifies the result.

This mode should remain explicit in the UI so users know they are using their own Cloudflare boundary and GitHub Actions minutes.

## Implementation Phases

### Phase 1: Centralize Current GitHub Actions Publishing

Goal: stop generating long bespoke workflows.

Tasks:

- Add `.github/workflows/deploy-zensical-kb.yml` as the reusable KB publisher.
- Move the current Zensical build, source metadata injection, Pages project creation, Access app creation, Access policy sync, deploy, verification, and custom domain attachment into that workflow.
- Change `apps/editor/web/src/lib/publishing.ts` so generated KB repos receive a thin caller workflow.
- Keep the existing repo secrets contract for client-hosted mode:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
- Pass Access inputs through workflow `with` values.
- Keep `ACCESS_RULES_JSON` support for now because the current UI exposes it.

Acceptance:

- A generated private KB workflow is under 60 lines.
- Existing generated repos can adopt the thin workflow by replacing only `.github/workflows/deploy.yml`.
- Private mode still fails closed when there are no allow rules.
- Pages project creation failures surface as hard workflow failures.

### Phase 2: Make Access Policy Sync Safer

Goal: platform-managed policies are idempotent without deleting tenant/manual policy state.

Tasks:

- Update `sync-access-policies.sh` to manage only policies with ProDocStore-owned names or markers.
- Create new managed policies before deleting old managed policies.
- Preserve unknown/manual policies.
- Preserve reusable/undeletable policies.
- Keep lockout behavior: no allow rules means no managed allow policy, so the Access app stays closed.
- Keep One-time PIN enforcement for simple email/domain Access rules.
- Add local tests around:
  - preserve manual policy
  - replace stale managed policy
  - no allow rules
  - raw `ACCESS_RULES_JSON`
  - create-before-delete ordering

Acceptance:

- Running sync twice is idempotent.
- Manual Cloudflare policies are not removed.
- A failed create does not destroy the previous working managed policy.

### Phase 3: Add Platform Publish Jobs

Goal: introduce the managed publish pipeline without breaking client-hosted publishing.

Tasks:

- Add a publish jobs table or reuse the current jobs model if one exists.
- Add GitHub App webhook handling for push events.
- Map `installation.id + repository.full_name` to registered KBs.
- Enqueue publish jobs with commit SHA, branch, repo, and KB id.
- Add a runner command that:
  - fetches source with a GitHub App installation token
  - runs `python -m zensical build --strict`
  - captures logs
  - records success/failure
- Show latest job status in the Publish console.

Acceptance:

- Pushing to the KB repo creates a platform publish job.
- The job can build source without Cloudflare deployment.
- Failed builds are visible in the UI with actionable logs.

Interim API-owned publish transaction:

- Before full webhook/job publishing, the console should call a platform API endpoint for the current GitHub-backed publish path.
- The API creates or finds the GitHub repo, installs Cloudflare deploy secrets, and commits the complete KB source in one Git commit.
- This removes the browser from multi-step GitHub orchestration and prevents first-run workflow failures caused by committing before deploy secrets exist.
- This is still client-hosted execution because GitHub Actions performs the build/deploy from the KB repo.

### Phase 4: Add Managed Hosting

Goal: ProDocStore publishes without customer Cloudflare secrets.

Tasks:

- Choose the initial managed host:
  - recommended: Cloudflare Worker plus R2 assets
  - fallback: pooled platform-owned Pages deployment
- Add artifact upload keyed by KB id and commit SHA.
- Add route resolution for:
  - `https://<slug>.pdocs.host/`
  - custom domains
  - preview URLs
- Add edge auth before asset serving for private KBs.
- Implement Access-equivalent allow rules in the platform edge layer, or create Cloudflare Access apps centrally only for custom-domain/customer-boundary cases.
- Record deployed version atomically after artifact upload and auth checks pass.

Acceptance:

- A private KB can be published without repo-level Cloudflare secrets.
- Publishing is not blocked by Pages project count.
- Rollback is a pointer change to the previous artifact version.

### Phase 5: Migration

Goal: move existing KB repos safely.

Tasks:

- Detect repos using old generated workflows.
- Offer migration to thin client-hosted workflow.
- Register existing repos in the platform KB registry.
- For managed mode, add GitHub webhook and remove the need for repo Cloudflare secrets.
- Migrate sample repos such as OCCM after the managed host is ready.

Acceptance:

- Existing users keep their repos and commit history.
- A migrated repo publishes on push.
- Private KBs remain inaccessible during and after migration.

## First Code Slice

Implement Phase 1 first:

1. Add reusable workflow `.github/workflows/deploy-zensical-kb.yml`.
2. Replace the generated `deployWorkflow()` output with a thin caller workflow.
3. Run type checks/tests for the editor package if available.
4. Inspect the generated workflow output for public and private forms.

This improves the current product immediately and reduces future migration cost. It does not require touching the dirty API files currently in the worktree.

## Current Progress

Started:

- Added reusable Zensical KB publisher workflow at `.github/workflows/deploy-zensical-kb.yml`.
- Changed generated KB repos to call the reusable workflow from `.github/workflows/deploy.yml`.
- Kept explicit Cloudflare secret mapping instead of `secrets: inherit`.
- Made public mode explicit through a `public` input.
- Kept private mode fail-closed through explicit frontend validation plus workflow-side private/default behavior.
- Preserved advanced `ACCESS_RULES_JSON` support.
- Made Pages project creation fail hard on Cloudflare API errors.
- Resolved Cloudflare's actual Pages subdomain and used that domain for Access setup and verification.
- Rejected Git-connected Cloudflare Pages projects because ProDocStore deploys by direct upload.
- Updated Access policy sync so ProDocStore manages only its own policies and preserves manual tenant policies.
- Added tests for manual policy preservation and update-failure behavior.
- Added an API-owned GitHub publish transaction at `/api/publish/github`.
- Updated the editor console to publish through the API endpoint instead of creating repos, installing secrets, and writing files directly from the browser.
- The API now writes all KB files with one Git tree/commit/ref update rather than one commit per file.
- Added API route tests for the GitHub publish transaction, including deploy-secret ordering and rejection of generated site output.
- Deployment workflows now run service tests before deploying the API, editor, and MCP workers/pages.
- Added D1 `publish_targets` and `publish_jobs` tables for durable GitHub-backed publishing state.
- `/api/publish/github` now records the submitted client-hosted publish target and commit-backed publish job.
- `/api/publish/jobs?draftId=...` exposes submitted publish jobs for console polling/status UI.
- The editor now stores and displays the latest commit, GitHub Actions URL, and publish job id for published KB drafts.

Still needed before this is production-complete:

- Define the release process for future publisher tags after publisher changes are validated.
- Add generated-workflow fixture tests for public/private/custom-domain/raw-Access cases.
- Port the fuller post-deploy verifier and rollback behavior from the GlassDocs publisher.
- Add GitHub webhook-driven publish jobs so a later push to the repo is visible in the ProDocStore console.
- Build the managed hosting path so customer repos no longer need Cloudflare secrets by default.
- Give the API deploy workflow a Cloudflare token with D1 migration permissions, or keep applying migrations manually before schema-dependent deploys.

## Risks

- Reusable workflows referenced by `@main` apply future platform changes immediately to all generated repos. For enterprise stability, support pinned tags later.
- GitHub Actions `workflow_call` inputs cannot accept arbitrary structured values except as strings, so `ACCESS_RULES_JSON` remains a string input.
- First private deploy on Pages can briefly create a public deployment if Access app creation must wait for the Pages project. The managed-hosting phase should remove this exposure path.
- Cloudflare Pages project limits remain a blocker until managed hosting no longer requires one Pages project per KB.

## Open Decisions

- What public hostname should PDocs-managed KBs use before custom domains?
- Should public KBs be allowed in managed mode, or should managed mode default private and require an explicit public toggle?
- Should advanced raw Access JSON stay in the UI, move behind an advanced expander, or become API-only?
- Should ProDocStore support customer-owned Cloudflare Access in managed mode, or only in client-hosted mode?
- Which runner executes managed builds: Cloudflare Workers queues, GitHub Actions in a platform repo, or a separate build service?

## Test Plan

- Unit-test workflow generation in `apps/editor`.
- Shell-test `sync-access-policies.sh` with mocked curl responses.
- Add fixture generated repos for public, private email-domain, private explicit-email, CIDR, custom-domain, and raw Access JSON cases.
- Run a real deploy to a disposable Pages project before changing production generation defaults.
- Verify private KBs return an Access redirect or denial, never HTTP 200, before and after deploy.
