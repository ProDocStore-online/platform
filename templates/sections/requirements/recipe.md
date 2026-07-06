# Requirements - section recipe

## What this section is

A single page that captures **what the system needs to do, what it does not need to do, and the constraints both sides have to live with.** It is the answer to "are we still building the right thing?" - the first place a team checks when scope feels unclear and the artifact a stakeholder reads to confirm shared understanding.

## Who reads it

- **Engineers** - to know what to build and what is out of scope before they start
- **Product or project lead** - to track scope changes against an agreed baseline
- **Stakeholder / client** - to confirm the team understands the ask before work starts (and to anchor change-of-scope conversations later)
- **Future contributors** - to ramp up on what the system was supposed to do, separate from how it ended up working

## Standard structure

A good requirements page has these subsections, in this order:

1. **Goals** - one or two sentences describing what success looks like, framed from the user or stakeholder's perspective. Not a feature list - the outcome the system enables.
2. **Functional requirements** - what the system *does*. Group by capability, not by screen. Number them so they can be referenced (`FR-3`, `FR-4`).
3. **Non-functional requirements** - performance, security, accessibility, scale, observability, compliance. Each one needs a measurable threshold ("p95 < 200 ms" not "should be fast").
4. **Constraints** - things the team cannot change: budget, timeline, mandated tech stack, regulatory frame, integration points that already exist.
5. **Out of scope** - an explicit list of things stakeholders might assume are in scope but are not. This is the section that prevents the most arguments later.
6. **Open questions** - things the team does not yet have answers for, with an owner and a target resolution date for each.

## Anti-patterns

- **Mixing in architecture.** "The system uses PostgreSQL with read replicas" belongs in the architecture page, not requirements. Requirements describe *what*, not *how*.
- **Vague non-functional requirements.** "Should be fast" is not a requirement. "Search results render in under 500 ms p95 on a 50k document corpus" is.
- **Missing out-of-scope.** If you only list what is in scope, anything not listed becomes negotiable. List the negative space explicitly.
- **No prioritization.** When everything is "must have," nothing is. Tag each functional requirement as Must / Should / Could / Won't (MoSCoW), or Phase 1 / Phase 2.
- **Stale open questions.** A list of open questions older than the last sprint is a sign nobody is driving them to resolution. Either close them or escalate.

## When to update

- **Scope changes** - any time a stakeholder asks for something new, decide whether it is a real requirement (update the page, get re-approval) or a nice-to-have (add to "Could" or "Out of scope").
- **Phase boundaries** - re-read at the start of every phase. Requirements that made sense in discovery may not make sense after the design pass.
- **An open question gets answered** - move it from Open Questions into the relevant subsection.
- **A constraint changes** - budget cut, timeline shift, new compliance requirement. These ripple through everything else, so flag prominently.

## ProDocStore-specific notes

- Render as a single `requirements.html` in `docs/`. Long requirements pages stay readable better than split-up ones because cross-references are simpler.
- Number functional requirements with stable IDs (`FR-1`, `FR-2`) so other docs (architecture, epics, test plans) can cite them. IDs don't get renumbered when items are deleted - they stay associated with the original concept forever.
- The "Open questions" block is one of the strongest maintenance signals in any KB. If the page has had open questions for more than two iterations, the team is avoiding a decision.
