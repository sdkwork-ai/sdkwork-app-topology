import { normalizeText } from './env-file.mjs';
import { ACCESS_ENDPOINT_KINDS } from './access-endpoints.mjs';
import { parseProfileId } from './profile-id.mjs';
import { MANAGED_RESOURCE_DRIVERS } from './managed-resources.mjs';

export const PROCESS_ROLES = Object.freeze([
  'client', 'api-standalone-gateway',
  'edge-runtime', 'database', 'redis', 'migration', 'seed', 'worker', 'tunnel',
]);

// The deployment-profile vocabulary, in canonical declaration order.
export const DEPLOYMENT_PROFILES = Object.freeze(['standalone', 'cloud']);

// Archetype is the topology shape an application declares for itself, and it is
// what decides which surfaces that application must declare. Schema v2 carried
// the same table (`REQUIRED_SURFACES_BY_ARCHETYPE` in spec-v2.mjs); the schema v5
// rewrite dropped it and required `application.public-ingress` plus
// `platform.api-gateway` unconditionally, which is wrong for an application that
// owns no ingress at all. Restore the archetype-driven rule instead of demanding
// surfaces an application does not have (APP_RUNTIME_TOPOLOGY_SPEC.md section 4).
export const ARCHETYPES = Object.freeze([
  'application-http-gateway',
  'realtime-application-platform',
  'application-rest-edge-device',
  'application-client-root',
]);

export const REQUIRED_SURFACES_BY_ARCHETYPE = Object.freeze({
  // Owns the application ingress. It may consume the platform gateway as a
  // remote dependency surface, but a standalone-only application is not
  // required to declare one.
  'application-http-gateway': Object.freeze(['application.public-ingress']),
  // Terminates application HTTP and realtime on its own ingress and also talks
  // to the deployed platform gateway.
  'realtime-application-platform': Object.freeze([
    'application.public-ingress', 'platform.api-gateway',
  ]),
  // Edge device fleet: the application HTTP surface, the device ingress, and the
  // platform gateway it reports through.
  'application-rest-edge-device': Object.freeze([
    'application.app-http', 'edge.device-ingress', 'platform.api-gateway',
  ]),
  // Browser-only client root: it ships no owned application ingress (its nginx
  // webserver profile stays disabled) and consumes the platform gateway. It
  // therefore starts no standalone gateway process of its own.
  'application-client-root': Object.freeze(['platform.api-gateway']),
});

// Unknown archetypes keep the historical default: an application ingress.
const DEFAULT_REQUIRED_SURFACES = Object.freeze(['application.public-ingress']);

export const RUNTIME_TARGETS = Object.freeze([
  'browser', 'desktop', 'tablet-ipados', 'tablet-android',
  'capacitor-ios', 'capacitor-android', 'flutter-ios', 'flutter-android',
  'android-native', 'ios-native', 'harmony-native', 'mini-program',
  'server', 'container', 'test-runner',
]);

export const CLIENT_ARCHITECTURES = Object.freeze([
  'pc-web', 'h5', 'capacitor', 'flutter', 'tauri', 'electron',
  'android-native', 'ios-native', 'harmony-native', 'mini-program',
]);

function assertProfileId(profileId, specPath) {
  const parsed = parseProfileId(profileId);
  if (parsed.serviceLayout) {
    throw new Error(`${specPath} profile id ${profileId} must use <deploymentProfile>.<environment>`);
  }
  if (!['standalone', 'cloud'].includes(parsed.deploymentProfile)) {
    throw new Error(`${specPath} profile id ${profileId} has invalid deploymentProfile`);
  }
  return parsed;
}

