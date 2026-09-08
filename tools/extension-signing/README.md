# `@browshare/remote-tab-extension-signing`

Deterministic CRX3 signing and Chrome managed-policy generation for BrowShare Remote Tab.

## Install

```bash
pnpm add --save-dev @browshare/remote-tab-extension-signing
```

## Generate a key and sign a build

```bash
browshare-extension generate-key --key ./private/remote-tab.pem

browshare-extension build \
  --source ./packages/extension/build/chrome \
  --key ./private/remote-tab.pem \
  --out ./release/extension \
  --base-url https://downloads.example.com/remote-tab/0.1.15/
```

Keep the private key outside the served release directory. Reusing the same key preserves the
Extension ID; replacing it creates a different ID and requires coordinated Chrome policy and
runtime configuration changes.

