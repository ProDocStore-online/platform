# Decisions / ADRs - section recipe

## What this section is

A running log of **non-obvious technical and product choices**, with the reasoning behind each. The Architecture page describes *what is*; this page records *why we chose it over the alternatives*. Each entry is an Architecture Decision Record (ADR) - a short, dated, immutable note capturing the situation, the call, and the consequences.

The format goes back to Michael Nygard's 2011 essay and is now mainstream practice (AWS, GitHub, Spotify, ThoughtWorks all use ADRs in some form). The point is not bureaucracy - it's that engineers six months from now should be able to read why a choice was made without asking the original author.

## Who reads it

- **Engineers about to challenge a decision** - "why did we use Postgres instead of DynamoDB?" The answer should be on this page, not in Slack history.
- **New hires** - the second page they read after Architecture, to understand the *why* of the *how*.
- **Reviewers of architectural changes** - to know which decisions are still load-bearing and which have been superseded.
- **Auditors** - to understand the rationale behind security, compliance, and data-handling choices.
- **Future you** - the most reliable reader. ADRs save you from re-litigating the same tradeoffs.

## Standard structure

The page is a list of ADRs, each with the same shape. Use a stable numbering scheme (`ADR-1`, `ADR-2`, ...) - numbers never get reused, never get re-ordered, never get reassigned.

Each ADR has these subsections:

1. **Title** - sentence-form, descriptive: "Use PostgreSQL for primary store" not "Database choice." Should make sense out of context.
2. **Status** - one of:
   - *Proposed* - under discussion, not yet effective
   - *Accepted* - the team has agreed and is acting on this
   - *Deprecated* - no longer active but kept for historical context
   - *Superseded by ADR-N* - replaced by a later decision; link forward
3. **Context** - the situation that demanded a decision. Two or three sentences. What forces are in play, what constraints exist.
4. **Decision** - what was chosen, in active voice. "We will use PostgreSQL 16 hosted on Azure Database for PostgreSQL Flexible Server."
5. **Consequences** - what becomes easier *and* what becomes harder. Always both. Decisions that have only positive consequences are usually under-thought.
6. **Alternatives considered** - what else was evaluated, and why each was rejected. Two or three is typical. If the choice was genuinely between only one option, say so explicitly - that itself is a decision worth recording.
7. **References** *(optional)* - links to discussions, prototypes, benchmarks, prior art that informed the choice.

The page itself opens with an index of the ADRs, then renders each in full.

## Anti-patterns

- **ADRs without alternatives.** A decision with no listed alternatives reads as if the choice was obvious. It almost never was. List the things rejected even if they were rejected quickly.
- **Vague consequences.** "This will be a good outcome" is not a consequence. "This trades operational simplicity for higher per-row storage cost; expect a 30% increase in DB monthly spend at our current data volume" is.
- **Editing accepted ADRs.** ADRs are immutable. If a decision changes, write a new ADR that supersedes the old one and update the old one's status to *Superseded by ADR-N*. Editing in place destroys the historical trail and confuses anyone who linked to the original.
- **Including implementation detail.** ADRs record the *choice*, not the *implementation*. "We chose Postgres" is an ADR; "we use Prisma with eager loading" is implementation detail belonging in code or the architecture page.
- **Over-recording.** Not every choice deserves an ADR. Use them for decisions that are non-obvious, hard to reverse, or carry significant tradeoffs. Naming conventions and code style do not need ADRs - those belong in a coding-standards page.
- **One giant ADR.** Each entry is one decision. If a choice has six sub-choices, that's six ADRs. Splitting keeps each readable and individually supersedable.

## When to update

- **Before a non-obvious choice is implemented.** The ADR is what the team reviews to agree. Status starts as *Proposed*; becomes *Accepted* when the team commits.
- **When a decision changes.** Write a new ADR that supersedes the old one - never edit. The new ADR explains what changed and why.
- **When a decision is no longer relevant.** Mark as *Deprecated*. (e.g., "We chose to support Internet Explorer 11" - if IE11 support has been dropped, the ADR is deprecated, not deleted.)
- **When onboarding feedback uncovers a missing one.** If a new hire asks "why did we use X?" and the answer is in someone's head, write the ADR retroactively. Mark it with a "[retroactive]" tag in the status line.

## FreeDocStore-specific notes

- Render as a single `decisions.html` with each ADR as an `<article id="adr-N">` block. Link from the Architecture page liberally - "See ADR-3 for the database choice rationale."
- Keep ADRs short - the original Nygard essay suggests one page per ADR. In HTML terms, that means one `<article>` per decision, typically 200-400 words. Longer ADRs usually contain implementation detail that belongs elsewhere.
- Some teams keep ADRs in a separate `docs/adr/` folder with one HTML file per ADR. That works too; the tradeoff is per-ADR pages have permalinks but break the "scan all decisions in one read" use case. For most projects, a single page is better.
