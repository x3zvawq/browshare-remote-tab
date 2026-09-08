# Security policy

## Supported versions

Security fixes target the latest published version. The current 0.1.23 candidate is unpublished;
development versions do not promise stable compatibility, but verifiable security reports are welcome.

## Report privately

Use [Report a vulnerability](https://github.com/x3zvawq/browshare-remote-tab/security/advisories/new)
while signed in to GitHub. Private vulnerability reporting was enabled and read back through the
GitHub API on 2026-09-08. Do not disclose exploitable details in a public issue. No test report or
public advisory was submitted to verify this setting.

Include the affected version and component, deployment prerequisites, required privileges, minimal
reproduction, impact and any known mitigation. Do not attach unrelated Chrome Profiles, cookies,
credentials, page content or transferred files.

## Scope and handling

Remote Tab owns capture, WebRTC, CDP input, Viewer, signaling and embedding contracts. The Embedder
owns business authentication, authorization and persistent browser lifecycle. Tabs in one Chrome
Profile share browser data; this is not account isolation. Page Script is not an authorization
boundary, and CDP and Extension runtime endpoints must remain private.

Maintainers confirm the affected contract and impact privately, request only the minimum necessary
evidence, and coordinate disclosure with the reporter. Fixes include proportionate boundary
verification and identify affected and fixed versions, prerequisites, upgrade steps and practical
mitigations. There is no fixed response-time commitment. A local candidate is not an already
published fix; advisories should link the actual release when available.

For BrowShare Portal, Control Backend, Worker or business authorization issues, use the
[BrowShare security policy](https://github.com/x3zvawq/browshare/security/policy).
