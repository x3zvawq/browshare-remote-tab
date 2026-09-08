# Remote Tab documentation guide

Repository engineering constraints live in the root [AGENTS.md](../AGENTS.md). This file adds requirements for documentation under `docs/`.

- Read the design topics relevant to the task. Numbering aids navigation; phase plans and historical records do not block authorized work on later phases.
- Document intended behavior, ownership, protocol constraints and exit criteria. Record current delivery in [PROGRESS.md](../PROGRESS.md), supported by source or runtime evidence. Preserve dates, versions and the original scope of historical test records.
- Update the owning contract and affected examples together. Avoid rewriting unrelated documents for stylistic consistency.
- [DESIGN.md](DESIGN.md) defines product UI behavior. Its confirmations for takeover, local-open or destructive interactions concern end users, not approval for routine agent edits.
- Use relative links, language-tagged code blocks and editable Mermaid. Prefer no more than three heading levels. See [Contributing](CONTRIBUTING.md) for focused validation.

The collaboration guidance draws on [OpenAI Model guidance](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices), consulted 2026-09-05: clarify authorization, remove conflicting instructions, scope verification to the change and report concisely. Project contracts remain in the root guide and topic documents.
