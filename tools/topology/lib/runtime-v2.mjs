import path from 'node:path';

import { createGatewayHelpers } from './gateway.mjs';
import { createIamDatabaseHelpers } from './iam-database.mjs';
import { loadEnvFile, mergeRuntimeEnv, normalizeText } from './env-file.mjs';
import {
  buildProfileId,
  listProfileIdsFromVocabulary,
  normalizeDeploymentProfile,
  parseProfileId,
  resolveProfileRelativePath,
} from './profile-id.mjs';
import { createSurfaceHelpers } from './surfaces.mjs';
import {
  listPackageTargets,
  listPackageTargetsByProfile,
  findPackageTarget,
} from './spec.mjs';

function appEnvPrefix(appId) {
  return String(appId).replace(/-/g, '_').toUpperCase();
}

export function createTopologyRuntimeV2(spec, repoRoot) {
  const usesDeploymentProfileVocabulary = Array.isArray(spec.vocabulary?.deploymentProfile?.allowed);
  const usesServiceLayoutVocabulary =
    Array.isArray(spec.vocabulary?.serviceLayout?.allowed)
    && spec.vocabulary.serviceLayout.allowed.length > 0;
  const deploymentProfileValues =
    spec.vocabulary?.deploymentProfile?.allowed
    ?? spec.vocabulary?.hosting?.allowed
    ?? ['standalone', 'cloud'];
  const serviceLayoutValues = usesServiceLayoutVocabulary
    ? spec.vocabulary.serviceLayout.allowed
    : [];
  const environmentValues = spec.vocabulary?.environment?.allowed ?? ['development', 'production'];
  const envKeys = spec.envKeys ?? {};
  const prefix = appEnvPrefix(spec.appId);
  const deploymentProfileKey =
    envKeys.deploymentProfile ?? envKeys.hosting ?? `SDKWORK_${prefix}_DEPLOYMENT_PROFILE`;
  const serviceLayoutKey = envKeys.serviceLayout
    ?? (usesServiceLayoutVocabulary ? `SDKWORK_${prefix}_SERVICE_LAYOUT` : undefined);
  const environmentKey = envKeys.environment ?? `SDKWORK_${prefix}_ENVIRONMENT`;
  const profileIdKey = envKeys.profileId ?? `SDKWORK_${prefix}_PROFILE_ID`;
  const clientDeploymentProfileKey =
    envKeys.clientDeploymentProfile
    ?? envKeys.clientHosting
    ?? envKeys.clientTopology
    ?? `VITE_${prefix}_DEPLOYMENT_PROFILE`;
  const profileIds = Object.keys(spec.profileFiles ?? {});

  function assertDeploymentProfile(value) {
    const normalized = normalizeDeploymentProfile(value);
    if (!normalized || !deploymentProfileValues.includes(normalized)) {
      throw new Error(`deploymentProfile must be one of: ${deploymentProfileValues.join(', ')}`);
    }
    return normalized;
  }

  const assertHosting = assertDeploymentProfile;

  function assertServiceLayout(value) {
    if (!usesServiceLayoutVocabulary) {
      throw new Error('serviceLayout is not configured for this topology spec');
    }
    const normalized = normalizeText(value);
    if (!normalized || !serviceLayoutValues.includes(normalized)) {
      throw new Error(`serviceLayout must be one of: ${serviceLayoutValues.join(', ')}`);
    }
    return normalized;
  }

  function assertEnvironment(value) {
    const normalized = normalizeText(value);
    if (!normalized || !environmentValues.includes(normalized)) {
      throw new Error(`environment must be one of: ${environmentValues.join(', ')}`);
    }
    return normalized;
  }

  function assertProfileId(value) {
    const normalized = normalizeText(value);
    if (!normalized) {
      throw new Error('profile id is required');
    }
    parseProfileId(normalized);
    if (profileIds.length > 0 && !profileIds.includes(normalized)) {
      throw new Error(`profile id must be one of: ${profileIds.join(', ')}`);
    }
    return normalized;
  }

  function profilePath(profileId) {
    const relative = resolveProfileRelativePath(spec, assertProfileId(profileId));
    return path.join(repoRoot, relative);
  }

  function loadProfile(profileId) {
    const resolvedProfileId = assertProfileId(profileId);
    const profilePathValue = profilePath(resolvedProfileId);
    const values = loadEnvFile(profilePathValue, repoRoot);
    const loadedProfileId = normalizeText(values[profileIdKey]);
    if (loadedProfileId && loadedProfileId !== resolvedProfileId) {
      throw new Error(
        `profile mismatch: ${profilePathValue} declares ${loadedProfileId}, expected ${resolvedProfileId}`,
      );
    }
    return values;
  }

  function applyProfileEnv(profileId, layers = []) {
    const { deploymentProfile, serviceLayout, environment } = parseProfileId(assertProfileId(profileId));
    const profileEnv = {
      [deploymentProfileKey]: deploymentProfile,
      [environmentKey]: environment,
      [profileIdKey]: profileId,
      [clientDeploymentProfileKey]: deploymentProfile,
    };
    if (serviceLayoutKey && serviceLayout) {
      profileEnv[serviceLayoutKey] = serviceLayout;
    }
    return mergeRuntimeEnv(...layers, profileEnv);
  }

  const legacyTopologyBridge = {
    assertTopology(value) {
      const normalized = normalizeText(value);
      if (normalized === 'self-hosted' || normalized === 'standalone') {
        return 'standalone';
      }
      if (normalized === 'cloud-hosted' || normalized === 'cloud') {
        return 'cloud';
      }
      throw new Error(`deploymentProfile must be one of: ${deploymentProfileValues.join(', ')}`);
    },
    assertProfile(environment) {
      return assertEnvironment(environment);
    },
  };

  const surfaces = createSurfaceHelpers(spec);
  const gateway = createGatewayHelpers(
    {
      ...spec,
      envKeys: {
        ...envKeys,
        gatewayAutostart:
          envKeys.gatewayAutostart
          ?? spec.surfaces?.['platform.api-gateway']?.autostartEnv
          ?? `SDKWORK_${prefix}_PLATFORM_API_GATEWAY_AUTOSTART`,
        standaloneGatewayBind:
          envKeys.standaloneGatewayBind
          ?? spec.surfaces?.['application.public-ingress']?.bindEnv,
        cloudGatewayBind: envKeys.cloudGatewayBind ?? 'SDKWORK_API_CLOUD_GATEWAY_BIND',
        clientApiGatewayBaseUrl:
          envKeys.clientApiGatewayBaseUrl
          ?? spec.surfaces?.['platform.api-gateway']?.clientHttpEnv
          ?? spec.surfaces?.['application.public-ingress']?.clientHttpEnv,
        apiGatewayBaseUrl:
          envKeys.apiGatewayBaseUrl
          ?? spec.surfaces?.['platform.api-gateway']?.httpUrlEnv
          ?? spec.surfaces?.['application.public-ingress']?.httpUrlEnv,
      },
    },
    legacyTopologyBridge,
  );

  function toGatewayTopology(deploymentProfile) {
    const normalized = normalizeText(deploymentProfile);
    if (normalized === 'self-hosted' || normalized === 'standalone') {
      return 'standalone';
    }
    return 'cloud';
  }

  function resolveGatewayBind(env, deploymentProfile) {
    const normalizedDeploymentProfile = assertDeploymentProfile(deploymentProfile);
    if (toGatewayTopology(normalizedDeploymentProfile) === 'standalone') {
      const applicationBind = surfaces.resolveSurfaceBind(env, 'application.public-ingress');
      if (applicationBind) {
        return applicationBind;
      }
    }
    return gateway.resolveGatewayBind(env, toGatewayTopology(normalizedDeploymentProfile));
  }

  function resolveGatewayBaseUrl(env, deploymentProfile) {
    const normalizedDeploymentProfile = assertDeploymentProfile(deploymentProfile);
    // APP_RUNTIME_TOPOLOGY_SPEC section 4.2: dev:cloud binds the local
    // platform gateway (ip:port). Private dev scripts resolve the gateway
    // through this shared helper, so the binding must live here too.
    const localGateway = normalizeText(env.SDKWORK_LOCAL_PLATFORM_API_GATEWAY_HTTP_URL);
    const gatewayEnvironment = normalizeText(env.SDKWORK_ENVIRONMENT)
      || normalizeText(env.SDKWORK_APP_ENVIRONMENT);
    if (
      normalizedDeploymentProfile === 'cloud'
      && gatewayEnvironment === 'development'
      && /^(?:https?|wss?):\/\//u.test(localGateway)
    ) {
      return localGateway.replace(/\/+$/u, '');
    }
    if (toGatewayTopology(normalizedDeploymentProfile) === 'standalone') {
      const applicationUrl = surfaces.resolveSurfaceHttpUrl(env, 'application.public-ingress');
      if (applicationUrl) {
        return applicationUrl;
      }
    }
    const platformUrl = spec.surfaces?.['platform.api-gateway']
      ? surfaces.resolveSurfaceHttpUrl(env, 'platform.api-gateway')
      : undefined;
    if (platformUrl) {
      return platformUrl;
    }
    return gateway.resolveGatewayBaseUrl(env, toGatewayTopology(normalizedDeploymentProfile));
  }

  const iam = createIamDatabaseHelpers(spec);
  function buildDefaultProfileId(deploymentProfile, serviceLayout, environment) {
    return usesServiceLayoutVocabulary
      ? buildProfileId(deploymentProfile, serviceLayout, environment)
      : buildProfileId(deploymentProfile, environment);
  }

  return {
    spec,
    repoRoot,
    schemaVersion: 2,
    profileIds,
    deploymentProfileValues,
    hostingValues: deploymentProfileValues,
    serviceLayoutValues,
    environmentValues,
    envKeys,
    deploymentProfileKey,
    hostingKey: deploymentProfileKey,
    serviceLayoutKey,
    environmentKey,
    profileIdKey,
    clientDeploymentProfileKey,
    clientHostingKey: clientDeploymentProfileKey,
    defaults: {
      developmentProfileId: spec.defaults?.developmentProfileId
        ?? buildDefaultProfileId(
          usesDeploymentProfileVocabulary ? 'standalone' : 'self-hosted',
          usesDeploymentProfileVocabulary ? 'unified-process' : 'split-services',
          'development',
        ),
      productionProfileId: spec.defaults?.productionProfileId
        ?? buildDefaultProfileId(
          usesDeploymentProfileVocabulary ? 'cloud' : 'cloud-hosted',
          'split-services',
          'production',
        ),
      desktopBuildProfileId: spec.defaults?.desktopBuildProfileId
        ?? spec.defaults?.productionProfileId
        ?? buildDefaultProfileId(
          usesDeploymentProfileVocabulary ? 'standalone' : 'cloud-hosted',
          usesDeploymentProfileVocabulary ? 'unified-process' : 'split-services',
          'production',
        ),
      gatewayBind: spec.defaults?.gatewayBind ?? '127.0.0.1:3900',
    },
    buildProfileId,
    parseProfileId,
    listProfileIds: () => (profileIds.length > 0 ? profileIds : listProfileIdsFromVocabulary(spec)),
    assertDeploymentProfile,
    assertHosting,
    assertServiceLayout,
    assertEnvironment,
    assertProfileId,
    profilePath,
    loadProfile,
    applyProfileEnv,
    loadEnvFile: (envFile) => loadEnvFile(envFile, repoRoot),
    mergeRuntimeEnv,
    listPackageTargets: () => listPackageTargets(spec),
    listPackageTargetsByProfile: (profile) => listPackageTargetsByProfile(spec, profile),
    findPackageTarget: (targetId) => findPackageTarget(spec, targetId),
    ...surfaces,
    shouldAutostartGateway: (env) => {
      if (normalizeText(env[deploymentProfileKey]) === 'standalone') {
        return false;
      }
      if (spec.surfaces?.['platform.api-gateway']) {
        return surfaces.resolveSurfaceAutostart(env, 'platform.api-gateway', true);
      }
      return gateway.shouldAutostartGateway(env);
    },
    resolveGatewayBind,
    resolveGatewayBaseUrl,
    resolveStandaloneGatewayConfigPath: (env) => gateway.resolveStandaloneGatewayConfigPath(env, repoRoot),
    resolveCloudGatewayConfigPath: (env, profile = 'development') =>
      gateway.resolveCloudGatewayConfigPath(env, profile, repoRoot),
    resolveIamDevEnv: (env = process.env, options = {}) => iam.resolveIamDevEnv(env, repoRoot, options),
    resolveIamDatabaseEnv: iam.resolveIamDatabaseEnv,
    describeIamDatabaseTarget: iam.describeIamDatabaseTarget,
    assertPostgresReachableForIam: (env, options = {}) => iam.assertPostgresReachableForIam(env, {
      missingDatabaseMessage: spec.messages?.missingPostgres
        ?? 'IAM requires PostgreSQL for dev login. Configure config/host/postgres.env and start PostgreSQL.',
      unreachableDatabaseMessage: spec.messages?.unreachablePostgres,
      ...options,
    }),
    listOrchestrationProcesses: (profileId) =>
      spec.orchestration?.profiles?.[assertProfileId(profileId)]?.processes ?? [],
    listHealthSurfaces: (profileId) =>
      spec.orchestration?.profiles?.[assertProfileId(profileId)]?.healthSurfaces ?? [],
  };
}
