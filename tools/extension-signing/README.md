# `@browshare/remote-tab-extension-signing`

Deterministic CRX3 signing and Chrome managed-policy generation for BrowShare Remote Tab.

## Get started

Use the [source setup guide](../../docs/getting-started.md#build-from-source), then run the commands
below from the repository root. The [complete-host guide](../../docs/getting-started.md#build-and-sign-the-extension)
shows how to serve the signed artifacts and connect their identity to Chrome managed policy.

## Generate a key and sign a build

```bash
pnpm --filter @browshare/remote-tab-extension build
pnpm --filter @browshare/remote-tab-extension-signing build

node tools/extension-signing/dist/cli.mjs generate-key \
  --key tmp/extension-signing/private.pem

node tools/extension-signing/dist/cli.mjs build \
  --source packages/extension/build/chrome \
  --key tmp/extension-signing/private.pem \
  --out tmp/extension-release \
  --base-url https://downloads.example.com/remote-tab/0.1.23/
```

Replace the example base URL with the location where your deployment will serve the generated
CRX and update manifest. Preserve the signing key securely for subsequent builds.

Keep the private key outside the served release directory. Reusing the same key preserves the
Extension ID; replacing it creates a different ID and requires coordinated Chrome policy and
runtime configuration changes.

