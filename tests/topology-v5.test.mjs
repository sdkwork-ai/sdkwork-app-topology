import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ARCHETYPES,
  createTopologyRuntime,
  loadTopologySpec,
  REQUIRED_SURFACES_BY_ARCHETYPE,
  validateTopologySpec,
} from '../tools/topology/lib/index.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-topology-v5-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'etc', 'topology'), { recursive: true });
  const spec = {
    schemaVersion: 5,
    kind: 'sdkwork.app.topology',
    appId: 'sdkwork-demo',
    applicationCode: 'demo',
    archetype: 'application-http-gateway',
    vocabulary: {
      deploymentProfile: { allowed: ['standalone', 'cloud'] },
      environment: { allowed: ['development', 'production'] },
    },
    profileFiles: {
      'standalone.development': 'etc/topology/standalone.development.env',
      'cloud.development': 'etc/topology/cloud.development.env',
    },
    envKeys: {
      deploymentProfile: 'SDKWORK_DEMO_DEPLOYMENT_PROFILE',
      environment: 'SDKWORK_DEMO_ENVIRONMENT',
      profileId: 'SDKWORK_DEMO_PROFILE_ID',
    },
    surfaces: {
      'application.public-ingress': {
        connectivityPlane: 'application', bindEnv: 'APP_BIND', httpUrlEnv: 'APP_URL',
      },
      'platform.api-gateway': {
        connectivityPlane: 'platform', httpUrlEnv: 'PLATFORM_URL',
      },
    },
    orchestration: {
      profiles: {
        'standalone.development': {
          processes: [
            { id: 'standalone-gateway', role: 'api-standalone-gateway', crate: 'sdkwork-demo-standalone-gateway' },
            {
              id: 'web-client',
              role: 'client',
              script: '_sdkwork:client',
              bindEnv: 'WEB_BIND',
              runtimeTargets: ['browser'],
              clientArchitectures: ['pc-web'],
            },
          ],
          browserDeliveries: [
            {
              id: 'web-client',
              applicationRoot: 'apps/sdkwork-demo-pc',
              clientArchitectures: ['pc-web'],
              originMode: 'same-origin',
              deliveryMode: 'dev-server-proxy',
              apiSurfaceId: 'application.public-ingress',
              clientProcessId: 'web-client',
              preserveCanonicalPaths: true,
            },
          ],
          accessEndpoints: [
            {
              id: 'application-ui',
              kind: 'user-interface',
              source: { processId: 'web-client' },
              path: '/',
              primary: true,
              runtimeTargets: ['browser'],
              clientArchitectures: ['pc-web'],
            },
            {
              id: 'application-api-reference',
              kind: 'api-reference',
              source: { surfaceId: 'application.public-ingress' },
              path: '/openapi.json',
              runtimeTargets: ['browser'],
            },
          ],
          healthSurfaces: ['application.public-ingress'],
        },
        'cloud.development': {
          processes: [
            { id: 'web-client', role: 'client', script: '_sdkwork:client', runtimeTargets: ['browser'], clientArchitectures: ['pc-web'] },
            { id: 'h5-client', role: 'client', script: '_sdkwork:h5', runtimeTargets: ['browser'], clientArchitectures: ['h5'] },
            { id: 'desktop-client', role: 'client', script: '_sdkwork:desktop', runtimeTargets: ['desktop'], clientArchitectures: ['tauri'] },
          ],
          healthSurfaces: ['application.public-ingress', 'platform.api-gateway'],
        },
      },
    },
  };
  const specPath = path.join(root, 'specs', 'topology.spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  fs.writeFileSync(path.join(root, 'etc', 'topology', 'standalone.development.env'), [
    'SDKWORK_DEMO_PROFILE_ID=standalone.development',
    'APP_BIND=127.0.0.1:8080',
    'APP_URL=http://127.0.0.1:8080',
    'WEB_BIND=0.0.0.0:4173',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'etc', 'topology', 'cloud.development.env'), [
    'SDKWORK_DEMO_PROFILE_ID=cloud.development',
    'APP_URL=https://api.dev.sdkwork.com/app',
    'PLATFORM_URL=https://api.dev.sdkwork.com',
    '',
  ].join('\n'));
  return { root, spec, specPath };
}

