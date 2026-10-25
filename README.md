# SDKWork Application Lifecycle And Topology Framework

repository-kind: foundation-dependency

`@sdkwork/app-topology` is the local lifecycle/runtime component of the
SDKWork application framework. Application roots keep declarations and thin
private hooks; shared selection, validation, planning, process orchestration,
package/release delegation, and deployment delegation live in framework
repositories.

## Framework Composition

| Component | Responsibility |
| --- | --- |
| `sdkwork-app-topology` | `sdkwork-app` public lifecycle facade, topology v5 validation, environment loading, resolved runtime plans, development orchestration, and local/network access URL projection |
| `sdkwork-github-workflow` | package matrix, lifecycle phases, signing, SBOM, publication, deployment matrix, reusable GitHub workflow |
| `sdkwork-specs/tools/deployctl.mjs` | typed deploy plans, artifact-evidence verification, nginx apply and rollback |

The global authorities remain:

- `../sdkwork-specs/PNPM_SCRIPT_SPEC.md`
- `../sdkwork-specs/APP_RUNTIME_TOPOLOGY_SPEC.md`
- `../sdkwork-specs/GITHUB_WORKFLOW_SPEC.md`
- `../sdkwork-specs/SDKWORK_DEPLOY_SPEC.md`

## Application Contract

Each deployable application root owns:

```text
agent.app.config.json
package.json
specs/topology.spec.json
etc/topology/<deployment-profile>.<environment>.env
agent.workflow.json                  # when packaged or published
deployments/deploy.yaml                # when deployed by deployctl
```

`package.json` exposes thin public aliases:

```json
{
  "scripts": {
    "dev": "pnpm dev:standalone",
    "dev:standalone": "pnpm exec sdkwork-app dev --deployment-profile standalone",
    "dev:cloud": "pnpm exec sdkwork-app dev --deployment-profile cloud",
    "stop": "pnpm exec sdkwork-app stop",
    "build": "pnpm exec sdkwork-app build",
    "test": "pnpm exec sdkwork-app test",
    "check": "pnpm exec sdkwork-app check",
    "verify": "pnpm exec sdkwork-app verify",
    "clean": "pnpm exec sdkwork-app clean"
  }
}
```

Application-specific implementation commands use the private `_sdkwork:*`
namespace, for example `_sdkwork:build` or `_sdkwork:dev:standalone`. They are
not public product commands. A topology process may instead declare `script`,
explicit `command` plus `args`, or a Cargo `crate`/`binary`; the framework
executes those declarations without a shell.
Processes may declare `runtimeTargets` when browser, desktop, mobile, or other
clients use different local commands. The resolved plan starts only processes
matching the selected `--runtime-target`.

## Topology V5

New and aligned applications use exactly two deployment profiles:

```text
standalone
cloud
```

Profile ids use exactly two segments:

```text
standalone.development
standalone.production
cloud.development
cloud.production
```

`cloud.development` starts local clients and explicit tunnels only. It consumes
deployed application/platform URLs and never starts gateways, API listeners,
databases, Redis, migrations, seeds, or deployed-service workers.

The bundled `specs/topology.schema.v5.json` is a synchronized distribution copy
of `../sdkwork-specs/schemas/sdkwork.app.topology.schema.v5.json`. V1, v2, and
v4 readers remain available only for migration.

## Adaptive Browser Delivery

A `dev-server-proxy` browser delivery that declares `renderers` becomes an
**adaptive PC/H5 dev ingress** owned by the framework (`APP_RUNTIME_TOPOLOGY_SPEC.md`
§8.2): `sdkwork-app dev` starts every declared renderer, waits for readiness,
and serves one same-origin ingress that selects the renderer by device class
(desktop → `pc-web`, mobile → `h5`) with `Vary: user-agent`, keeps canonical
API paths and WebSocket upgrades on `application.public-ingress`, and falls
back to the next available renderer when the preferred one is down.

