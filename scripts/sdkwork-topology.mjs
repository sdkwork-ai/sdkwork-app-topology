#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createTopologyRuntime,
  loadTopologySpec,
  resolveTopologyLocation,
  validateTopologySpec,
} from '../tools/topology/lib/index.mjs';
import { writeEnvFile } from '../tools/topology/lib/env-file.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRAMEWORK_ROOT = path.resolve(__dirname, '..');

function resolveSpecLocation(appRoot, args) {
  const root = path.resolve(appRoot);
  const explicitSpec = resolveOption(args, '--spec');
  if (explicitSpec) {
    return { specPath: path.resolve(root, explicitSpec), topologyRoot: root, inherited: false };
  }
  return resolveTopologyLocation(root);
}

function describeSpecLocation(appRoot, location) {
  const relative = path.relative(path.resolve(appRoot), location.specPath);
  return (relative && !relative.startsWith('..') ? relative : location.specPath).replaceAll('\\', '/');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }

  if (command === 'validate') {
    const appRoot = resolveOption(args, '--root') ?? process.cwd();
    const location = resolveSpecLocation(appRoot, args);
    const spec = loadTopologySpec(location.specPath);
    console.log(`[sdkwork-topology] valid ${spec.appId} (${describeSpecLocation(appRoot, location)})`);
    return;
  }

  if (command === 'print-matrix') {
    const appRoot = resolveOption(args, '--root') ?? process.cwd();
    const profile = resolveOption(args, '--profile') ?? 'all';
    const location = resolveSpecLocation(appRoot, args);
    const spec = loadTopologySpec(location.specPath);
    const runtime = createTopologyRuntime(spec, location.topologyRoot, location.specPath);
    const targets = runtime.listPackageTargetsByProfile(profile);
    console.log(JSON.stringify({ appId: spec.appId, profile, targets }, null, 2));
    return;
  }

  if (command === 'plan') {
    const appRoot = path.resolve(resolveOption(args, '--root') ?? process.cwd());
    const deploymentProfile = resolveOption(args, '--deployment-profile') ?? 'standalone';
    const environment = resolveOption(args, '--environment') ?? 'development';
    const runtimeTarget = resolveOption(args, '--runtime-target') ?? 'browser';
    const clientArchitecture = resolveOption(args, '--client-architecture');
    const location = resolveSpecLocation(appRoot, args);
    const spec = loadTopologySpec(location.specPath);
    const runtime = createTopologyRuntime(spec, location.topologyRoot, location.specPath);
    if (typeof runtime.resolvePlan !== 'function') throw new Error('resolved plans require topology schemaVersion 5');
    const plan = runtime.resolvePlan(`${deploymentProfile}.${environment}`, runtimeTarget, clientArchitecture);
    if (plan.forbiddenProcesses.length > 0) {
      throw new Error(`resolved plan contains forbidden processes: ${plan.forbiddenProcesses.join(', ')}`);
    }
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (command === 'scaffold-profiles') {
    const specPath = resolveOption(args, '--spec') ?? 'specs/topology.spec.json';
    const appRoot = resolveOption(args, '--root') ?? process.cwd();
    const force = args.includes('--force');
    const spec = loadTopologySpec(path.resolve(appRoot, specPath));
    scaffoldProfiles(spec, appRoot, force);
    return;
  }

  if (command === 'init-app') {
    await initApp(args);
    return;
  }

  throw new Error(`Unsupported command: ${command}`);
}

function printHelp() {
  console.log(`Usage: node scripts/sdkwork-topology.mjs <command> [options]

Commands:
  init-app                 Scaffold topology spec and profile directories in an app repo
  validate                 Validate specs/topology.spec.json in an app repo
  scaffold-profiles        Create missing etc/topology/*.env from templates
  print-matrix             Print packaging targets from topology spec
  plan                     Resolve a deterministic topology v5 runtime plan

Options:
  --root <path>            Application repository root (default: cwd)
  --spec <path>            Topology spec path relative to root (default: specs/topology.spec.json)
  --app-id <id>            Required for init-app
  --app-name <name>        Display name for init-app
  --deployment-profile <standalone|cloud>
  --environment <environment>
  --runtime-target <runtime-target>
  --force                  Overwrite generated files
`);
}