test('validates topology v5 and resolves a cloud development plan', () => {
  const { root, spec, specPath } = fixture();
  validateTopologySpec(spec, specPath);
  const runtime = createTopologyRuntime(spec, root, specPath);
  const plan = runtime.resolvePlan('cloud.development', 'browser');
  assert.equal(runtime.schemaVersion, 5);
  assert.equal(plan.localGateway, null);
  assert.deepEqual(plan.localProcesses.map((process) => process.id), ['web-client']);
  assert.deepEqual(plan.forbiddenProcesses, []);
  assert.deepEqual(plan.remoteSurfaces, ['application.public-ingress', 'platform.api-gateway']);
});

test('filters local processes by the selected runtime target', () => {
  const { root, spec, specPath } = fixture();
  const runtime = createTopologyRuntime(spec, root, specPath);
  const plan = runtime.resolvePlan('cloud.development', 'desktop');
  assert.deepEqual(plan.localProcesses.map((process) => process.id), ['desktop-client']);
  spec.orchestration.profiles['cloud.development'].processes[0].runtimeTargets = ['unknown'];
  assert.throws(() => validateTopologySpec(spec, specPath), /canonical runtime targets/u);
});

test('resolves declared process and surface access endpoints into the runtime plan', () => {
  const { root, spec, specPath } = fixture();
  const runtime = createTopologyRuntime(spec, root, specPath);
  const plan = runtime.resolvePlan('standalone.development', 'browser');

  assert.deepEqual(plan.accessEndpoints.map((endpoint) => ({
    id: endpoint.id,
    kind: endpoint.kind,
    primary: endpoint.primary,
    url: endpoint.url,
    binding: endpoint.binding?.value ?? null,
  })), [
    {
      id: 'application-ui',
      kind: 'user-interface',
      primary: true,
      url: 'http://127.0.0.1:4173/',
      binding: '0.0.0.0:4173',
    },
    {
      id: 'application-api-reference',
      kind: 'api-reference',
      primary: false,
      url: 'http://127.0.0.1:8080/openapi.json',
      binding: '127.0.0.1:8080',
    },
  ]);
  assert.equal(plan.primaryAccessEndpoint.id, 'application-ui');
  assert.deepEqual(plan.browserDeliveries, [
    {
      id: 'web-client',
      applicationRoot: 'apps/sdkwork-demo-pc',
      clientArchitectures: ['pc-web'],
      originMode: 'same-origin',
      deliveryMode: 'dev-server-proxy',
      apiSurfaceId: 'application.public-ingress',
      browserVisibleOrigin: 'http://127.0.0.1:4173',
      apiTargetOrigin: 'http://127.0.0.1:8080',
      clientProcessId: 'web-client',
      preserveCanonicalPaths: true,
      renderers: [],
      adaptive: false,
      deviceOverrides: [],
      tabletArchitecture: 'pc-web',
    },
  ]);
});

