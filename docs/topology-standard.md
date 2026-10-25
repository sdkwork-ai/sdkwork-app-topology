# SDKWork Topology V5 Runtime

Topology v5 is the application-owned machine declaration consumed by the
shared local lifecycle framework. Normative vocabulary lives in
`../../sdkwork-specs/APP_RUNTIME_TOPOLOGY_SPEC.md`; this document explains the
framework implementation.

## Resolution

The framework resolves these authorities in order:

1. `agent.app.config.json` for application identity and supported profiles.
2. `specs/topology.spec.json` for surfaces, processes, roles, and profile files.
3. `etc/topology/<profile-id>.env` for concrete URLs, binds, and environment values.
4. `package.json` private `_sdkwork:*` hooks or process commands for application-specific execution.
5. `sdkwork.workflow.json` for package, publish, and CI deployment lifecycle.
6. `deployments/deploy.yaml` for deployment execution.

No framework layer owns application-specific source paths, Cargo workspace
members, Flutter flavors, Gradle tasks, Xcode schemes, or Vite package names.
Those remain private hook/process facts.

## Development Profiles

`standalone.development` starts exactly one standalone application gateway when
the app serves HTTP, then declared dependencies and clients. Health checks run
before clients. Embedded dependency API assemblies share that application's
public ingress; standalone profiles cannot define `platform.api-gateway`
server or browser URL keys, and the framework never autostarts a separate
platform gateway for a standalone profile.

Browser delivery is resolved independently from dependency assembly placement.
Each standalone browser client declares `browserDeliveries` for the selected
profile. Development uses `dev-server-proxy`, so the renderer bind is the
browser-visible origin and `application.public-ingress` is a private canonical-
path proxy target. Production uses `gateway-static`, so the application ingress
is both the browser-visible origin and API target, with a declared build output,
runtime asset root, mount path, and SPA fallback.

`cloud.development` starts clients and explicit tunnels only. Required remote
surfaces must have concrete deployed URLs. Under `platform-collapsed`,
application and platform HTTP surfaces use the same origin.

## Resolved Plan

The v1 runtime-plan output records:

- active profile, environment, and runtime target;
- local processes and canonical roles;
- local gateway and data stores;
- remote surfaces and Base URL provenance;
- browser-visible origins, private API targets, and delivery-mode evidence;
- declared access endpoints and the selected primary endpoint;
- health checks and config sources;
- forbidden cloud-development roles and any violating processes.

The CLI fails before side effects when plan validation finds a forbidden role,
missing endpoint, loopback endpoint without a tunnel, or different collapsed
origins.

## Lifecycle Facade

Public pnpm commands call `sdkwork-app`. Application-specific implementations
are private `_sdkwork:*` scripts. This separation allows Rust, Node, Vite,
Tauri, Flutter, Gradle, Xcode, Harmony, and mini-program roots to share the same
public lifecycle without pretending their build commands are identical.

The framework directly owns selection and validation; private hooks own only
the final language/tool invocation. Release and deployment phases are delegated
to their canonical framework engines rather than copied into application
scripts.
