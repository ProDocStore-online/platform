# FreeDocStore section library

Recipes, templates, and AI prompts for the standard sections of a project knowledge base. Pick the sections that fit your project type, drop the templates into your `docs/`, and use the prompts to have an AI tool produce the first draft.

Each section folder contains:

| File | Purpose |
|---|---|
| `recipe.md` | What this section is, who reads it, structure, anti-patterns, when to update |
| `template.html` | A skeleton page your agent fills in - copy into `docs/<section>.html` |
| `prompt.md` | Tool-agnostic prompt to drive the first draft, plus per-tool tweaks (Claude, ChatGPT/Codex, Gemini) |
| `examples/` | One small and one larger completed example |

## The standard set for a software development KB

Organised by software development lifecycle phase. Each section is independent - take the ones that fit, leave the ones that don't.

### Discovery

| Section | Purpose | Status |
|---|---|---|
| [context](./context/) | Who the work is for, why it exists, what surrounds the project | ✅ Ready |
| [requirements](./requirements/) | What the system should do (functional + non-functional + out of scope) | ✅ Ready |
| [glossary](./glossary/) | Project-specific terminology - the team's shared vocabulary | ✅ Ready |

### Design

| Section | Purpose | Status |
|---|---|---|
| [architecture](./architecture/) | How the system is built (components, data flow, dependencies, cross-cutting concerns) | ✅ Ready |
| [decisions](./decisions/) | Architecture Decision Records - why each non-obvious choice was made | ✅ Ready |
| data-model | Entities, relationships, lifecycle, retention | Pending |
| api | Interface contracts - endpoints, payloads, versioning | Pending |

### Planning

| Section | Purpose | Status |
|---|---|---|
| work-breakdown | Decomposition of the work into deliverables (SOW shape) | Pending |
| estimates | Effort, cost, and timeline ranges per deliverable | Pending |
| epics | Backlog of larger work items with priorities | Pending |

### Build

| Section | Purpose | Status |
|---|---|---|
| setup | How a new contributor gets running locally | Pending |
| tech-debt | Known shortcuts, their cost, and proposed remediation | Pending |

### Operate

| Section | Purpose | Status |
|---|---|---|
| runbook | How to operate the system in production - alerts, dashboards, common procedures | Pending |
| reports | Test coverage, performance, dependency health, security scans | Pending |

## Optional add-ons

These ship when the project warrants them - not every project needs every section.

| Section | When to add | Project types |
|---|---|---|
| stakeholders | Projects with more than ~5 people, or external client engagements | Most |
| roadmap | Projects with phased delivery; replaces a flatter "deliverables" view | Most |
| risks | Regulated industries; projects with significant unknowns | Selective |
| testing-strategy | Beyond just "coverage report" - the plan for unit/integration/e2e split | Software dev |
| security | Threat model, attack surface, mitigations | Regulated industries: required |
| ux | Wireframes, design system, user flows | Projects with real UI work |

## How to use

1. **Decide your section set** for the project type. For a software dev KB, the 14 sections above are the recommended baseline.
2. **Copy the templates** you want into your project's `docs/` folder. Rename to match your nav (or leave as-is).
3. **Run the prompts** against your AI tool of choice. Pass the prompt + any project material you have (briefs, transcripts, prior docs, code). The AI produces a first draft.
4. **Read, curate, approve.** The draft is never the final - you are the editor. The point of FreeDocStore is the team approves what ships, not the AI.
5. **Cross-pollinate.** Once the glossary and context sections are stable, pass them as additional context when prompting other sections. AI output gets noticeably more accurate when grounded in the project's existing vocabulary and motivation.
6. **Re-read on the maintenance signals** the recipe lists. Most sections need a refresh when scope, architecture, or stakeholders change.

## Industry alignment

The section set draws from established practice rather than inventing new conventions. Each section has a recognised origin in software engineering:

| Section | Established source |
|---|---|
| Requirements | IEEE 830 / ISO 29148, IIBA BABOK |
| Context | PMI initiating phase, PRINCE2 business case |
| Architecture | 4+1 views (Kruchten), C4 model (Brown), arc42 |
| Decisions / ADRs | Michael Nygard, 2011 |
| Glossary | Domain-Driven Design's *ubiquitous language* (Evans) |
| Data model | DDD, ERD conventions |
| API contracts | OpenAPI / Swagger ecosystem |
| Work breakdown | PMI WBS standard |
| Estimates | Story-point, T-shirt, planning poker (Agile) |
| Epics | Scrum / SAFe |
| Setup / Onboarding | Universal practice |
| Tech debt | Ward Cunningham, 1992 |
| Runbook | Google SRE Book |
| Reports | SQA practice (coverage, dependency scans, etc.) |

The synthesis - bundling these into a coherent set, organising by SDLC phase, providing AI-tuned prompts for each - is FreeDocStore's contribution. The components are all real.

## Guiding principles

- **Same shape, different content.** Every section follows the same structure: skeleton template, prompt, examples. Adopters can predict what they'll find.
- **Tool-agnostic by default, tool-tuned where it helps.** Most prompts work on any frontier model. Tool-specific notes call out where Claude vs ChatGPT vs Gemini behave differently.
- **Examples carry weight.** The recipe describes the section in words; the examples show what good actually looks like. Both matter.
- **Author-agnostic.** The prompts work for human authors who want a starting outline as much as for AI agents producing first drafts.
- **Phase-aware.** Sections cluster by software development lifecycle phase; teams can adopt incrementally as the project matures.