test('resolves adaptive browser delivery renderers into the runtime plan', () => {
  const { root, spec, specPath } = fixture();
  const profile = spec.orchestration.profiles['standalone.development'];
  const delivery = profile.browserDeliveries[0];
  const client = profile.processes[1];
  client.clientArchitectures = ['pc-web', 'h5'];
  delivery.clientArchitectures = ['pc-web', 'h5'];
  delivery.renderers = {
    'pc-web': {
      applicationRoot: 'apps/sdkwork-demo-pc',
      command: 'node',
      args: ['scripts/dev/run-vite.mjs', '--host', '{host}', '--port', '{port}', '--strictPort'],
      defaultPort: 4176,
      portEnv: 'DEMO_PC_RENDERER_PORT',
    },
    h5: {
      applicationRoot: 'apps/sdkwork-demo-h5',
      script: '_sdkwork:dev-server',
      defaultPort: 4178,
    },
  };
  validateTopologySpec(spec, specPath);
  const runtime = createTopologyRuntime(spec, root, specPath);
  const plan = runtime.resolvePlan('standalone.development', 'browser', undefined, {
    profileEnv: {
      ...runtime.loadProfile('standalone.development'),
      DEMO_PC_RENDERER_PORT: '5199',
    },
  });
  const [resolved] = plan.browserDeliveries;
  assert.equal(resolved.adaptive, true);
  assert.equal(resolved.browserVisibleOrigin, 'http://127.0.0.1:4173');
  assert.deepEqual(resolved.renderers.map((renderer) => ({
    architecture: renderer.architecture,
    label: renderer.label,
    port: renderer.port,
    host: renderer.host,
    defaultPort: renderer.defaultPort,
    portEnv: renderer.portEnv,
    hostEnv: renderer.hostEnv,
    command: renderer.invocation.command,
    args: renderer.invocation.args,
  })), [
    {
      architecture: 'pc-web',
      label: 'sdkwork-demo-pc',
      port: 5199,
      host: '127.0.0.1',
      defaultPort: 4176,
      portEnv: 'DEMO_PC_RENDERER_PORT',
      hostEnv: null,
      command: 'node',
      args: ['scripts/dev/run-vite.mjs', '--host', '{host}', '--port', '{port}', '--strictPort'],
    },
    {
      architecture: 'h5',
      label: 'sdkwork-demo-h5',
      port: 4178,
      host: '127.0.0.1',
      defaultPort: 4178,
      portEnv: null,
      hostEnv: null,
      command: 'pnpm',
      args: ['run', '_sdkwork:dev-server'],
    },
  ]);
});

test('rejects renderer declarations that drift from the delivery architectures', () => {
  const { spec, specPath } = fixture();
  const delivery = spec.orchestration.profiles['standalone.development'].browserDeliveries[0];
  delivery.renderers = {
    flutter: { applicationRoot: 'apps/sdkwork-demo-flutter', command: 'node', args: [] },
  };
  assert.throws(
    () => validateTopologySpec(spec, specPath),
    /renderer flutter must be one of the delivery clientArchitectures/u,
  );
});

test('rejects renderer applicationRoot escapes, invalid ports, and missing invocations', () => {
  const { spec, specPath } = fixture();
  const delivery = spec.orchestration.profiles['standalone.development'].browserDeliveries[0];
  delivery.renderers = {
    'pc-web': { applicationRoot: '../sdkwork-other', command: 'node', args: [] },
  };
  assert.throws(
    () => validateTopologySpec(spec, specPath),
    /renderer pc-web applicationRoot must be a safe relative path/u,
  );
  delivery.renderers = {
    'pc-web': { applicationRoot: 'apps/sdkwork-demo-pc', command: 'node', args: [], defaultPort: 99_999 },
  };
  assert.throws(
    () => validateTopologySpec(spec, specPath),
    /renderer pc-web defaultPort must be between 1 and 65535/u,
  );
  delivery.renderers = {
    'pc-web': { applicationRoot: 'apps/sdkwork-demo-pc', command: 'node', args: [], portEnv: 'lower-case' },
  };
  assert.throws(
    () => validateTopologySpec(spec, specPath),
    /renderer pc-web portEnv must be an environment key/u,
  );
  delivery.renderers = {
    'pc-web': { applicationRoot: 'apps/sdkwork-demo-pc' },
  };
  assert.throws(
    () => validateTopologySpec(spec, specPath),
    /renderer pc-web requires a command\/args or script invocation/u,
  );
});

