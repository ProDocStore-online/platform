# ProDocStore Strategy

Status: direction set 2026-07-13. Supersedes the GitHub-backed scaffold in the README
(which cloned FreeDocStore). ProDocStore is being built **platform-native**, not
GitHub-backed. See the "Architecture decision" section for why.

## One line

**The private knowledge base your AI agents read and maintain** — MCP-native, human-reviewed.

## Positioning

Not "GitBook but paid." Incumbents (GitBook, Confluence, Notion, Mintlify, ReadMe) are
human-first docs tools with an AI chat bolted on. ProDocStore is the inverse and it's the
category nobody owns: **agent-native private knowledge**.

- Docs an AI agent can **read and update** through a reviewable `prompt → proposal → diff → approve`
  loop, over an **org-scoped MCP server**.
- Every page ships agent-readable metadata; the org's own agents (support bots, internal
  copilots, coding agents) query and keep the knowledge current, with human review gates.

This is the docs analog of PWS ("AI-operated knowledge-graph CMS" for web) — same motion,
applied to private docs. Reuse the family pattern; don't invent a new one.

## Free → Pro funnel

FreeDocStore is the funnel: public docs are free forever, businesses get hooked editing them
AI-first, then graduate to ProDocStore when they need **private** knowledge. The line is
drawn by **what the knowledge is** (public vs private), not who publishes it.
See freedocstore-docs `free-vs-pro.md`.

## Architecture decision: platform-native (no GitHub as source of truth)

The scaffold cloned FreeDocStore (private repos in the `ProDocStore-online` GitHub org).
**We are not doing that.** Reasons:

1. **Data ownership.** A business paying for private staff/customer docs will not accept them
   living in repos under the *vendor's* GitHub org. And requiring the customer's own GitHub org
   makes every buyer a GitHub shop — most aren't.
2. **You must own access control to sell it.** RBAC + audit + agent-gating are the product;
   they can't be delegated to "it's in GitHub."
3. **Family precedent.** PWS went platform-native (D1/R2, no per-site GitHub). Matching it keeps
   the family coherent and lets ProDocStore vendor PWS's engine patterns rather than rebuild.

**Therefore:**

- **Source of truth: D1** (structure, metadata, RBAC) **+ R2** (page content, assets).
- **No GitHub required.** GitHub becomes an *optional* "connect / import / sync" feature for
  dev-heavy teams (Option A as a feature, not the foundation).
- The console AI editor is reused ~verbatim; "apply" writes to platform storage with a native
  approve/merge step (the "Reviewed PR" mode becomes an internal review, not a GitHub PR).
- The Chrome extension carries over in concept but is re-plumbed to the platform API and rides
  the user's authed session — **phase 2**, behind the console + MCP.

The cost we accept: we own storage, versioning, and the review workflow (GitHub gave those for
free). We need them anyway to sell RBAC/audit/agent-gating, so it's product work, not waste.

## Hosting

**Our infrastructure** (our Cloudflare account: Workers + D1 + R2 + Pages), the client's private
docs in our storage behind access control — standard SaaS (GitBook/Notion model). The client
brings only their **custom domain** (`docs.theircompany.com` CNAME'd to our Worker). Their-own-infra
/ data residency is an **Enterprise-tier** feature (region-pinned storage or BYO-Cloudflare), not
the base model.

## Editing surfaces

1. **Console AI editor** (must-have, ~90% reused from FreeDocStore) — prompt → proposal → diff → approve.
2. **Org-scoped MCP server** (the differentiator) — the org's agents read/propose against private KBs.
3. **Chrome extension** (phase 2) — edit the authed private page you're viewing.

## Pricing (per editor seat; viewers free)

- **Team** ~$12–19/editor/mo — unlimited private KBs, Google SSO, custom domain, org MCP, monthly AI-edit quota.
- **Business** ~$39/editor/mo — SAML SSO, audit log, higher AI quota, priority support.
- **Enterprise** — custom: SLA, region/data-residency controls, dedicated quota.

Anchor above the family's $9 (this is B2B private infra, not a consumer unlock), and the AI quota
is real resold COGS.

## The load-bearing risk

**AI quota economics.** We provide the inference, so heavy agents/editors spike COGS. Per-seat/per-org
**quota caps with overage or BYOK-fallback from day one** — this is why FreeDocStore is BYOK-only
(the pressure valve). ProDocStore removing BYOK friction is the value *and* the risk.

## Build order

1. **D1 data model + storage** — orgs, memberships (RBAC), knowledge_bases, pages, proposals, ai_usage. ← in progress
2. **API worker** — org/KB/page/proposal endpoints on D1+R2, session auth, per-org scoping.
3. **Access-controlled publishing** — render private KBs to an authed subdomain, then custom domains.
4. **Console** — reuse FreeDocStore editor, repoint "apply" to the platform proposal/approve flow.
5. **Org-scoped MCP** — read + propose tools bound to the org.
6. **Billing** (Stripe per-seat) + **AI quota** metering.
7. Extension (phase 2), SSO/SAML, audit log, enterprise data-residency.
