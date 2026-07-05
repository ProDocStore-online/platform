# Architecture - section recipe

## What this section is

The page that explains **how the system is built**: its components, how data moves between them, what it depends on, and the cross-cutting concerns it addresses (security, scale, observability, availability). Where Requirements describes *what* and Context describes *why*, Architecture describes *how* - the shape a future engineer needs in their head before they make any non-trivial change.

## Who reads it

- **Engineers about to make changes** - need to know the system shape before touching it
- **Reviewers of design changes** - need to know what existed before, to evaluate what is being proposed
- **New hires** - read this before they read code
- **Operators and on-call engineers** - need to know component boundaries to debug incidents
- **Auditors and security reviewers** - rely on this to understand attack surface and trust boundaries

## Standard structure

1. **One-paragraph summary** - the system shape in plain words. "A web frontend, a single backend service, a Postgres primary, and a Cloudflare Worker for edge auth." Reads in 30 seconds.
2. **Components** - major parts and what each does. Group by deployable unit. Each component lists: what it does, what language/framework, what it depends on, who owns it.
3. **System diagram** - visual of components and their connections. Even a simple boxes-and-arrows diagram earns its place. Use Mermaid or an embedded SVG; render-time is irrelevant compared to comprehension.
4. **Data flow** - one or two key flows traced through the system: a request lifecycle, a write lifecycle, an integration call. Sequence diagrams help.
5. **External dependencies** - third-party services and internal services consumed. For each: what it provides, where it runs, what happens when it is down.
6. **Tech stack** - language, runtime, framework, database, key libraries. One line each, no rationale (rationale lives in Decisions).
7. **Deployment topology** - where things run: cloud accounts, regions, environments. How traffic flows in. Where data lives.
8. **Cross-cutting concerns** - security model, availability target, observability approach, scale strategy. High-level only; detail belongs in linked specialist pages (security model, runbook, etc).

## Anti-patterns

- **Tutorial-mode architecture.** Explaining what PostgreSQL is, or how HTTP works, wastes the reader's time. Assume your audience knows their craft.
- **No diagrams.** A page describing a four-component system without a single picture forces the reader to maintain the topology in their head. They will not.
- **Implementation details.** Function names, exact route paths, ORM model definitions belong in code or API docs. Architecture stays at the level of "the auth service issues signed tokens"; the *how* of issuance lives elsewhere.
- **Decisions buried in prose.** "We chose Postgres because..." belongs in an ADR (Decisions section). Architecture references the choice; the Decisions page owns the rationale.
- **Stale diagrams.** A diagram that no longer matches the system is worse than no diagram - it actively misleads. Update or delete; never keep around as "mostly right."
- **Single source-of-truth conflict.** If your code has the canonical schema and your architecture page also describes it, they will drift. Either generate the page from code, or summarise and link.

## When to update

- **A new component is added or removed** - the system shape changed; update before merging.
- **A dependency changes** - new vendor, replaced database, decommissioned upstream. Architecture is the page that lists "what this depends on"; if the answer changes, this changes.
- **A cross-cutting concern shifts** - new SLA target, new compliance requirement, new observability stack. The summary needs to reflect the new commitment.
- **Onboarding feedback** - a new hire's first three "wait, what does X do?" questions are usually questions the architecture page should have answered.
- **Quarterly health check** - even with no specific trigger, re-read the page once a quarter to catch slow drift.

## FreeDocStore-specific notes

- Render as a single `architecture.html`. For very large systems, split into component-level pages (`architecture/auth.html`, `architecture/data-pipeline.html`) and keep the top-level page as an index. Single-file architecture stays readable up to about 8-10 components; beyond that, split.
- Diagrams: prefer Mermaid (text-based, diff-friendly, renders in any browser with the Mermaid script) or hand-drawn SVG embedded inline. PNG screenshots of whiteboard photos are an acceptable interim, but they rot fast.
- Reference the Decisions section liberally. "Why Postgres?" -> "See ADR-3." Lets architecture stay descriptive while preserving a path to the rationale.
