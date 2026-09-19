import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyDevelopmentLocalGatewayBinding,
  LOCAL_PLATFORM_API_GATEWAY_HTTP_URL_KEY,
} from '../tools/topology/lib/dev-gateway-binding.mjs';

const LOCAL_GATEWAY = 'http://127.0.0.1:3900';

test('cloud.development binds platform gateway and gateway-attached origins to the local gateway', () => {
  const env = applyDevelopmentLocalGatewayBinding(
    {
      [LOCAL_PLATFORM_API_GATEWAY_HTTP_URL_KEY]: LOCAL_GATEWAY,
      SDKWORK_IM_PLATFORM_API_GATEWAY_HTTP_URL: 'https://api-dev.sdkwork.com',
      VITE_SDKWORK_IM_PLATFORM_API_GATEWAY_HTTP_URL: 'https://api-dev.sdkwork.com',
      VITE_SDKWORK_IM_H5_FEEDS_OPEN_API_BASE_URL: 'https://api-dev.sdkwork.com',
      SDKWORK_BACKEND_BASE_URL: 'https://api-dev.sdkwork.com/backend/v3/api',
      VITE_SDKWORK_AGENTS_APP_API_BASE_URL: 'https://agents-dev.sdkwork.com',
      VITE_SDKWORK_VOICE_APP_API_BASE_URL: 'https://voice-dev.sdkwork.com',
      SDKWORK_IM_APPLICATION_PUBLIC_HTTP_URL: 'http://im-dev.sdkwork.com:3801',
      VITE_SDKWORK_IM_APPLICATION_PUBLIC_HTTP_URL: 'http://im-dev.sdkwork.com:3801',
      SDKWORK_IM_APPLICATION_OPEN_HTTP_URL: 'http://im-open-dev.sdkwork.com:3802',
      SDKWORK_IM_APPLICATION_BACKEND_HTTP_URL: 'http://im-admin-dev.sdkwork.com:3803',
      SDKWORK_IM_DEPLOYMENT_PROFILE: 'cloud',
    },
    { profileId: 'cloud.development' },
  );

  assert.equal(env.SDKWORK_IM_PLATFORM_API_GATEWAY_HTTP_URL, LOCAL_GATEWAY);
  assert.equal(env.VITE_SDKWORK_IM_PLATFORM_API_GATEWAY_HTTP_URL, LOCAL_GATEWAY);
  assert.equal(env.VITE_SDKWORK_IM_H5_FEEDS_OPEN_API_BASE_URL, LOCAL_GATEWAY);
  // Gateway-anchored path is preserved, only the origin is swapped.
  assert.equal(env.SDKWORK_BACKEND_BASE_URL, `${LOCAL_GATEWAY}/backend/v3/api`);
  // Non-gateway origins (separate services, own application edges) stay remote.
  assert.equal(env.VITE_SDKWORK_AGENTS_APP_API_BASE_URL, 'https://agents-dev.sdkwork.com');
  assert.equal(env.VITE_SDKWORK_VOICE_APP_API_BASE_URL, 'https://voice-dev.sdkwork.com');
  // Application-plane surface URLs are gateway-attached in a cloud profile
  // (the platform gateway terminates the application plane), so the dev
  // surface binds them to the local gateway too (PNPM_SCRIPT_SPEC §3).
  assert.equal(env.SDKWORK_IM_APPLICATION_PUBLIC_HTTP_URL, LOCAL_GATEWAY);
  assert.equal(env.VITE_SDKWORK_IM_APPLICATION_PUBLIC_HTTP_URL, LOCAL_GATEWAY);
  assert.equal(env.SDKWORK_IM_APPLICATION_OPEN_HTTP_URL, LOCAL_GATEWAY);
  assert.equal(env.SDKWORK_IM_APPLICATION_BACKEND_HTTP_URL, LOCAL_GATEWAY);
  // Multi-token application codes (sdkwork-cloudrouter style) match too.
  assert.equal(
    applyDevelopmentLocalGatewayBinding(
      {
        [LOCAL_PLATFORM_API_GATEWAY_HTTP_URL_KEY]: LOCAL_GATEWAY,
        SDKWORK_CLOUDROUTER_PLATFORM_API_GATEWAY_HTTP_URL: 'https://api-dev.sdkwork.com',
        SDKWORK_CLOUDROUTER_ROUTER_APPLICATION_PUBLIC_HTTP_URL: 'http://router-dev.sdkwork.com:3905',
        VITE_SDKWORK_CLOUDROUTER_ROUTER_APPLICATION_OPEN_HTTP_URL: 'http://router-dev.sdkwork.com:3905',
      },
      { profileId: 'cloud.development' },
    ).SDKWORK_CLOUDROUTER_ROUTER_APPLICATION_PUBLIC_HTTP_URL,
    LOCAL_GATEWAY,
  );
});