test('rejects renderers on gateway-static browser deliveries', () => {
  const { spec, specPath } = fixture();
  spec.profileFiles['standalone.production'] = 'etc/topology/standalone.production.env';
  spec.orchestration.profiles['standalone.production'] = {
    processes: [
      { id: 'standalone-gateway', role: 'api-standalone-gateway' },
    ],
    browserDeliveries: [
      {
        id: 'web-client',
        applicationRoot: 'apps/sdkwork-demo-pc',
        clientArchitectures: ['pc-web'],
        originMode: 'same-origin',
        deliveryMode: 'gateway-static',
        apiSurfaceId: 'application.public-ingress',
        hostProcessId: 'standalone-gateway',
        buildOutput: 'apps/sdkwork-demo-pc/dist',
        runtimeRootEnv: 'SDKWORK_DEMO_PC_STATIC_ROOT',
        mountPath: '/',
        spaFallback: '/index.html',
        renderers: {
          'pc-web': { applicationRoot: 'apps/sdkwork-demo-pc', command: 'node', args: [] },
        },
      },
    ],
  };
  assert.throws(
    () => validateTopologySpec(spec, specPath),
    /renderers\/deviceOverrides\/tabletArchitecture are dev-server-proxy only/u,
  );
});

test('server plans exclude browser deliveries and renderer-owned bindings', () => {
  const { root, spec, specPath } = fixture();
  const runtime = createTopologyRuntime(spec, root, specPath);
  const plan = runtime.resolvePlan('standalone.development', 'server');

  assert.deepEqual(plan.browserDeliveries, []);
  assert.equal(plan.ownedBindings.some((binding) => binding.bindEnv === 'WEB_BIND'), false);
  assert.equal(plan.ownedBindings.some((binding) => binding.bindEnv === 'APP_BIND'), true);
});

test('resolves gateway-static browser delivery to the application ingress origin', () => {
  const { root, spec, specPath } = fixture();
  spec.profileFiles['standalone.production'] = 'etc/topology/standalone.production.env';
  spec.orchestration.profiles['standalone.production'] = {
    processes: [
      { id: 'standalone-gateway', role: 'api-standalone-gateway' },
    ],
    browserDeliveries: [
      {
        id: 'web-client',
        applicationRoot: 'apps/sdkwork-demo-pc',
        clientArchitectures: ['pc-web'],
        originMode: 'same-origin',
        deliveryMode: 'gateway-static',
        apiSurfaceId: 'application.public-ingress',
        hostProcessId: 'standalone-gateway',
        buildOutput: 'apps/sdkwork-demo-pc/dist',
        runtimeRootEnv: 'SDKWORK_DEMO_PC_STATIC_ROOT',
        mountPath: '/',
        spaFallback: '/index.html',
      },
    ],
  };
  fs.writeFileSync(path.join(root, 'etc', 'topology', 'standalone.production.env'), [
    'SDKWORK_DEMO_PROFILE_ID=standalone.production',
    'APP_URL=https://demo.example.com',
    'SDKWORK_DEMO_PC_STATIC_ROOT=share/sdkwork/demo-pc',
    '',
  ].join('\n'));

  validateTopologySpec(spec, specPath);
  const runtime = createTopologyRuntime(spec, root, specPath);
  assert.deepEqual(runtime.resolvePlan('standalone.production', 'browser').browserDeliveries, [
    {
      id: 'web-client',
      applicationRoot: 'apps/sdkwork-demo-pc',
      clientArchitectures: ['pc-web'],
      originMode: 'same-origin',
      deliveryMode: 'gateway-static',
      apiSurfaceId: 'application.public-ingress',
      browserVisibleOrigin: 'https://demo.example.com',
      apiTargetOrigin: 'https://demo.example.com',
      hostProcessId: 'standalone-gateway',
      buildOutput: 'apps/sdkwork-demo-pc/dist',
      runtimeRootEnv: 'SDKWORK_DEMO_PC_STATIC_ROOT',
      runtimeRoot: 'share/sdkwork/demo-pc',
      mountPath: '/',
      spaFallback: '/index.html',
    },
  ]);
});

test('rejects a dev browser delivery whose architecture drifts from its client process', () => {
  const { spec, specPath } = fixture();
  spec.orchestration.profiles['standalone.development'].browserDeliveries[0].clientArchitectures = ['h5'];
  assert.throws(
    () => validateTopologySpec(spec, specPath),
    /clientArchitectures must match its client process/u,
  );
});

