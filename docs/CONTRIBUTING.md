# Contributing to BrowShare Remote Tab

Remote Tab is an infrastructure library with browser-version-sensitive behavior. A change is complete only when its public contract, runtime validation and real-browser evidence agree.

## Before opening a change

- Read the root [AGENTS.md](../AGENTS.md), the relevant design topic and its implementation/callers.
- Confirm whether Remote Tab or the Embedder owns the requested behavior. An existing task is enough context to begin; a separate Issue is not a prerequisite.
- For browser behavior, describe the supported Chrome version and reproduction environment. Documentation-only changes do not require a new browser run.
- Keep protocol and API changes backward compatible within the current major version and follow the [frozen API change gate](design/15-gate-0-and-api-freeze.md#change-gate).

## Pull request expectations

- Explain the user-visible behavior and ownership boundary.
- Add or update runtime schemas and tests for protocol changes.
- Include the smallest relevant real Chrome flow for capture, input, extension-policy or CDP behavior changes; apply the full compatibility/release gates when their triggers apply. See [Testing and compatibility](design/08-testing.md).
- Update embedding documentation for public API changes.
- Do not commit extension private keys, Profile data, cookies, TURN secrets or recordings.

## Documentation

Ordered design documents live in `docs/design/`. Use sentence-case headings, at most three levels, language-tagged code blocks, relative links and editable Mermaid diagrams.

Viewer visual changes must update [DESIGN.md](DESIGN.md) when they change tokens or interaction rules.

For documentation-only changes, check affected relative links, command entry points, code fences and changed Mermaid sources. Do not format unrelated files or run the entire workspace/browser suite for prose edits. Validate executable examples according to their actual impact. When `docs/DESIGN.md` changes, run `npx @google/design.md lint docs/DESIGN.md` from the repository root.

Keep current delivery status in [PROGRESS.md](../PROGRESS.md). Preserve dated browser/release evidence as historical records; a new documentation edit does not rerun or extend that evidence.

## License

Contributions are provided under the repository's [MIT License](../LICENSE).