export function validateTopologySpecV5(spec, specPath = 'topology.spec.json') {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`${specPath} must be a JSON object`);
  }
  if (spec.schemaVersion !== 5) throw new Error(`${specPath} schemaVersion must be 5`);
  if (spec.kind !== 'sdkwork.app.topology') throw new Error(`${specPath} kind must be sdkwork.app.topology`);
  if (!/^sdkwork-[a-z0-9-]+$/u.test(spec.appId ?? '')) throw new Error(`${specPath} appId must use sdkwork-<application-code>`);
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(spec.applicationCode ?? '')) {
    throw new Error(
      `${specPath} applicationCode must be lowercase kebab-case (runtime directory code, e.g. api-gateway); ` +
      'legacy snake_case (e.g. api_gateway) is tolerated during migration only',
    );
  }
  if (!ARCHETYPES.includes(spec.archetype)) {
    throw new Error(`${specPath} archetype must be one of: ${ARCHETYPES.join(', ')}`);
  }
  // APP_MANIFEST_SPEC.md: `runtime.supportedDeploymentProfiles` MUST be non-empty
  // and every value MUST be `standalone` or `cloud`, and a profile-limited surface
  // manifest may declare only the profile it is permitted to ship. The topology
  // vocabulary mirrors that manifest, so it is a non-empty subset in canonical
  // order -- not always both profiles.
  const profiles = spec.vocabulary?.deploymentProfile?.allowed;
  const knownProfiles = Array.isArray(profiles)
    && profiles.length > 0
    && new Set(profiles).size === profiles.length
    && profiles.every((profile) => DEPLOYMENT_PROFILES.includes(profile));
  const canonicalProfiles = knownProfiles
    ? DEPLOYMENT_PROFILES.filter((profile) => profiles.includes(profile))
    : [];
  if (!knownProfiles || canonicalProfiles.join(',') !== profiles.join(',')) {
    throw new Error(
      `${specPath} vocabulary.deploymentProfile.allowed must be a non-empty subset of `
      + `${DEPLOYMENT_PROFILES.join(', ')} in canonical order`,
    );
  }
  if (spec.vocabulary?.hosting || spec.vocabulary?.serviceLayout) {
    throw new Error(`${specPath} hosting/serviceLayout vocabulary is retired in schema v5`);
  }
  const environments = spec.vocabulary?.environment?.allowed;
  if (!Array.isArray(environments) || environments.length === 0) {
    throw new Error(`${specPath} vocabulary.environment.allowed must be a non-empty array`);
  }

  if (spec.cloudIngress !== undefined) {
    throw new Error(`${specPath} cloudIngress is retired; declare remote surface URLs instead`);
  }
  if (spec.database !== undefined) {
    throw new Error(`${specPath} database is retired; topology uses application envKeys and databases use SDKWORK_DATABASE_*`);
  }

  const profileFiles = spec.profileFiles;
  if (!profileFiles || typeof profileFiles !== 'object' || Array.isArray(profileFiles)) {
    throw new Error(`${specPath} profileFiles is required`);
  }
  for (const [profileId, profileFile] of Object.entries(profileFiles)) {
    const parsed = assertProfileId(profileId, specPath);
    if (!environments.includes(parsed.environment)) throw new Error(`${specPath} profile ${profileId} uses an undeclared environment`);
    if (!normalizeText(profileFile) || /^[/\\]|\.\./u.test(profileFile)) throw new Error(`${specPath} profileFiles.${profileId} must be a safe relative path`);
  }

  const surfaces = spec.surfaces ?? {};
  for (const surfaceId of REQUIRED_SURFACES_BY_ARCHETYPE[spec.archetype] ?? DEFAULT_REQUIRED_SURFACES) {
    if (!surfaces[surfaceId]) {
      throw new Error(`${specPath} missing required surface for archetype ${spec.archetype}: ${surfaceId}`);
    }
  }
  for (const [surfaceId, surface] of Object.entries(surfaces)) {
    if (!normalizeText(surface.connectivityPlane)) throw new Error(`${specPath} surfaces.${surfaceId}.connectivityPlane is required`);
    if (!surface.bindEnv && !surface.httpUrlEnv && !surface.optional) {
      throw new Error(`${specPath} surfaces.${surfaceId} must declare bindEnv or httpUrlEnv`);
    }
  }

  const orchestration = spec.orchestration?.profiles;
  if (!orchestration || typeof orchestration !== 'object') throw new Error(`${specPath} orchestration.profiles is required`);
  for (const [profileId, profile] of Object.entries(orchestration)) {
    assertProfileId(profileId, specPath);
    if (!profileFiles[profileId]) throw new Error(`${specPath} orchestration profile ${profileId} is missing from profileFiles`);
    const processesById = new Map(
      (profile.processes ?? []).map((process) => [process.id, process]),
    );
    for (const process of profile.processes ?? []) {
      if (!normalizeText(process.id)) throw new Error(`${specPath} ${profileId} process id is required`);
      if (!PROCESS_ROLES.includes(process.role)) throw new Error(`${specPath} ${profileId} process ${process.id} requires a canonical role`);
      if (process.applicationRoot !== undefined
        && (process.role !== 'client' || !normalizeText(process.applicationRoot))) {
        throw new Error(`${specPath} ${profileId} process ${process.id} applicationRoot is valid only on a client process`);
      }
      if (process.role === 'edge-runtime') {
        if (!/^_sdkwork:runtime:[a-z0-9][a-z0-9:-]*$/u.test(normalizeText(process.script))) {
          throw new Error(`${specPath} ${profileId} edge-runtime ${process.id} requires an _sdkwork:runtime:* script`);
        }
        if (!/^docs\/(?:adr|architecture\/decisions)\/[A-Za-z0-9._/-]+\.md$/u.test(normalizeText(process.decisionRef))) {
          throw new Error(`${specPath} ${profileId} edge-runtime ${process.id} requires a canonical decisionRef`);
        }
      }
      if (process.runtimeTargets !== undefined) {
        if (!Array.isArray(process.runtimeTargets) || process.runtimeTargets.length === 0
          || process.runtimeTargets.some((target) => !RUNTIME_TARGETS.includes(target))) {
          throw new Error(`${specPath} ${profileId} process ${process.id} runtimeTargets must contain canonical runtime targets`);
        }
      }
      if (process.clientArchitectures !== undefined) {
        if (process.role !== 'client'
          || !Array.isArray(process.clientArchitectures)
          || process.clientArchitectures.length === 0
          || process.clientArchitectures.some((architecture) => !CLIENT_ARCHITECTURES.includes(architecture))) {
          throw new Error(`${specPath} ${profileId} process ${process.id} clientArchitectures must contain canonical client architectures on a client process`);
        }
      }
      if (process.bindEnv !== undefined && !/^[A-Z][A-Z0-9_]+$/u.test(process.bindEnv)) {
        throw new Error(`${specPath} ${profileId} process ${process.id} bindEnv must be an environment key`);
      }
      if (profileId === 'cloud.development' && !['client', 'tunnel'].includes(process.role)) {
        throw new Error(`${specPath} cloud.development forbids local process role ${process.role}`);
      }
    }
    const browserDeliveryIds = new Set();
    for (const delivery of profile.browserDeliveries ?? []) {
      const label = `${specPath} ${profileId} browser delivery ${delivery.id ?? '<missing>'}`;
      if (!/^[a-z0-9][a-z0-9.-]*$/u.test(normalizeText(delivery.id))) {
        throw new Error(`${label} id must use lowercase dot/kebab tokens`);
      }
      if (browserDeliveryIds.has(delivery.id)) {
        throw new Error(`${label} is duplicated`);
      }
      browserDeliveryIds.add(delivery.id);
      if (!normalizeText(delivery.applicationRoot) || /^[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(delivery.applicationRoot)) {
        throw new Error(`${label} applicationRoot must be a safe relative path`);
      }
      if (!Array.isArray(delivery.clientArchitectures)
        || delivery.clientArchitectures.length === 0
        || new Set(delivery.clientArchitectures).size !== delivery.clientArchitectures.length
        || delivery.clientArchitectures.some((architecture) => !CLIENT_ARCHITECTURES.includes(architecture))) {
        throw new Error(`${label} clientArchitectures must contain unique canonical client architectures`);
      }
      if (delivery.originMode !== 'same-origin') {
        throw new Error(`${label} originMode must be same-origin`);
      }
      const cloudApiSurface = delivery.apiSurfaceId === 'platform.api-gateway';
      if (cloudApiSurface && !profileId.startsWith('cloud.')) {
        throw new Error(`${label} apiSurfaceId platform.api-gateway is allowed only in cloud profiles`);
      }
      if (delivery.apiSurfaceId !== 'application.public-ingress' && !cloudApiSurface) {
        throw new Error(`${label} apiSurfaceId must be application.public-ingress or platform.api-gateway`);
      }
      if (profileId === 'standalone.development'
        && delivery.deliveryMode !== 'dev-server-proxy') {
        throw new Error(`${label} must use dev-server-proxy`);
      }
      if (profileId === 'standalone.production'
        && delivery.deliveryMode !== 'gateway-static') {
        throw new Error(`${label} must use gateway-static`);
      }
      if (delivery.deliveryMode === 'dev-server-proxy') {
        const client = processesById.get(delivery.clientProcessId);
        if (!client || client.role !== 'client' || !normalizeText(client.bindEnv)) {
          throw new Error(`${label} requires a clientProcessId that references a client with bindEnv`);
        }
        if (delivery.preserveCanonicalPaths !== true) {
          throw new Error(`${label} must preserve canonical API paths`);
        }
        if (!Array.isArray(client.clientArchitectures)
          || client.clientArchitectures.length !== delivery.clientArchitectures.length
          || !delivery.clientArchitectures.every((architecture) => client.clientArchitectures.includes(architecture))) {
          throw new Error(`${label} clientArchitectures must match its client process`);
        }
        const rendererArchitectures = new Set();
        for (const [architecture, renderer] of Object.entries(delivery.renderers ?? {})) {
          const rendererLabel = `${label} renderer ${architecture}`;
          if (!delivery.clientArchitectures.includes(architecture)) {
            throw new Error(`${rendererLabel} must be one of the delivery clientArchitectures`);
          }
          if (rendererArchitectures.has(architecture)) {
            throw new Error(`${rendererLabel} is duplicated`);
          }
          rendererArchitectures.add(architecture);
          if (!normalizeText(renderer.applicationRoot)
            || /^[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(renderer.applicationRoot)) {
            throw new Error(`${rendererLabel} applicationRoot must be a safe relative path`);
          }
          if (!renderer.command && !renderer.script && !renderer.crate
            && !(renderer.package && renderer.script)) {
            throw new Error(`${rendererLabel} requires a command/args or script invocation`);
          }
          if (renderer.defaultPort !== undefined
            && (!Number.isInteger(renderer.defaultPort) || renderer.defaultPort < 1
              || renderer.defaultPort > 65535)) {
            throw new Error(`${rendererLabel} defaultPort must be between 1 and 65535`);
          }
          for (const key of ['portEnv', 'hostEnv']) {
            if (renderer[key] !== undefined && !/^[A-Z][A-Z0-9_]+$/u.test(renderer[key])) {
              throw new Error(`${rendererLabel} ${key} must be an environment key`);
            }
          }
          if (renderer.env !== undefined
            && (!renderer.env || typeof renderer.env !== 'object' || Array.isArray(renderer.env))) {
            throw new Error(`${rendererLabel} env must be a string map`);
          }
        }
        for (const rule of delivery.deviceOverrides ?? []) {
          if (!normalizeText(rule.pattern)) {
            throw new Error(`${label} device override requires a pattern`);
          }
          if (!['mobile', 'desktop'].includes(rule.deviceClass)) {
            throw new Error(`${label} device override deviceClass must be mobile or desktop`);
          }
        }
        if (delivery.tabletArchitecture !== undefined
          && !['pc-web', 'h5'].includes(delivery.tabletArchitecture)) {
          throw new Error(`${label} tabletArchitecture must be pc-web or h5`);
        }
      } else if (delivery.deliveryMode === 'gateway-static') {
        if (delivery.renderers !== undefined || delivery.deviceOverrides !== undefined
          || delivery.tabletArchitecture !== undefined) {
          throw new Error(`${label} renderers/deviceOverrides/tabletArchitecture are dev-server-proxy only`);
        }
        const host = processesById.get(delivery.hostProcessId);
        if (!host || host.role !== 'api-standalone-gateway') {
          throw new Error(`${label} requires a gateway hostProcessId`);
        }
        if (!normalizeText(delivery.buildOutput)
          || /^[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(delivery.buildOutput)) {
          throw new Error(`${label} buildOutput must be a safe relative path`);
        }
        if (!/^[A-Z][A-Z0-9_]+$/u.test(delivery.runtimeRootEnv ?? '')) {
          throw new Error(`${label} runtimeRootEnv must be an environment key`);
        }
        if (delivery.mountPath !== '/' || delivery.spaFallback !== '/index.html') {
          throw new Error(`${label} requires mountPath / and spaFallback /index.html`);
        }
      } else {
        throw new Error(`${label} requires a canonical deliveryMode`);
      }
    }
    const accessEndpointIds = new Set();
    for (const endpoint of profile.accessEndpoints ?? []) {
      if (!/^[a-z0-9][a-z0-9.-]*$/u.test(normalizeText(endpoint.id))) {
        throw new Error(`${specPath} ${profileId} access endpoint id must use lowercase dot/kebab tokens`);
      }
      if (accessEndpointIds.has(endpoint.id)) {
        throw new Error(`${specPath} ${profileId} access endpoint id ${endpoint.id} is duplicated`);
      }
      accessEndpointIds.add(endpoint.id);
      if (!ACCESS_ENDPOINT_KINDS.includes(endpoint.kind)) {
        throw new Error(`${specPath} ${profileId} access endpoint ${endpoint.id} requires a canonical kind`);
      }
      if (!normalizeText(endpoint.path)?.startsWith('/') || /[?#]/u.test(endpoint.path)) {
        throw new Error(`${specPath} ${profileId} access endpoint ${endpoint.id} path must be an absolute path without query or hash`);
      }
      const processId = normalizeText(endpoint.source?.processId);
      const surfaceId = normalizeText(endpoint.source?.surfaceId);
      if (Boolean(processId) === Boolean(surfaceId)) {
        throw new Error(`${specPath} ${profileId} access endpoint ${endpoint.id} must reference exactly one processId or surfaceId`);
      }
      if (processId) {
        const process = processesById.get(processId);
        if (!process) {
          throw new Error(`${specPath} ${profileId} access endpoint ${endpoint.id} references unknown process ${processId}`);
        }
        if (!normalizeText(process.bindEnv)) {
          throw new Error(`${specPath} ${profileId} access endpoint ${endpoint.id} process ${processId} must declare bindEnv`);
        }
      }
      if (surfaceId && !surfaces[surfaceId]) {
        throw new Error(`${specPath} ${profileId} access endpoint ${endpoint.id} references unknown surface ${surfaceId}`);
      }
      if (endpoint.runtimeTargets !== undefined
        && (!Array.isArray(endpoint.runtimeTargets)
          || endpoint.runtimeTargets.length === 0
          || endpoint.runtimeTargets.some((target) => !RUNTIME_TARGETS.includes(target)))) {
        throw new Error(`${specPath} ${profileId} access endpoint ${endpoint.id} runtimeTargets must contain canonical runtime targets`);
      }
      if (endpoint.clientArchitectures !== undefined
        && (!Array.isArray(endpoint.clientArchitectures)
          || endpoint.clientArchitectures.length === 0
          || endpoint.clientArchitectures.some((architecture) => !CLIENT_ARCHITECTURES.includes(architecture)))) {
        throw new Error(`${specPath} ${profileId} access endpoint ${endpoint.id} clientArchitectures must contain canonical client architectures`);
      }
    }
    for (const resource of profile.managedResources ?? []) {
      if (!normalizeText(resource.id)) throw new Error(`${specPath} ${profileId} managed resource id is required`);
      if (!MANAGED_RESOURCE_DRIVERS.includes(resource.driver)) {
        throw new Error(`${specPath} ${profileId} managed resource ${resource.id} requires a supported driver`);
      }
      for (const key of ['enabledEnv', 'listenAddressEnv', 'listenPortEnv', 'distributionEnv']) {
        if (resource[key] !== undefined && !/^[A-Z][A-Z0-9_]+$/u.test(resource[key])) {
          throw new Error(`${specPath} ${profileId} managed resource ${resource.id} ${key} must be an environment key`);
        }
      }
    }
  }
  const standalone = orchestration['standalone.development'];
  // APP_RUNTIME_TOPOLOGY_SPEC.md: a `standalone.development` plan reports exactly
  // one application HTTP ingress *when the application serves application HTTP
  // APIs*. That condition is load-bearing: a browser-only client root declares
  // no application-plane HTTP surface, so it starts no standalone gateway and its
  // orchestration legitimately carries no `api-standalone-gateway` process.
  // `protocols` is optional on a surface (the schema constrains it only when it is
  // present), so the signal is the connectivity plane itself: an application-plane
  // surface that is not declared `optional` is an ingress the application serves.
  const declaresApplicationHttpApi = Object.entries(surfaces).some(([, surface]) => (
    surface?.connectivityPlane === 'application' && surface.optional !== true
  ));
  if (standalone && declaresApplicationHttpApi) {
    const gateways = (standalone.processes ?? []).filter((process) => process.role === 'api-standalone-gateway');
    if (gateways.length !== 1) throw new Error(`${specPath} standalone.development requires exactly one api-standalone-gateway`);
  }
  return spec;
}