test('rejects browser delivery modes that conflict with the standalone lifecycle profile', () => {
  const development = fixture();
  development.spec.orchestration.profiles['standalone.development']
    .browserDeliveries[0].deliveryMode = 'gateway-static';
  assert.throws(
    () => validateTopologySpec(development.spec, development.specPath),
    /standalone\.development browser delivery .* must use dev-server-proxy/u,
  );

  const production = fixture();
  production.spec.profileFiles['standalone.production'] =
    'etc/topology/standalone.production.env';
  production.spec.orchestration.profiles['standalone.production'] = {
    processes: [
      { id: 'standalone-gateway', role: 'api-standalone-gateway' },
    ],
    browserDeliveries: [
      {
        id: 'web-client',
        applicationRoot: 'apps/sdkwork-demo-pc',
        clientArchitectures: ['pc-web'],
        originMode: 'same-origin',
        deliveryMode: 'dev-server-proxy',
        apiSurfaceId: 'application.public-ingress',
        clientProcessId: 'web-client',
        preserveCanonicalPaths: true,
      },
    ],
  };
  assert.throws(
    () => validateTopologySpec(production.spec, production.specPath),
    /standalone\.production browser delivery .* must use gateway-static/u,
  );
});

test('rejects non-HTTP application ingress origins in resolved browser deliveries', () => {
  const { root, spec, specPath } = fixture();
  const runtime = createTopologyRuntime(spec, root, specPath);
  const profileEnv = runtime.loadProfile('standalone.development');
  assert.throws(
    () => runtime.resolvePlan('standalone.development', 'browser', 'pc-web', {
      profileEnv: { ...profileEnv, APP_URL: 'file:///tmp/sdkwork-web' },
    }),
    /API target must resolve to an absolute HTTP\(S\) URL/u,
  );
});

test('resolves access endpoints from the effective profile environment', () => {
  const { root, spec, specPath } = fixture();
  const runtime = createTopologyRuntime(spec, root, specPath);
  const profileEnv = runtime.loadProfile('standalone.development');
  const plan = runtime.resolvePlan('standalone.development', 'browser', 'pc-web', {
    profileEnv: { ...profileEnv, WEB_BIND: '127.0.0.1:4199' },
  });

  assert.equal(plan.primaryAccessEndpoint.url, 'http://127.0.0.1:4199/');
  assert.equal(plan.primaryAccessEndpoint.binding.value, '127.0.0.1:4199');
});

test('validates access endpoint references and selected primary uniqueness', () => {
  const { root, spec, specPath } = fixture();
  spec.orchestration.profiles['standalone.development'].accessEndpoints[0].source = {
    processId: 'missing-client',
  };
  assert.throws(
    () => validateTopologySpec(spec, specPath),
    /references unknown process missing-client/u,
  );

  spec.orchestration.profiles['standalone.development'].accessEndpoints[0].source = {
    processId: 'web-client',
  };
  spec.orchestration.profiles['standalone.development'].accessEndpoints[1].primary = true;
  const runtime = createTopologyRuntime(spec, root, specPath);
  assert.throws(
    () => runtime.resolvePlan('standalone.development', 'browser'),
    /multiple primary access endpoints/u,
  );
});

test('filters browser clients by selected client architecture', () => {
  const { root, spec, specPath } = fixture();
  const runtime = createTopologyRuntime(spec, root, specPath);
  assert.deepEqual(
    runtime.resolvePlan('cloud.development', 'browser', 'h5').localProcesses.map((process) => process.id),
    ['h5-client'],
  );
  spec.orchestration.profiles['cloud.development'].processes[1].clientArchitectures = ['unknown'];
  assert.throws(() => validateTopologySpec(spec, specPath), /canonical client architectures/u);
});

