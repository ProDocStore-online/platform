# Glossary - section recipe

## What this section is

A single page that defines the **terms used throughout the project knowledge base**, with a definition tuned to *your* domain rather than the public dictionary one. The page exists for one reason: to prevent terminology drift between requirements, architecture, tickets, and code. When everyone on the project means slightly different things by "case," "tenant," or "intake," the docs accumulate ambiguity. The glossary is where ambiguity gets pinned down.

The pattern comes from Domain-Driven Design's *ubiquitous language* concept - the team agrees on a shared vocabulary and uses it consistently in code, tests, docs, and conversations. The glossary is that vocabulary, written down.

## Who reads it

- **New contributors** - reading docs that contain unfamiliar terms; the glossary explains them.
- **Engineers writing code** - to confirm they are using the team's term, not a synonym from another domain.
- **Reviewers of requirements and design docs** - to catch terminology drift before it lands.
- **Stakeholders and clients** - especially in regulated or specialised industries, the glossary doubles as a shared-meaning record between vendor and client.
- **AI agents drafting docs** - the glossary primes them with the team's preferred terms; without it, agents fall back to dictionary defaults that may not match the project's actual usage.

## Standard structure

The glossary is mostly a list. Structure is light by design.

1. **A short intro paragraph** (optional) - explaining the purpose and any conventions the glossary uses (e.g., "Bold synonyms; *italic* terms refer to other glossary entries").
2. **An alphabetised list of terms.** Each entry has:
   - **Term** - the canonical name. The form the team has agreed to use everywhere (in code, in docs, in tickets, in conversation).
   - **Definition** - 1-3 sentences. Domain-specific, not dictionary-generic. Avoid using the term inside its own definition.
   - **Example or usage** *(optional)* - a short concrete example or a sample sentence showing the term used correctly.
   - **Synonyms** *(optional)* - other names the term goes by in the wild, especially terms used by external systems or in legacy docs. Marked clearly as synonyms so people know to use the canonical term.
   - **See also** *(optional)* - related glossary entries.

That's it. Glossaries are valuable because they are short and findable. Resist the urge to over-structure.

## Anti-patterns

- **Generic dictionary definitions.** "Case: a particular instance of something" is useless. The glossary should answer "what does *this team* mean by *case* in *this project*?" - that almost always involves naming the specific scope, lifecycle, or constraint that distinguishes the term.
- **Stale entries.** A term removed from the system but still in the glossary actively misleads. Run through the glossary quarterly and delete or mark deprecated.
- **Synonyms without a canonical term.** If "client," "customer," and "user" all appear in your docs and the glossary lists all three as "the person who uses the system," nothing is settled. Pick one. List the others as synonyms pointing to the canonical.
- **Defining the term using the term.** "Case management - the management of cases." Useless. The definition has to use other words.
- **Acronym soup with no expansion.** Domain-specific acronyms (ROI, SLA, KPI) are fine when expanded. "Per the SLA" is fine if SLA is in the glossary; otherwise it is jargon.
- **One-page-per-term.** Glossary entries are short. Splitting into per-term pages makes the glossary unfindable - the value is "scan the list, ctrl-F for the term, get the answer." Keep it one page.

## When to update

- **A new domain term enters the project** - the first time it shows up in a requirements doc, an architecture page, or a ticket, add it to the glossary.
- **Two team members use different words for the same thing** - canonicalise. Pick one term; make the other a synonym.
- **A term changes meaning** - happens on long-running projects when the system evolves. Update the definition; consider adding a note about the older meaning if legacy docs still use the old sense.
- **A term is removed from the system** - delete its entry, or mark *Deprecated* and link to whatever replaced it.
- **A new contributor's question is "what does X mean here?"** - the answer should be on this page. If it is not, add it now.

## ProDocStore-specific notes

- Render as a single `glossary.html`. Most glossaries fit comfortably in one page even for fairly large projects (50-150 terms). At larger scale, group by category with `<h2>` headings (e.g., *Domain terms, System terms, Process terms*) but keep the file singular.
- Use `<dl>` (description list) for the term/definition pairs - it is the semantic HTML for this exact pattern. `<dt>` for the term, `<dd>` for the definition. Browsers render it cleanly; screen readers handle it well; search engines understand it.
- Anchor each term: `<dt id="case">case</dt>` lets other pages link directly to a definition (`glossary.html#case`).
- The glossary is one of the most useful pages for AI agents. Always pass it as context when asking an agent to draft any other section - it is the cheapest way to keep agent output aligned with the team's vocabulary.
