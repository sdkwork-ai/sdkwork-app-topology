import path from 'node:path';

import { createGatewayHelpers } from './gateway.mjs';
import { createIamDatabaseHelpers } from './iam-database.mjs';
import { loadEnvFile, mergeRuntimeEnv, normalizeText } from './env-file.mjs';
import { createTopologyRuntimeV2 } from './runtime-v2.mjs';
import { createTopologyRuntimeV5 } from './runtime-v5.mjs';
import {
  DEFAULT_PROFILES,
  DEFAULT_TOPOLOGIES,
  loadTopologySpec,
  listPackageTargets,
  listPackageTargetsByProfile,
  findPackageTarget,
  validateTopologySpec,
} from './spec.mjs';

function createTopologyRuntimeV1(spec, repoRoot) {
  const topologies = spec.vocabulary?.topology?.allowed ?? DEFAULT_TOPOLOGIES;
  const profiles = spec.vocabulary?.profile?.allowed ?? DEFAULT_PROFILES;
  const envKeys = spec.envKeys ?? {};
  const topologyKey = envKeys.topology ?? `SDKWORK_${String(spec.appId).replace(/-/g, '_').toUpperCase()}_TOPOLOGY`;
  const clientTopologyKey = envKeys.clientTopology ?? `VITE_${String(spec.appId).replace(/-/g, '_').toUpperCase()}_TOPOLOGY`;

  function assertTopology(value) {
    const normalized = normalizeText(value);
    if (!normalized || !topologies.includes(normalized)) {
      throw new Error(`topology must be one of: ${topologies.join(', ')}`);
    }
    return normalized;
  }

  function assertProfile(value) {
    const normalized = normalizeText(value);
    if (!normalized || !profiles.includes(normalized)) {
      throw new Error(`profile must be one of: ${profiles.join(', ')}`);
    }
    return normalized;
  }

  function topologyProfilePath(topology, profile) {
    assertTopology(topology);
    assertProfile(profile);
    const relative = spec.profileFiles?.[topology]?.[profile]
      ?? `${spec.profileRoot ?? 'etc/topology'}/${(spec.profilePattern ?? '{topology}.{profile}.env')
        .replaceAll('{topology}', topology)
        .replaceAll('{profile}', profile)}`;
    return path.join(repoRoot, relative);
  }

  function loadTopologyProfile(topology, profile) {
    const profilePath = topologyProfilePath(topology, profile);
    const values = loadEnvFile(profilePath, repoRoot);
    const loadedTopology = normalizeText(values[topologyKey]);
    if (loadedTopology && loadedTopology !== topology) {
      throw new Error(
        `topology profile mismatch: ${profilePath} declares ${loadedTopology}, expected ${topology}`,
      );
    }
    return values;
  }

  function applyTopologyEnv(topology, layers = []) {
    return mergeRuntimeEnv(...layers, {
      [topologyKey]: topology,
      [clientTopologyKey]: topology,
    });
  }

  const topologyHelpers = { assertTopology, assertProfile };
  const gateway = createGatewayHelpers(spec, topologyHelpers);
  const iam = createIamDatabaseHelpers(spec);

  return {
    spec,
    repoRoot,
    schemaVersion: 1,
    topologies,
    profiles,
    envKeys,
    topologyKey,
    clientTopologyKey,
    defaults: {
      devTopology: spec.defaults?.developmentTopology ?? 'standalone',
      buildTopology: spec.defaults?.desktopBuildTopology ?? spec.defaults?.buildTopology ?? 'cloud',
      gatewayBind: spec.defaults?.gatewayBind ?? '127.0.0.1:3900',
    },
    assertTopology,
    assertProfile,
    topologyProfilePath,
    loadTopologyProfile,
    applyTopologyEnv,
    loadEnvFile: (envFile) => loadEnvFile(envFile, repoRoot),
    mergeRuntimeEnv,
    listPackageTargets: () => listPackageTargets(spec),
    listPackageTargetsByProfile: (profile) => listPackageTargetsByProfile(spec, profile),
    findPackageTarget: (targetId) => findPackageTarget(spec, targetId),
    ...gateway,
    resolveIamDevEnv: (env = process.env, options = {}) => iam.resolveIamDevEnv(env, repoRoot, options),
    resolveIamDatabaseEnv: iam.resolveIamDatabaseEnv,
    describeIamDatabaseTarget: iam.describeIamDatabaseTarget,
    assertPostgresReachableForIam: (env, options = {}) => iam.assertPostgresReachableForIam(env, {
      missingDatabaseMessage: spec.messages?.missingPostgres
        ?? 'IAM requires PostgreSQL for dev login. Configure config/host/postgres.env and start PostgreSQL.',
      unreachableDatabaseMessage: spec.messages?.unreachablePostgres,
      ...options,
    }),
  };
}

export function createTopologyRuntime(spec, repoRoot, specPath = path.join(repoRoot, 'specs/topology.spec.json')) {
  if (spec.schemaVersion === 5) return createTopologyRuntimeV5(spec, repoRoot, specPath);
  if (spec.schemaVersion === 2 || spec.schemaVersion === 4) {
    return createTopologyRuntimeV2(spec, repoRoot);
  }
  return createTopologyRuntimeV1(spec, repoRoot);
}

export {
  loadTopologySpec,
  validateTopologySpec,
  listPackageTargets,
  listPackageTargetsByProfile,
  findPackageTarget,
  loadEnvFile,
  mergeRuntimeEnv,
  normalizeText,
};

export { buildProfileId, normalizeDeploymentProfile, parseProfileId } from './profile-id.mjs';
export { waitForHttpHealthy, isHttpHealthy, isTcpPortOpen } from './health.mjs';
