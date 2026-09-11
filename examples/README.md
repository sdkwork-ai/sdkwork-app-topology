Reference topology specs for adopting applications.

| Example | Archetype | Shows |
| --- | --- | --- |
| `sdkwork-drive/` | `application-http-gateway` | An application that owns its application HTTP ingress and also consumes the platform gateway. |
| `sdkwork-im/` | `realtime-application-platform` | HTTP plus WebSocket product ingress with a platform gateway dependency. |
| `sdkwork-aiot/` | `application-rest-edge-device` | Application REST plus a separate edge device ingress and platform gateway. |
| `sdkwork-mall/` | `application-client-root` | A browser-only client root: one `platform.api-gateway` surface, no application ingress, and no local gateway process in its `standalone` profile. |

Every registered archetype ships exactly one example, and
`tests/topology-v5.test.mjs` fails when an archetype has no example or an example
does not validate.

Each example is self-contained: `topology.spec.json` plus the profile env files it
points at, with `profileFiles` paths rooted at `examples/<application>/`. A
credential-shaped assignment copied from a live profile is replaced with a
`DEPLOY_INJECT` placeholder, so an example never carries a credential literal.
