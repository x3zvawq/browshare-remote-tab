# `@browshare/remote-tab-protocol`

Runtime-validated MessagePack contracts shared by BrowShare Remote Tab Core, Extension, Gateway and
browser clients.

## Get started

Build the coordinated workspace with the [source setup guide](../../docs/getting-started.md#build-from-source).

## Encode and decode a message

```ts
import {
  createProtocolMessage,
  decodeProtocolMessage,
  encodeProtocolMessage,
} from '@browshare/remote-tab-protocol'

const message = createProtocolMessage(
  'session.suspend',
  { sessionId: 'session-1', viewerGeneration: 3, sequence: 12 },
  { reason: 'viewer-unfocused' },
)

const bytes = encodeProtocolMessage(message)
const decoded = decodeProtocolMessage(bytes)
```

Protocol `1.5` rejects incompatible majors, malformed envelopes, unknown messages and payloads that
fail the owning TypeBox schema. Capabilities never grant behavior by themselves; Core still applies
the Embedder's Session authorization at each side-effect boundary.

The package exports `EncodingSettings`, `QualityConfiguration`, `QualityState` and the
corresponding `*Schema` values. Additive advanced-quality messages use `control-reliable` and require
both `advancedQuality` and `qualityControl`. Legacy `quality.request/ack` stays unchanged. See the
[message table and correlation rules](../../docs/design/04-control-protocol.md#advanced-quality-messages-protocol-14).
