# Signaling, ICE, and TURN

## Connectivity model

ICE selects a network path for WebRTC:

```text
host/direct candidate
  → server-reflexive direct path discovered through STUN
  → TURN/UDP relay
  → TURN/TCP or TURN/TLS relay
```

Direct paths minimize latency and relay bandwidth. TURN provides connectivity when NAT or firewalls prevent direct communication. TURN is a normal fallback, not an error condition.

## Gateway responsibilities

Signaling Gateway:

- Authenticates an authorized Core Session binding.
- Consumes a short-lived, single-use Viewer ticket.
- Pairs both sides for one Session and Viewer generation.
- Relays SDP and ICE candidates.
- Supplies standard `iceServers` and short-lived TURN credentials.
- Supplies the standard `iceTransportPolicy`; normal Gateways use `all`, while a diagnostic or
  policy-specific Gateway may require `relay`.
- Enforces connection, message-size and rate limits.
- Expires unmatched peers and clears pairing state.

Gateway never proxies video, audio, DataChannels, files, clipboard or page data. It does not own long-term application Session state.

## Explicit Gateway assignment

Each Gateway has a stable ID, public endpoint and health state. The Embedder selects one Gateway before issuing a Viewer ticket; Core and Viewer connect to that exact assignment.

This avoids shared pairing state and load-balancer affinity. A Gateway process keeps only short-lived local pairing state. Existing WebRTC can survive Gateway loss, but ICE restart or renegotiation requires a new authorized signaling flow.

## Ticket model

A Viewer ticket binds:

```text
session ID
viewer generation
gateway ID
capabilities
issued-at and expiry
single-use identifier
Embedder audience/issuer
```

It does not contain Chrome target IDs, CDP endpoints, Profile data, TURN shared secrets or application credentials. Default BrowShare validity is 60 seconds; standalone Embedders may choose a similarly short policy.

Gateway must prevent replay even if a ticket is presented before expiry. A multi-instance deployment uses explicit Gateway assignment; replay state therefore remains local to the assigned instance for the ticket lifetime.

Each replacement Viewer receives a strictly increasing generation. Issuing that ticket invalidates
the previous generation's control frames before old signaling is closed. Core keeps the attached tab
alive while the replacement negotiates; a failed or departed replacement returns the Session to a
state where the Embedder can issue another fresh ticket. Reusing an older generation always fails.

## TURN credentials

Gateway derives time-limited TURN REST credentials from a deployment secret or requests them from an external provider. The permanent secret never reaches Core, Extension, Viewer or browser storage.

Credential lifetime covers connection establishment and reasonable ICE restarts without becoming a long-term reusable account. Refresh happens through an authorized signaling path.

## Deployment

Remote Tab accepts standard WebRTC ICE server configuration and does not require a specific vendor. The repository provides coturn examples for:

- STUN/TURN UDP and TCP on 3478.
- TURN TLS on 5349.
- A bounded UDP relay port range.
- Short-term REST credentials.
- External/public IP mapping where required.

TURN TLS on 443 can improve connectivity in restrictive networks but normally requires a dedicated IP or verified L4 TLS routing. A normal HTTP reverse proxy cannot terminate TURN as HTTP.

## Browser proxy separation

Extension does not connect directly to public signaling. It exchanges signaling through loopback Core; Core connects Gateway outside the Chrome Profile web proxy. WebRTC ICE uses browser networking and configured STUN/TURN, not the Profile's HTTP/SOCKS proxy.

System-level transparent proxies, VPNs and host firewall policy remain operator concerns. Diagnostics report observed candidate routes and reachability but do not attempt to bypass host networking policy.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| Viewer arrives before Core | Hold until short pairing timeout |
| Core arrives before Viewer | Hold until short pairing timeout |
| Ticket expired or replayed | Reject without revealing Session existence |
| No direct candidate succeeds | Continue with TURN candidates |
| TURN/UDP blocked | Try TURN/TCP/TLS according to ICE priority |
| Gateway fails after connection | Existing WebRTC continues until renegotiation is needed |
| All ICE paths fail | Close negotiation with `ICE_FAILED` and safe diagnostics |

## Diagnostics

Connectivity diagnostics verify DNS, TLS certificate, WSS upgrade, STUN binding, TURN allocation,
TURN relay and candidate pair type. Forced-relay runs configure the Gateway's
`iceTransportPolicy=relay`, which both Extension and Viewer apply to their PeerConnections; merely
observing relay candidates does not count as a relay pass.

Reports redact credential values and default to candidate types rather than full private/public addresses. Operators can explicitly request detailed local diagnostics outside end-user Viewer output.

Development evidence for the first forced TURN/UDP run is recorded in
[testing and compatibility](08-testing.md#forced-turnudp-development-result). A pass requires the
selected candidate pair, not just gathered candidates, to use relay transport.

The corresponding transport-specific TURN/TCP run is recorded in
[testing and compatibility](08-testing.md#forced-turntcp-development-result). Its selected pair
reports `relayProtocol: tcp`; the candidate protocol itself remains UDP because that field describes
the relayed ICE candidate rather than the client-to-coturn allocation transport.

The trusted-certificate TURN/TLS run is recorded in
[testing and compatibility](08-testing.md#forced-turntls-development-result). Its only configured
ICE URL uses `turns:` and the selected pair reports `relayProtocol: tls`. Diagnostics model relay
transport separately from candidate protocol so TLS is retained without admitting it as an ICE
candidate protocol.

Gateway's structured callback reports peer connection/binding, pair completion, description
direction, redacted ICE candidate type/protocol, Core-to-Viewer terminal error relay, rejection,
disconnect and expiry. Viewer emits the same safe WebRTC progression through its normal typed event
stream. Neither surface records Ticket contents, SDP, candidate addresses or ports. A bound Core
may relay a validated terminal `signal.error` to its Viewer, including `VIEWER_REPLACED`; Viewer-originated
errors are not relayed back to Core.
