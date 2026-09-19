import path from 'node:path';

import { resolveDeclaredAccessEndpoints } from './access-endpoints.mjs';
import { LOCAL_PLATFORM_API_GATEWAY_HTTP_URL_KEY } from './dev-gateway-binding.mjs';
import { resolveOwnedBindings } from './development-ownership.mjs';
import { normalizeText } from './env-file.mjs';
import { resolveProcessInvocation } from './lifecycle.mjs';

const FORBIDDEN_CLOUD_DEVELOPMENT_ROLES = Object.freeze([
  'api-standalone-gateway',
  'edge-runtime', 'database', 'redis', 'migration', 'seed', 'worker',
]);
const CLIENT_ARCHITECTURES = new Set([
  'pc-web', 'h5', 'capacitor', 'flutter', 'tauri', 'electron',
  'android-native', 'ios-native', 'harmony-native', 'mini-program',
]);

const DEFAULT_RENDERER_HOST = '127.0.0.1';

const DEFAULT_RENDERER_PROBE_USER_AGENTS = Object.freeze({
  'pc-web': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0',
  h5: 'Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 Chrome/136.0',
});

function resolveRendererPort(value, label) {
  const normalized = normalizeText(value);
  if (!normalized || !/^\d+$/u.test(normalized)) {
    throw new Error(`${label} requires a TCP port (portEnv or defaultPort)`);
  }
  const port = Number.parseInt(normalized, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be between 1 and 65535`);
  }
  return port;
}

function resolveDeliveryRenderers({ profileId, delivery, profileEnv }) {
  return Object.entries(delivery.renderers ?? {}).map(([architecture, renderer]) => {
    const label = `${profileId} browser delivery ${delivery.id} renderer ${architecture}`;
    const defaultPort = renderer.defaultPort === undefined ? undefined : resolveRendererPort(
      renderer.defaultPort,
      `${label} defaultPort`,
    );
    const portEnv = normalizeText(renderer.portEnv);
    const port = resolveRendererPort(
      portEnv ? (profileEnv[portEnv] ?? defaultPort) : defaultPort,
      label,
    );
    const hostEnv = normalizeText(renderer.hostEnv);
    const host = hostEnv ? (normalizeText(profileEnv[hostEnv]) ?? DEFAULT_RENDERER_HOST) : DEFAULT_RENDERER_HOST;
    const invocation = resolveProcessInvocation(renderer);
    if (!invocation) {
      throw new Error(`${label} requires a command/args or script invocation`);
    }
    return {
      architecture,
      applicationRoot: renderer.applicationRoot,
      invocation,
      port,
      host,
      defaultPort: defaultPort ?? null,
      portEnv: portEnv ?? null,
      hostEnv: hostEnv ?? null,
      userAgent: normalizeText(renderer.userAgent)
        ?? DEFAULT_RENDERER_PROBE_USER_AGENTS[architecture]
        ?? DEFAULT_RENDERER_PROBE_USER_AGENTS['pc-web'],
      env: renderer.env ?? {},
      label: path.basename(renderer.applicationRoot),
    };
  });
}

function remoteUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return !['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host);
  } catch {
    return false;
  }
}

function urlOrigin(value, label) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
    return url.origin;
  } catch {
    throw new Error(`${label} must resolve to an absolute HTTP(S) URL`);
  }
}

/**
 * APP_RUNTIME_TOPOLOGY_SPEC §4.2: `dev:cloud` binds the local platform gateway
 * (ip:port) through SDKWORK_LOCAL_PLATFORM_API_GATEWAY_HTTP_URL. A loopback
 * surface URL equal to that anchor is the sanctioned dev-process binding, not
 * a leaked development default.
 */
function isLocalPlatformGatewayAnchor(value, profileEnv) {
  const anchor = normalizeText(profileEnv[LOCAL_PLATFORM_API_GATEWAY_HTTP_URL_KEY]);
  if (!anchor) return false;
  try {
    return urlOrigin(value, 'surface URL') === urlOrigin(anchor, LOCAL_PLATFORM_API_GATEWAY_HTTP_URL_KEY);
  } catch {
    return false;
  }
}

function browserOriginFromBind(value, label) {
  const binding = String(value ?? '').trim();
  const bracketed = /^\[([^\]]+)\]:(\d+)$/u.exec(binding);
  const plain = /^([^:]+):(\d+)$/u.exec(binding);
  const match = bracketed ?? plain;
  if (!match) throw new Error(`${label} must resolve to <host>:<port>`);
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must resolve to a valid TCP port`);
  }
  const rawHost = match[1];
  const host = ['0.0.0.0', '::'].includes(rawHost) ? '127.0.0.1' : rawHost;
  const formattedHost = host.includes(':') ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}