test('accepts declared edge runtimes only outside cloud development', () => {
  const { spec, specPath } = fixture();
  const edgeRuntime = {
    id: 'edge.device-ingress',
    role: 'edge-runtime',
    script: '_sdkwork:runtime:device-edge',
    decisionRef: 'docs/architecture/decisions/ADR-001-device-edge.md',
  };
  spec.orchestration.profiles['standalone.development'].processes.push(edgeRuntime);
  assert.doesNotThrow(() => validateTopologySpec(spec, specPath));

  spec.orchestration.profiles['standalone.development'].processes.pop();
  spec.orchestration.profiles['cloud.development'].processes.push(edgeRuntime);
  assert.throws(
    () => validateTopologySpec(spec, specPath),
    /cloud\.development forbids local process role edge-runtime/u,
  );
});

test('rejects retired api-listener roles and ambiguous edge runtime declarations', () => {
  const { spec, specPath } = fixture();
  spec.orchestration.profiles['standalone.development'].processes.push({
    id: 'legacy-api',
    role: 'api-listener',
  });
  assert.throws(() => validateTopologySpec(spec, specPath), /requires a canonical role/u);

  spec.orchestration.profiles['standalone.development'].processes.pop();
  spec.orchestration.profiles['standalone.development'].processes.push({
    id: 'edge.device-ingress',
    role: 'edge-runtime',
    script: '_sdkwork:gateway:device-edge',
  });
  assert.throws(
    () => validateTopologySpec(spec, specPath),
    /requires an _sdkwork:runtime:\* script/u,
  );
});

test('rejects retired service layouts and allows independent remote surface origins', () => {
  const { root, spec, specPath } = fixture();
  spec.vocabulary.serviceLayout = { allowed: ['split-services'] };
  assert.throws(() => validateTopologySpec(spec, specPath), /retired/u);
  delete spec.vocabulary.serviceLayout;
  fs.writeFileSync(path.join(root, 'etc', 'topology', 'cloud.development.env'), [
    'SDKWORK_DEMO_PROFILE_ID=cloud.development',
    'APP_URL=https://app.dev.sdkwork.com',
    'PLATFORM_URL=https://api.dev.sdkwork.com',
    '',
  ].join('\n'));
  const runtime = createTopologyRuntime(spec, root, specPath);
  const plan = runtime.resolvePlan('cloud.development', 'browser');
  assert.equal(plan.resolvedBaseUrls['application.public-ingress'], 'https://app.dev.sdkwork.com');
  assert.equal(plan.resolvedBaseUrls['platform.api-gateway'], 'https://api.dev.sdkwork.com');
});

test('rejects platform gateway URLs from standalone profiles', () => {
  const { root, spec, specPath } = fixture();
  fs.writeFileSync(path.join(root, 'etc', 'topology', 'standalone.development.env'), [
    'SDKWORK_DEMO_PROFILE_ID=standalone.development',
    'APP_URL=http://127.0.0.1:8080',
    'PLATFORM_URL=http://127.0.0.1:3900',
    '',
  ].join('\n'));
  const runtime = createTopologyRuntime(spec, root, specPath);
  assert.throws(
    () => runtime.resolvePlan('standalone.development', 'server'),
    /standalone\.development forbids platform\.api-gateway URL key PLATFORM_URL/u,
  );
});

test('rejects topology-owned database prefixes', () => {
  const { spec, specPath } = fixture();
  spec.database = { appPrefix: 'SDKWORK_DEMO' };
  assert.throws(
    () => validateTopologySpec(spec, specPath),
    /database is retired; topology uses application envKeys and databases use SDKWORK_DATABASE_\*/u,
  );
});

test('bundled topology v5 schema stays aligned with the canonical standards schema', () => {
  const bundled = JSON.parse(fs.readFileSync(path.resolve('specs/topology.schema.v5.json'), 'utf8'));
  const canonical = JSON.parse(fs.readFileSync(path.resolve('../sdkwork-specs/schemas/sdkwork.app.topology.schema.v5.json'), 'utf8'));
  assert.deepEqual(bundled, canonical);
});