function resolveOption(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return args[index + 1];
}

function scaffoldProfiles(spec, appRoot, force) {
  const templateRoot = path.join(FRAMEWORK_ROOT, 'etc', 'templates');
  if (spec.schemaVersion === 5) {
    for (const [profileId, relative] of Object.entries(spec.profileFiles)) {
      const target = path.join(appRoot, relative);
      if (fs.existsSync(target) && !force) {
        console.log(`[sdkwork-topology] keep ${relative}`);
        continue;
      }
      const [deploymentProfile, environment] = profileId.split('.');
      const prefix = spec.appId.replace(/^sdkwork-/, '').replace(/-/gu, '_').toUpperCase();
      const values = {
        [spec.envKeys?.deploymentProfile ?? `SDKWORK_${prefix}_DEPLOYMENT_PROFILE`]: deploymentProfile,
        [spec.envKeys?.environment ?? `SDKWORK_${prefix}_ENVIRONMENT`]: environment,
        [spec.envKeys?.profileId ?? `SDKWORK_${prefix}_PROFILE_ID`]: profileId,
      };
      for (const surface of Object.values(spec.surfaces ?? {})) {
        if (surface.httpUrlEnv) values[surface.httpUrlEnv] = '';
        if (surface.autostartEnv) values[surface.autostartEnv] = 'false';
      }
      writeEnvFile(target, values);
      console.log(`[sdkwork-topology] wrote ${relative}`);
    }
    return;
  }
  for (const topology of spec.vocabulary.topology.allowed) {
    for (const profile of spec.vocabulary.profile.allowed) {
      const relative = spec.profileFiles[topology][profile];
      const target = path.join(appRoot, relative);
      if (fs.existsSync(target) && !force) {
        console.log(`[sdkwork-topology] keep ${relative}`);
        continue;
      }
      const templateName = `${topology}.${profile}.env.template`;
      const templatePath = path.join(templateRoot, templateName);
      if (fs.existsSync(templatePath)) {
        let content = fs.readFileSync(templatePath, 'utf8');
        content = content
          .replaceAll('{appId}', spec.appId)
          .replaceAll('{topology}', topology)
          .replaceAll('{profile}', profile)
          .replaceAll('{topologyKey}', spec.envKeys?.topology ?? 'SDKWORK_APP_TOPOLOGY')
          .replaceAll('{profileKey}', spec.envKeys?.profile ?? 'SDKWORK_APP_PROFILE')
          .replaceAll('{clientTopologyKey}', spec.envKeys?.clientTopology ?? 'VITE_APP_TOPOLOGY');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
        console.log(`[sdkwork-topology] wrote ${relative}`);
        continue;
      }
      writeEnvFile(target, {
        [spec.envKeys?.topology ?? 'SDKWORK_APP_TOPOLOGY']: topology,
        [spec.envKeys?.profile ?? 'SDKWORK_APP_PROFILE']: profile,
        [spec.envKeys?.clientTopology ?? 'VITE_APP_TOPOLOGY']: topology,
      });
      console.log(`[sdkwork-topology] wrote minimal ${relative}`);
    }
  }
}