```json
{
  "browserDeliveries": [{
    "id": "app-adaptive-web",
    "applicationRoot": "apps/sdkwork-app-pc",
    "clientArchitectures": ["pc-web", "h5"],
    "originMode": "same-origin",
    "deliveryMode": "dev-server-proxy",
    "clientProcessId": "app-browser",
    "apiSurfaceId": "application.public-ingress",
    "preserveCanonicalPaths": true,
    "renderers": {
      "pc-web": { "applicationRoot": "apps/sdkwork-app-pc",
                  "command": "node", "args": ["scripts/dev/run-vite.mjs", "--port", "{port}"],
                  "defaultPort": 4176 },
      "h5": { "applicationRoot": "apps/sdkwork-app-h5",
              "command": "node", "args": ["scripts/dev/run-vite.mjs", "--port", "{port}"],
              "defaultPort": 4178 }
    }
  }]
}
```

The delivery's `clientProcessId` keeps `bindEnv` and `applicationRoot`; it is
not launched as a separate process, and the root `_sdkwork:client:browser:*`
hooks are retired once the adaptive delivery is declared. Renderer `env`
values and invocation `args` support the `{host}`, `{port}`, `{httpOrigin}`,
and `{wsOrigin}` tokens. Device detection, fallback order, and collapse modes
mirror `SDKWORK_DEPLOY_SPEC.md` §8; `sdkwork-app doctor` enforces the
declaration through `check-adaptive-web-standard.mjs`.

## Commands

```bash
pnpm exec sdkwork-topology validate --root .
pnpm exec sdkwork-topology plan --root . --deployment-profile cloud --environment development --runtime-target browser
pnpm exec sdkwork-app doctor --root .
pnpm exec sdkwork-app dev --root . --deployment-profile standalone
pnpm exec sdkwork-app dev --root . --deployment-profile cloud
pnpm exec sdkwork-app stop --root .
```

Generic development writes a repository-scoped heartbeat registry outside the source checkout at
the private OS user/runner runtime path `sdkwork/sdkwork-app/<repository-hash>/development-session.json`.
`stop` terminates only the
fresh registered supervisor. On Windows it uses `taskkill /T` for the full
owned process tree and falls back to the registered direct child PIDs plus the
supervisor when the operating-system process-tree service is unavailable.
`doctor` composes lifecycle facade, app-manifest, source-config, adaptive-web,
topology v5, workflow, and deploy-manifest validation.

## Network Access Output

Topology profiles declare typed `accessEndpoints` that reference an existing
process or surface. The resolved runtime plan selects endpoints by runtime
target and client architecture, resolves the effective bind/URL, and rejects
multiple selected primary endpoints. Development hosts format that plan instead
of deciding locally which listener is the application UI:

```js
import {
  formatPrimaryAccessLines,
} from '@sdkwork/app-topology/access-endpoints';

const plan = runtime.resolvePlan('standalone.development', 'browser');
const lines = formatPrimaryAccessLines(plan, {
  prefix: '[application] ',
});
```

The access component owns endpoint selection, non-loopback address discovery,
de-duplication, deterministic ordering, listener-scope handling, URL projection,
and one-link-per-line formatting. Applications own only their log prefix and
product-specific readiness/route diagnostics. A loopback-only listener never
advertises LAN URLs that other devices cannot reach.

Applications with stricter address or security policy can retain their own
URL selection and pass the resulting `{ localUrl, networkUrls }` summary to
`formatResolvedNetworkAccessLines`. This keeps policy application-owned while
reusing the standard one-link-per-line presentation.

Release commands delegate to `sdkwork-github-workflow`; deploy commands
delegate to deployctl. Side-effecting operations retain the explicit profile,
environment, artifact id/digest/evidence, approval, and rollback target gates.
Non-workspace installations set `SDKWORK_APP_MANIFEST_CHECK_CLI`,
`SDKWORK_SOURCE_CONFIG_CHECK_CLI`, `SDKWORK_GITHUB_WORKFLOW_CLI`, and
`SDKWORK_DEPLOY_CLI` to the installed framework entrypoints; applications do
not hardcode a parent workspace layout.

## Verification

```bash
pnpm test
pnpm check
```

## Documentation Canon

- [docs/README.md](docs/README.md)
- [docs/product/prd/PRD.md](docs/product/prd/PRD.md)
- [docs/architecture/tech/TECH_ARCHITECTURE.md](docs/architecture/tech/TECH_ARCHITECTURE.md)