function sameStringSet(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value) => right.includes(value));
}

function resolveBrowserDeliveries({
  profileId,
  profile,
  processes,
  profileEnv,
  resolvedBaseUrls,
  runtimeTarget,
  clientArchitecture,
}) {
  const ids = new Set();
  const declared = profile.browserDeliveries ?? [];
  for (const delivery of declared) {
    if (!Array.isArray(delivery.clientArchitectures)
      || delivery.clientArchitectures.length === 0
      || new Set(delivery.clientArchitectures).size !== delivery.clientArchitectures.length
      || delivery.clientArchitectures.some((value) => !CLIENT_ARCHITECTURES.has(value))) {
      throw new Error(`${profileId} browser delivery ${delivery.id} requires canonical clientArchitectures`);
    }
  }
  if (runtimeTarget !== 'browser') {
    return [];
  }
  return declared
    .filter((delivery) => (
      !clientArchitecture || delivery.clientArchitectures.includes(clientArchitecture)
    ))
    .map((delivery) => {
      if (ids.has(delivery.id)) {
        throw new Error(`${profileId} contains duplicate browser delivery ${delivery.id}`);
      }
      ids.add(delivery.id);
      if (delivery.originMode !== 'same-origin') {
        throw new Error(`${profileId} browser delivery ${delivery.id} must use originMode same-origin`);
      }
      const cloudApiSurface = delivery.apiSurfaceId === 'platform.api-gateway';
      if (cloudApiSurface && !profileId.startsWith('cloud.')) {
        throw new Error(`${profileId} browser delivery ${delivery.id} apiSurfaceId platform.api-gateway is allowed only in cloud profiles`);
      }
      if (delivery.apiSurfaceId !== 'application.public-ingress' && !cloudApiSurface) {
        throw new Error(`${profileId} browser delivery ${delivery.id} must target application.public-ingress or platform.api-gateway`);
      }
      if (profileId === 'standalone.development'
        && delivery.deliveryMode !== 'dev-server-proxy') {
        throw new Error(`${profileId} browser delivery ${delivery.id} must use dev-server-proxy`);
      }
      if (profileId === 'standalone.production'
        && delivery.deliveryMode !== 'gateway-static') {
        throw new Error(`${profileId} browser delivery ${delivery.id} must use gateway-static`);
      }
      const apiTarget = resolvedBaseUrls[delivery.apiSurfaceId];
      if (!apiTarget) {
        throw new Error(`${profileId} browser delivery ${delivery.id} cannot resolve ${delivery.apiSurfaceId}`);
      }
      const apiTargetOrigin = urlOrigin(
        apiTarget,
        `${profileId} browser delivery ${delivery.id} API target`,
      );

      if (delivery.deliveryMode === 'dev-server-proxy') {
        const client = processes.find((process) => process.id === delivery.clientProcessId);
        if (!client || client.role !== 'client' || !client.bindEnv) {
          throw new Error(`${profileId} browser delivery ${delivery.id} requires a selected client process with bindEnv`);
        }
        if (!sameStringSet(delivery.clientArchitectures, client.clientArchitectures)) {
          throw new Error(`${profileId} browser delivery ${delivery.id} must match its client process architectures`);
        }
        if (delivery.preserveCanonicalPaths !== true) {
          throw new Error(`${profileId} browser delivery ${delivery.id} must preserve canonical API paths`);
        }
        return {
          id: delivery.id,
          applicationRoot: delivery.applicationRoot,
          clientArchitectures: delivery.clientArchitectures,
          originMode: delivery.originMode,
          deliveryMode: delivery.deliveryMode,
          apiSurfaceId: delivery.apiSurfaceId,
          browserVisibleOrigin: browserOriginFromBind(
            profileEnv[client.bindEnv],
            `${profileId} ${client.bindEnv}`,
          ),
          apiTargetOrigin,
          clientProcessId: delivery.clientProcessId,
          preserveCanonicalPaths: true,
          renderers: resolveDeliveryRenderers({ profileId, delivery, profileEnv }),
          adaptive: Object.keys(delivery.renderers ?? {}).length > 0,
          deviceOverrides: delivery.deviceOverrides ?? [],
          tabletArchitecture: delivery.tabletArchitecture ?? 'pc-web',
        };
      }

      if (delivery.deliveryMode === 'gateway-static') {
        const host = processes.find((process) => process.id === delivery.hostProcessId);
        if (!host || host.role !== 'api-standalone-gateway') {
          throw new Error(`${profileId} browser delivery ${delivery.id} requires an api-standalone-gateway host process`);
        }
        const runtimeRoot = profileEnv[delivery.runtimeRootEnv];
        if (!runtimeRoot) {
          throw new Error(`${profileId} browser delivery ${delivery.id} requires ${delivery.runtimeRootEnv}`);
        }
        if (delivery.mountPath !== '/' || delivery.spaFallback !== '/index.html') {
          throw new Error(`${profileId} browser delivery ${delivery.id} requires root mount and /index.html SPA fallback`);
        }
        return {
          id: delivery.id,
          applicationRoot: delivery.applicationRoot,
          clientArchitectures: delivery.clientArchitectures,
          originMode: delivery.originMode,
          deliveryMode: delivery.deliveryMode,
          apiSurfaceId: delivery.apiSurfaceId,
          browserVisibleOrigin: apiTargetOrigin,
          apiTargetOrigin,
          hostProcessId: delivery.hostProcessId,
          buildOutput: delivery.buildOutput,
          runtimeRootEnv: delivery.runtimeRootEnv,
          runtimeRoot,
          mountPath: '/',
          spaFallback: '/index.html',
        };
      }

      throw new Error(`${profileId} browser delivery ${delivery.id} uses an unsupported deliveryMode`);
    });
}