async function initApp(args) {
  const appRoot = path.resolve(resolveOption(args, '--root') ?? process.cwd());
  const appId = resolveOption(args, '--app-id');
  const appName = resolveOption(args, '--app-name') ?? appId;
  const force = args.includes('--force');
  if (!appId) {
    throw new Error('init-app requires --app-id');
  }

  const specRelative = resolveOption(args, '--spec') ?? 'specs/topology.spec.json';
  const specPath = path.join(appRoot, specRelative);
  if (fs.existsSync(specPath) && !force) {
    throw new Error(`${specRelative} already exists (use --force to overwrite)`);
  }

  const appCode = appId.replace(/^sdkwork-/, '');
  // Environment-variable prefixes stay snake_case/upper (env convention);
  // applicationCode is the lowercase kebab-case runtime directory code
  // (APPLICATION_DEPLOY_LAYOUT_SPEC §3).
  const applicationEnvPrefix = `SDKWORK_${appCode.replace(/-/g, '_').toUpperCase()}`;
  const spec = validateTopologySpec({
    schemaVersion: 5,
    kind: 'sdkwork.app.topology',
    appId,
    applicationCode: appCode,
    archetype: 'application-http-gateway',
    profileRoot: 'etc/topology',
    profilePattern: '{deploymentProfile}.{environment}.env',
    vocabulary: {
      deploymentProfile: { allowed: ['standalone', 'cloud'] },
      environment: { allowed: ['development', 'production'] },
    },
    defaults: {
      developmentProfileId: 'standalone.development',
      productionProfileId: 'cloud.production',
    },
    profileFiles: {
      'standalone.development': 'etc/topology/standalone.development.env',
      'standalone.production': 'etc/topology/standalone.production.env',
      'cloud.development': 'etc/topology/cloud.development.env',
      'cloud.production': 'etc/topology/cloud.production.env',
    },
    envKeys: {
      deploymentProfile: `${applicationEnvPrefix}_DEPLOYMENT_PROFILE`,
      environment: `${applicationEnvPrefix}_ENVIRONMENT`,
      profileId: `${applicationEnvPrefix}_PROFILE_ID`,
      clientDeploymentProfile: `VITE_${applicationEnvPrefix}_DEPLOYMENT_PROFILE`,
    },
    surfaces: {
      'application.public-ingress': {
        connectivityPlane: 'application',
        protocols: ['http'],
        bindEnv: `${applicationEnvPrefix}_APPLICATION_PUBLIC_INGRESS_BIND`,
        httpUrlEnv: `${applicationEnvPrefix}_APPLICATION_PUBLIC_HTTP_URL`,
        clientHttpEnv: `VITE_${applicationEnvPrefix}_APPLICATION_PUBLIC_HTTP_URL`,
      },
      'platform.api-gateway': {
        connectivityPlane: 'platform',
        protocols: ['http'],
        httpUrlEnv: `${applicationEnvPrefix}_PLATFORM_API_GATEWAY_HTTP_URL`,
        clientHttpEnv: `VITE_${applicationEnvPrefix}_PLATFORM_API_GATEWAY_HTTP_URL`,
      },
    },
    components: {
      standaloneGateway: {
        crate: `sdkwork-api-${appCode}-standalone-gateway`,
        binary: `sdkwork-api-${appCode}-standalone-gateway`,
      },
    },
    orchestration: {
      profiles: {
        'standalone.development': {
          processes: [{
            id: 'standalone-gateway',
            role: 'api-standalone-gateway',
            crate: `sdkwork-api-${appCode}-standalone-gateway`,
            binary: `sdkwork-api-${appCode}-standalone-gateway`,
            required: true,
          }],
          healthSurfaces: ['application.public-ingress'],
        },
        'standalone.production': { processes: [], healthSurfaces: [] },
        'cloud.development': {
          processes: [],
          healthSurfaces: ['application.public-ingress', 'platform.api-gateway'],
        },
        'cloud.production': { processes: [], healthSurfaces: [] },
      },
    },
    packaging: {
      targets: [],
    },
  });

  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  console.log(`[sdkwork-topology] wrote ${specRelative}`);

  const docsPath = path.join(appRoot, 'docs', 'topology-standard.md');
  if (!fs.existsSync(docsPath) || force) {
    fs.mkdirSync(path.dirname(docsPath), { recursive: true });
    fs.writeFileSync(
      docsPath,
      `# ${appName} Topology\n\nSee the SDKWork standard in the sibling repository \`sdkwork-app-topology/docs/topology-standard.md\`.\n\nThis app declares its concrete wiring in \`${specRelative}\` and profile files under \`etc/topology/\`.\n`,
      'utf8',
    );
    console.log('[sdkwork-topology] wrote docs/topology-standard.md');
  }

  scaffoldProfiles(spec, appRoot, force);
}

main().catch((error) => {
  console.error(`[sdkwork-topology] ${error.message}`);
  process.exit(1);
});