test('declares the archetype vocabulary in both schema copies', () => {
  const canonical = JSON.parse(fs.readFileSync(path.resolve('../sdkwork-specs/schemas/sdkwork.app.topology.schema.v5.json'), 'utf8'));
  assert.deepEqual(canonical.properties.archetype.enum, [...ARCHETYPES]);
  assert.ok(canonical.required.includes('archetype'));
  // The schema must tie required surfaces to the archetype exactly as the
  // validator does, so the contract and the implementation cannot drift.
  assert.equal(canonical.allOf.length, ARCHETYPES.length);
  for (const entry of canonical.allOf) {
    const archetype = entry.if.properties.archetype.const;
    assert.ok(ARCHETYPES.includes(archetype), `schema declares unregistered archetype ${archetype}`);
    assert.deepEqual(
      entry.then.properties.surfaces.required,
      [...REQUIRED_SURFACES_BY_ARCHETYPE[archetype]],
      `${archetype} required surfaces drifted between schema and validator`,
    );
  }
});

// APP_RUNTIME_TOPOLOGY_ARCHETYPES.md section 6 step 4: every registered archetype
// ships a reference example, and every example validates.
test('every registered archetype ships a validating reference example', () => {
  const examplesRoot = path.resolve('examples');
  const exampleRoots = fs.readdirSync(examplesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(examplesRoot, entry.name));
  const covered = new Set();
  for (const exampleRoot of exampleRoots) {
    const specPath = path.join(exampleRoot, 'topology.spec.json');
    assert.ok(fs.existsSync(specPath), `${path.basename(exampleRoot)} must ship topology.spec.json`);
    const spec = loadTopologySpec(specPath);
    covered.add(spec.archetype);
    for (const relative of Object.values(spec.profileFiles)) {
      assert.ok(relative.startsWith('examples/'), `${relative} must be rooted at examples/`);
      assert.ok(fs.existsSync(path.resolve(relative)), `${relative} must exist`);
    }
  }
  for (const archetype of ARCHETYPES) {
    assert.ok(covered.has(archetype), `archetype ${archetype} must ship a reference example`);
  }
});

// A reference example lives in a shared repository, so it must never carry a
// credential literal lifted from a live profile env file.
test('reference examples carry no credential literals', () => {
  const envRoot = path.join(path.resolve('examples'));
  const secretKey = /^[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|CREDENTIAL)[A-Z0-9_]*$/u;
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.env')) continue;
      for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
        const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
        if (!match || !secretKey.test(match[1])) continue;
        const value = match[2].trim();
        // An empty value, an explicit deploy-time placeholder, or an absolute
        // path to a mounted secret file carries no credential.
        if (value === '' || value.includes('DEPLOY_INJECT') || value.startsWith('/')) continue;
        offenders.push(`${path.relative(envRoot, full)}: ${match[1]}`);
      }
    }
  };
  walk(envRoot);
  assert.deepEqual(offenders, [], 'reference examples must not carry credential literals');
});

// A browser-only client root ships no owned HTTP ingress: its surfaces are the
// platform gateway it consumes, and its standalone plan starts no gateway process
// (APP_RUNTIME_TOPOLOGY_SPEC.md section 4).
function clientRootFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-topology-client-root-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'etc', 'topology'), { recursive: true });
  const spec = {
    schemaVersion: 5,
    kind: 'sdkwork.app.topology',
    appId: 'sdkwork-demo-client',
    applicationCode: 'demo-client',
    archetype: 'application-client-root',
    vocabulary: {
      deploymentProfile: { allowed: ['standalone', 'cloud'] },
      environment: { allowed: ['development', 'production'] },
    },
    profileFiles: {
      'standalone.development': 'etc/topology/standalone.development.env',
      'cloud.development': 'etc/topology/cloud.development.env',
    },
    envKeys: {
      deploymentProfile: 'SDKWORK_DEMO_CLIENT_DEPLOYMENT_PROFILE',
      environment: 'SDKWORK_DEMO_CLIENT_ENVIRONMENT',
      profileId: 'SDKWORK_DEMO_CLIENT_PROFILE_ID',
      apiGatewayBaseUrl: 'SDKWORK_DEMO_CLIENT_PLATFORM_API_GATEWAY_HTTP_URL',
    },
    surfaces: {
      'platform.api-gateway': {
        connectivityPlane: 'platform',
        protocols: ['http'],
        httpUrlEnv: 'SDKWORK_DEMO_CLIENT_PLATFORM_API_GATEWAY_HTTP_URL',
      },
    },
    orchestration: {
      profiles: {
        'standalone.development': { processes: [] },
        'cloud.development': { processes: [] },
      },
    },
  };
  const specPath = path.join(root, 'specs', 'topology.spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  return { root, spec, specPath };
}

