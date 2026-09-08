# `@browshare/remote-tab-extension`

Shared TypeScript contracts for the BrowShare Remote Tab Chrome Extension.

## Install the contract package

```bash
pnpm add @browshare/remote-tab-extension
```

The npm package exports managed-runtime parsing, Extension identity and tab-binding types, and the
fixed `browshare:*` MAIN-world Page Script event names. It is not the loadable Chrome Extension.

Build the signed Extension input from the source repository with:

```bash
pnpm --filter @browshare/remote-tab-extension build
```

The loadable MV3 files are written to `packages/extension/build/chrome` and must be signed with the
coordinated release version and the deployment's persistent private key.


`PageScriptEventDetail.requestNotice` is an optional page-side callback returning the protocol's
`NoticeDecision`. Core supplies it only for Sessions with `noticeRequests`; the contract package
does not install a page bridge or add a page global.


The coordinated 0.1.23 candidate accepts bounded `media.configure_quality` commands. It applies
sender encoding and capture FPS together, acknowledges the actual encoder limits, and runs
five-second pressure/recovery sampling in automatic mode even when diagnostic delivery is disabled.
Preset/custom modes keep Chrome congestion control without the additional automatic policy loop.
Quality changes, suspension and capture replacement share one Publisher operation queue. See the
[adaptation policy](../../docs/design/05-extension-and-core.md#automatic-encoder-quality); focused
real Chrome verification of this candidate is still pending.
