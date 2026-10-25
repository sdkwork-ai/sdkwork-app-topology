# SDKWork Application Lifecycle Adoption

Migrate one application root at a time. Do not bulk-replace commands until its
topology, workflow targets, deploy profiles, and private hooks are known.

## Sequence

1. Run `node ../sdkwork-specs/tools/audit-pnpm-lifecycle-framework.mjs --workspace .. --json` and select the next approved wave.
2. Upgrade `specs/topology.spec.json` to v5 and remove active `hosting` and `serviceLayout` vocabulary.
3. Materialize concrete `etc/topology/<profile-id>.env` files.
4. Declare canonical process roles and commands/private hooks.
5. Add `_sdkwork:dev:standalone` and `_sdkwork:dev:cloud` only when generic process declarations are insufficient.
6. Move existing build/test/check/verify/clean implementations to corresponding private `_sdkwork:*` scripts.
7. Replace public scripts with thin `sdkwork-app` aliases; keep `dev` as `pnpm dev:standalone`.
8. Align `agent.workflow.json` and the thin GitHub package workflow.
9. Upgrade `deployments/deploy.yaml` to v2 and wire artifact evidence for side-effecting deployment.
10. Run `sdkwork-app doctor` for manifest/source-config/topology/workflow/deploy composition, then runtime-plan checks and the repository verification suite.

## Migration Waves

| Wave | Root shape | Purpose |
| --- | --- | --- |
| 0 | Framework/foundation dependency | Stabilize shared engines first |
| 1 | Topology + workflow + deploy manifest | Full end-to-end pilots |
| 2 | Topology + workflow | Package/release pilots |
| 3 | Topology only | Development/runtime migration |
| 4 | Package manifest without topology | Establish application root contract |
| 5 | Manifest without package root | Native/mobile or incomplete-root remediation |

Each wave requires review and passing evidence before the next application is
modified. The audit command is read-only; `--fail-on-debt` becomes a gate only
for waves already declared migrated.
