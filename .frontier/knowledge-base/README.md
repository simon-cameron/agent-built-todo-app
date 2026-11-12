# Codebase Knowledge Base

This is Frontier's durable, wiki-linked knowledge base of the codebase — atomic Markdown notes
connected by wiki links. It is the **wiki layer**: the code is the immutable source of truth, these
notes summarise and link to it, and the `codebase-knowledge-base` skill is the schema that governs how
it is maintained.

- **Start at** [`index.md`](index.md) — the Map of Content.
- **One concept per note.** Link densely. Cite code by path.
- **Maintained by agents** during brownfield reconnaissance, lazily, per initiative. The Architect owns
  it; engineers refresh the note for any service they change.
- **Status:** `current` (verified), `stub` (seeded, unverified), `stale` (needs review), `hypothesis`
  (asserted, not yet confirmed against code).
- **Lint** with the skill's `knowledge-base-lint.sh` to find broken links, orphans, and stale notes.

Do not store secrets here. Notes are committed with the repo.