export function createResolvedRuntimePlan(
  runtime,
  profileId,
  runtimeTarget,
  clientArchitecture,
  { profileEnv: profileEnvOverride } = {},
) {
  const profile = runtime.spec.orchestration?.profiles?.[runtime.assertProfileId(profileId)];
  if (!profile) throw new Error(`missing orchestration profile ${profileId}`);
  const profileEnv = profileEnvOverride ?? runtime.loadProfile(profileId);
  const { deploymentProfile, environment } = runtime.parseProfileId(profileId);
  if (deploymentProfile === 'standalone') {
    const platformSurface = runtime.spec.surfaces?.['platform.api-gateway'];
    for (const key of [platformSurface?.httpUrlEnv, platformSurface?.clientHttpEnv]) {
      if (key && profileEnv[key]) {
        throw new Error(`${profileId} forbids platform.api-gateway URL key ${key}`);
      }
    }
  }
  const processes = (profile.processes ?? []).filter((process) => {
    const runtimeMatches = !Array.isArray(process.runtimeTargets)
      || process.runtimeTargets.length === 0
      || process.runtimeTargets.includes(runtimeTarget);
    const architectureMatches = !Array.isArray(process.clientArchitectures)
      || process.clientArchitectures.length === 0
      || process.clientArchitectures.includes(clientArchitecture);
    return runtimeMatches && architectureMatches;
  });
  const resolvedBaseUrls = {};
  const endpointProvenance = {};
  const remoteSurfaces = [];
  const profileSource = runtime.spec.profileFiles[profileId].replaceAll('\\', '/');
  for (const [surfaceId, surface] of Object.entries(runtime.spec.surfaces ?? {})) {
    if (!surface.httpUrlEnv) continue;
    const value = profileEnv[surface.httpUrlEnv];
    if (!value) continue;
    resolvedBaseUrls[surfaceId] = value;
    endpointProvenance[surfaceId] = { source: profileSource, key: surface.httpUrlEnv };
    if (remoteUrl(value)) remoteSurfaces.push(surfaceId);
  }
  const gateways = processes.filter((process) => process.role === 'api-standalone-gateway');
  const forbiddenProcesses = deploymentProfile === 'cloud' && environment === 'development'
    ? processes.filter((process) => FORBIDDEN_CLOUD_DEVELOPMENT_ROLES.includes(process.role)).map((process) => process.id)
    : [];
  if (deploymentProfile === 'cloud' && environment === 'development') {
    for (const surfaceId of ['application.public-ingress', 'platform.api-gateway']) {
      const surface = runtime.spec.surfaces?.[surfaceId];
      if (surface?.httpUrlEnv && !resolvedBaseUrls[surfaceId]) throw new Error(`${profileId} requires an explicit URL for ${surfaceId}`);
    }
    const tunnel = processes.some((process) => process.role === 'tunnel');
    for (const [surfaceId, value] of Object.entries(resolvedBaseUrls)) {
      if (remoteUrl(value) || tunnel) continue;
      if (isLocalPlatformGatewayAnchor(value, profileEnv)) continue;
      throw new Error(`${profileId} ${surfaceId} must use a deployed URL or explicit tunnel`);
    }
  }
  const accessEndpoints = resolveDeclaredAccessEndpoints({
    runtime,
    profile,
    profileEnv,
    selectedProcesses: processes,
    resolvedBaseUrls,
    runtimeTarget,
    clientArchitecture,
  });
  return {
    schemaVersion: 1,
    kind: 'sdkwork.runtime-plan',
    appId: runtime.spec.appId,
    activeProfile: profileId,
    deploymentProfile,
    environment,
    runtimeTarget,
    clientArchitecture: clientArchitecture ?? null,
    localProcesses: processes,
    ownedBindings: resolveOwnedBindings(runtime.spec, { ...profile, processes }, profileEnv),
    managedResources: profile.managedResources ?? [],
    localGateway: gateways.length === 1
      ? { id: gateways[0].id, role: gateways[0].role, binary: gateways[0].binary ?? gateways[0].crate ?? null }
      : null,
    remoteSurfaces,
    resolvedBaseUrls,
    endpointProvenance,
    browserDeliveries: resolveBrowserDeliveries({
      profileId,
      profile,
      processes,
      profileEnv,
      resolvedBaseUrls,
      runtimeTarget,
      clientArchitecture,
    }),
    accessEndpoints,
    primaryAccessEndpoint:
      accessEndpoints.find((endpoint) => endpoint.primary) ?? null,
    localDataStores: processes.filter((process) => ['database', 'redis'].includes(process.role)).map((process) => ({ id: process.id, role: process.role })),
    healthChecks: (profile.healthSurfaces ?? []).map((surfaceId) => ({ surfaceId, url: resolvedBaseUrls[surfaceId] ?? null, required: true })),
    configSources: [path.relative(runtime.repoRoot, runtime.specPath).replaceAll('\\', '/'), profileSource],
    forbiddenProcessRoles: deploymentProfile === 'cloud' && environment === 'development'
      ? FORBIDDEN_CLOUD_DEVELOPMENT_ROLES
      : [],
    forbiddenProcesses,
  };
}