test('only cloud.development profiles are rewritten', () => {
  const sourceEnv = {
    [LOCAL_PLATFORM_API_GATEWAY_HTTP_URL_KEY]: LOCAL_GATEWAY,
    SDKWORK_IM_PLATFORM_API_GATEWAY_HTTP_URL: 'https://api-dev.sdkwork.com',
  };
  for (const profileId of ['cloud.production', 'cloud.test', 'standalone.development', 'cloud.staging.development']) {
    const env = applyDevelopmentLocalGatewayBinding(sourceEnv, { profileId });
    if (profileId === 'cloud.staging.development') {
      // Three-segment profile id: environment is the last segment.
      assert.equal(env.SDKWORK_IM_PLATFORM_API_GATEWAY_HTTP_URL, LOCAL_GATEWAY);
      continue;
    }
    assert.equal(env.SDKWORK_IM_PLATFORM_API_GATEWAY_HTTP_URL, 'https://api-dev.sdkwork.com', profileId);
  }
});

test('profiles without the local gateway override key keep their deployed values', () => {
  const env = applyDevelopmentLocalGatewayBinding(
    { SDKWORK_IM_PLATFORM_API_GATEWAY_HTTP_URL: 'https://api-dev.sdkwork.com' },
    { profileId: 'cloud.development' },
  );
  assert.equal(env.SDKWORK_IM_PLATFORM_API_GATEWAY_HTTP_URL, 'https://api-dev.sdkwork.com');
});

test('websocket and already-local values are handled safely', () => {
  const env = applyDevelopmentLocalGatewayBinding(
    {
      [LOCAL_PLATFORM_API_GATEWAY_HTTP_URL_KEY]: LOCAL_GATEWAY,
      SDKWORK_IM_PLATFORM_API_GATEWAY_HTTP_URL: 'https://api-dev.sdkwork.com',
      VITE_SDKWORK_IM_WEBSOCKET_URL: 'wss://api-dev.sdkwork.com/ws',
      VITE_SDKWORK_ALREADY_LOCAL_URL: 'http://127.0.0.1:3900/api',
    },
    { profileId: 'cloud.development' },
  );
  // Local dev gateway is plain http, so secure remote websocket entries map to ws://.
  assert.equal(env.VITE_SDKWORK_IM_WEBSOCKET_URL, 'ws://127.0.0.1:3900/ws');
  assert.equal(env.VITE_SDKWORK_ALREADY_LOCAL_URL, 'http://127.0.0.1:3900/api');
});

test('invalid or missing profile ids are passed through untouched', () => {
  const sourceEnv = { SDKWORK_IM_PLATFORM_API_GATEWAY_HTTP_URL: 'https://api-dev.sdkwork.com' };
  assert.deepEqual(
    applyDevelopmentLocalGatewayBinding(sourceEnv, { profileId: 'not-a-profile' }),
    sourceEnv,
  );
  assert.deepEqual(applyDevelopmentLocalGatewayBinding(sourceEnv), sourceEnv);
});
