# Context - section recipe

## What this section is

The page that explains **who the work is for, why it exists now, and what the world around the project looks like**. Where the Requirements page answers *what* the system should do, Context answers *why are we doing this in the first place* - the business and human background a future contributor needs to make sense of every other decision.

## Who reads it

- **New contributors** - the first page they read on day one to orient
- **Stakeholders** - confirming the team understands the situation, not just the brief
- **Anyone making scope decisions** - "does this proposed change still serve the original goal?"
- **Future maintainers** - years later, trying to understand decisions that look strange without the surrounding context

## Standard structure

1. **Background** - the situation that demands the project. What problem exists, what's already been tried, what changed recently to make this the right time. 1-3 paragraphs.
2. **Sponsor and stakeholders** - who is paying for or politically backing this, and who else has a stake in the outcome. Internal vs external sponsor matters - it shapes risk tolerance and decision speed. List stakeholders with their interests in one line each.
3. **Business motivation** - the value created if this succeeds. Quantify when possible (revenue, cost saved, hours reclaimed, compliance unblocked). When unquantifiable, name the strategic outcome.
4. **Adjacent systems and prior art** - what already exists that this project lives next to or replaces. Internal systems that integrate. External vendors competing for the same outcome. Prior internal attempts and why they did not stick.
5. **External constraints** - things outside the team's control that shape the work: regulatory windows, budget cycles, partnership commitments, organisational politics, market timing.
6. **Definitions** - critical terms, or a pointer to the Glossary section if there is one.

## Anti-patterns

- **Mixing motivation with requirements.** Motivation is "why this exists at all"; requirements are "what it does." Keep them separate so each page stays scannable.
- **Vague stakeholder list.** Naming five people without naming their interests is a recipe for surprises later. "Sarah, Head of Ops" tells you nothing; "Sarah, Head of Ops - cares about caseworker time-on-task; will block anything that increases it" tells you what to test changes against.
- **Skipping prior art.** If the team does not document what was tried before, the project repeats the same failed approaches. Even a one-line "previous internal tool, sunset 2024 because the workflow assumed every case had a single owner" prevents wasted cycles.
- **Treating context as static.** Sponsors change, business cases shift, markets move. A context page that has not been updated in a year is usually wrong.

## When to update

- **Sponsor or principal stakeholder changes** - the politics around the project just shifted; document the new reality before assumptions get baked into work.
- **Business case shifts** - regulatory change, market move, strategy pivot. The motivation paragraph needs to reflect what is actually true now.
- **The team starts asking "why are we still doing this?"** - the answer should already be on this page. If it is not, the page needs an update.
- **A new contributor reads it and is confused** - their confusion is data. Update the page for the next person.

## FreeDocStore-specific notes

- Render as a single `context.html` in `docs/`. Should be one of the first entries in the topbar nav - it is the orientation doc.
- Link to it from the Requirements page (the *what* references the *why*) and from the Architecture page (the *how* references the *why*).
- For projects with substantial prior art, keep the Prior Art subsection tight and link to the artefacts (old tickets, post-mortems, archived repos) rather than reproducing them.