test('accepts a client-root archetype that owns no application ingress', () => {
  const { spec, specPath } = clientRootFixture();
  assert.doesNotThrow(() => validateTopologySpec(spec, specPath));
});

test('accepts a standalone plan with no gateway process when there is no application HTTP API', () => {
  const { root, spec, specPath } = clientRootFixture();
  const runtime = createTopologyRuntime(spec, root, specPath);
  const plan = runtime.resolvePlan('standalone.development', 'browser');
  assert.equal(plan.localGateway, null);
});

test('requires the application ingress for an application-http-gateway archetype', () => {
  const { spec, specPath } = fixture();
  delete spec.surfaces['application.public-ingress'];
  assert.throws(
    () => validateTopologySpec(spec, specPath),
    /missing required surface for archetype application-http-gateway: application\.public-ingress/u,
  );
});

test('does not require the platform gateway for a standalone-only application-http-gateway', () => {
  const { spec, specPath } = fixture();
  delete spec.surfaces['platform.api-gateway'];
  spec.orchestration.profiles['cloud.development'].healthSurfaces = ['application.public-ingress'];
  assert.doesNotThrow(() => validateTopologySpec(spec, specPath));
});

test('rejects an archetype outside the declared vocabulary', () => {
  const { spec, specPath } = fixture();
  spec.archetype = 'application-client';
  assert.throws(
    () => validateTopologySpec(spec, specPath),
    /archetype must be one of: application-http-gateway/u,
  );
});

test('still requires exactly one standalone gateway when the application serves application HTTP APIs', () => {
  const { spec, specPath } = fixture();
  spec.orchestration.profiles['standalone.development'].processes =
    spec.orchestration.profiles['standalone.development'].processes
      .filter((process) => process.role !== 'api-standalone-gateway');
  assert.throws(
    () => validateTopologySpec(spec, specPath),
    /standalone\.development requires exactly one api-standalone-gateway/u,
  );
});

// APP_MANIFEST_SPEC.md permits a profile-limited surface manifest, so the topology
// vocabulary mirrors `runtime.supportedDeploymentProfiles` and may name one profile.
test('accepts a single-profile deployment vocabulary', () => {
  for (const allowed of [['standalone'], ['cloud']]) {
    const { spec, specPath } = clientRootFixture();
    spec.vocabulary.deploymentProfile.allowed = allowed;
    assert.doesNotThrow(() => validateTopologySpec(spec, specPath), `${allowed.join(',')} must validate`);
  }
});

test('rejects deployment vocabularies that are empty, unknown, duplicated, or out of order', () => {
  const cases = [
    [[], /non-empty subset of standalone, cloud/u],
    [['hosted'], /non-empty subset of standalone, cloud/u],
    [['standalone', 'standalone'], /non-empty subset of standalone, cloud/u],
    [['cloud', 'standalone'], /non-empty subset of standalone, cloud/u],
  ];
  for (const [allowed, expected] of cases) {
    const { spec, specPath } = clientRootFixture();
    spec.vocabulary.deploymentProfile.allowed = allowed;
    assert.throws(
      () => validateTopologySpec(spec, specPath),
      expected,
      `${JSON.stringify(allowed)} must be rejected`,
    );
  }
});
