import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyDevelopmentLocalGatewayBinding } from '../tools/topology/lib/dev-gateway-binding.mjs';
import { createTopologyRuntime, loadTopologySpec } from '../tools/topology/lib/index.mjs';

const LOCAL_GATEWAY = 'http://127.0.0.1:3900';

function cloudDevelopmentFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-cloud-dev-plan-'));
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
      'cloud.development': 'etc/topology/cloud.development.env',
    },
    envKeys: {
      deploymentProfile: 'SDKWORK_DEMO_DEPLOYMENT_PROFILE',
      environment: 'SDKWORK_DEMO_ENVIRONMENT',
      profileId: 'SDKWORK_DEMO_PROFILE_ID',
    },
    surfaces: {
      'application.public-ingress': {
        connectivityPlane: 'application',
        protocols: ['http'],
        httpUrlEnv: 'SDKWORK_DEMO_APPLICATION_PUBLIC_HTTP_URL',
      },
      'platform.api-gateway': {
        connectivityPlane: 'platform',
        protocols: ['http'],
        httpUrlEnv: 'SDKWORK_DEMO_PLATFORM_API_GATEWAY_HTTP_URL',
      },
    },
    orchestration: {
      profiles: {
        'cloud.development': {
          processes: [],
          healthSurfaces: ['application.public-ingress', 'platform.api-gateway'],
        },
      },
    },
  };
  fs.writeFileSync(path.join(root, 'specs', 'topology.spec.json'), JSON.stringify(spec));
  fs.writeFileSync(path.join(root, 'etc', 'topology', 'cloud.development.env'), [
    'SDKWORK_DEMO_PROFILE_ID=cloud.development',
    'SDKWORK_DEMO_APPLICATION_PUBLIC_HTTP_URL=https://demo-dev.sdkwork.com:3905',
    'SDKWORK_DEMO_PLATFORM_API_GATEWAY_HTTP_URL=https://api-dev.sdkwork.com',
    `SDKWORK_LOCAL_PLATFORM_API_GATEWAY_HTTP_URL=${LOCAL_GATEWAY}`,
    '',
  ].join('\n'));
  return { root, specPath: path.join(root, 'specs', 'topology.spec.json') };
}

test('cloud.development plan accepts surface URLs bound to the local gateway anchor', () => {
  const { root, specPath } = cloudDevelopmentFixture();
  try {
    const runtime = createTopologyRuntime(loadTopologySpec(specPath), root, specPath);
    const boundEnv = applyDevelopmentLocalGatewayBinding(
      runtime.loadProfile('cloud.development'),
      { profileId: 'cloud.development' },
    );
    const plan = runtime.resolvePlan('cloud.development', 'browser', null, { profileEnv: boundEnv });

    // PNPM_SCRIPT_SPEC §3 / APP_RUNTIME_TOPOLOGY_SPEC §4.2: the dev surface
    // binds to the locally started platform gateway instead of the deployed
    // domains, and health checks fail closed against that local process.
    assert.equal(plan.resolvedBaseUrls['application.public-ingress'], LOCAL_GATEWAY);
    assert.equal(plan.resolvedBaseUrls['platform.api-gateway'], LOCAL_GATEWAY);
    for (const check of plan.healthChecks) {
      assert.equal(check.url, LOCAL_GATEWAY);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a loopback surface URL without the local gateway anchor still fails the plan', () => {
  const { root, specPath } = cloudDevelopmentFixture();
  try {
    const runtime = createTopologyRuntime(loadTopologySpec(specPath), root, specPath);
    assert.throws(
      () => runtime.resolvePlan('cloud.development', 'browser', null, {
        profileEnv: {
          SDKWORK_DEMO_APPLICATION_PUBLIC_HTTP_URL: 'http://127.0.0.1:9999',
          SDKWORK_DEMO_PLATFORM_API_GATEWAY_HTTP_URL: 'https://api-dev.sdkwork.com',
        },
      }),
      /must use a deployed URL or explicit tunnel/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
