import { parseProfileId } from './profile-id.mjs';

/**
 * Development-time local platform gateway binding (PNPM_SCRIPT_SPEC §3,
 * ENVIRONMENT_SPEC §5.1.0.1).
 *
 * `pnpm dev:cloud` must reach the sdkwork-api-cloud-gateway through the local
 * dev bind (ip:port, default http://127.0.0.1:3900) instead of the deployed
 * cloud edge domains (api-dev.<base-domain> and friends). Domain edges stay
 * authoritative for cloud-mode builds and deployed services; only the
 * development runtime surface is rewritten here.
 *
 * A profile opts in by declaring SDKWORK_LOCAL_PLATFORM_API_GATEWAY_HTTP_URL
 * (typically inside etc/topology/cloud.development.env). When present, every
 * gateway-anchored HTTP(S)/WS(S) URL in the merged profile env is rebound to
 * the local gateway origin:
 *
 * - keys ending in PLATFORM_API_GATEWAY_HTTP_URL (SDKWORK_ and VITE_ forms);
 * - the application-plane surface URL keys declared by the topology spec
 *   (`..._APPLICATION_(PUBLIC|OPEN|BACKEND)_HTTP_URL`, SDKWORK_ and VITE_
 *   forms): in a cloud profile the application plane is terminated by the
 *   platform gateway (APP_RUNTIME_TOPOLOGY_SPEC §3), so its dev-surface URLs
 *   are gateway-attached by construction;
 * - any other URL entry whose host equals the deployed platform gateway host
 *   (SDK base URLs, open API base URLs, backend base URLs that are
 *   gateway-anchored by construction; host comparison is scheme-insensitive so
 *   ws(s):// entries on the same edge host match too). Non-gateway hosts
 *   (agents, voice, drive application edges, ...) keep their remote values.
 *
 * URL paths and query strings are preserved; only the scheme+host is swapped.
 */
export const LOCAL_PLATFORM_API_GATEWAY_HTTP_URL_KEY = 'SDKWORK_LOCAL_PLATFORM_API_GATEWAY_HTTP_URL';
export const BROWSER_LOCAL_PLATFORM_API_GATEWAY_HTTP_URL_KEY =
  'VITE_SDKWORK_LOCAL_PLATFORM_API_GATEWAY_HTTP_URL';

const PLATFORM_API_GATEWAY_URL_KEY_PATTERN = /(?:^|_)PLATFORM_API_GATEWAY_HTTP_URL$/u;
const APPLICATION_SURFACE_URL_KEY_PATTERN =
  /(?:^|VITE_)SDKWORK_[A-Z0-9_]+_APPLICATION_(?:PUBLIC|OPEN|BACKEND)_HTTP_URL$/u;
const REWRITABLE_URL_VALUE_PATTERN = /^(?:https?|wss?):\/\//iu;

function parseUrlHost(value) {
  try {
    return new URL(String(value ?? '').trim()).host;
  } catch {
    return '';
  }
}

export function applyDevelopmentLocalGatewayBinding(env, { profileId } = {}) {
  const values = { ...env };
  if (!profileId) {
    return values;
  }
  let parsedProfileId;
  try {
    parsedProfileId = parseProfileId(profileId);
  } catch {
    return values;
  }
  if (parsedProfileId.deploymentProfile !== 'cloud' || parsedProfileId.environment !== 'development') {
    return values;
  }
  const localGatewayUrl = String(values[LOCAL_PLATFORM_API_GATEWAY_HTTP_URL_KEY] ?? '').trim();
  if (!REWRITABLE_URL_VALUE_PATTERN.test(localGatewayUrl)) {
    return values;
  }
  const localHost = parseUrlHost(localGatewayUrl);
  if (!localHost) {
    return values;
  }

  // Resolve the deployed platform gateway host from the profile env itself:
  // the first PLATFORM_API_GATEWAY_HTTP_URL entry whose host is not already
  // the local bind anchors "gateway-attached" detection for every other key.
  // Host comparison (hostname:port, scheme-insensitive) also matches ws(s)://
  // entries that share the deployed gateway edge host.
  let gatewayHost = '';
  for (const [key, rawValue] of Object.entries(values)) {
    if (!PLATFORM_API_GATEWAY_URL_KEY_PATTERN.test(key)) {
      continue;
    }
    const host = parseUrlHost(rawValue);
    if (host && host !== localHost) {
      gatewayHost = host;
      break;
    }
  }
  if (!gatewayHost) {
    return values;
  }

  // Browser-visible anchor (APP_RUNTIME_TOPOLOGY_SPEC §4.2, SDK_SPEC §5.1
  // step 2): Vite exposes VITE_-prefixed process env to import.meta.env, so
  // frontend SDK integrations can read the local gateway before falling back
  // to any checked-in environment domain.
  values[BROWSER_LOCAL_PLATFORM_API_GATEWAY_HTTP_URL_KEY] = localGatewayUrl;

  for (const [key, rawValue] of Object.entries(values)) {
    const value = String(rawValue ?? '').trim();
    if (!REWRITABLE_URL_VALUE_PATTERN.test(value)) {
      continue;
    }
    const host = parseUrlHost(value);
    if (!host || host === localHost) {
      continue;
    }
    const isGatewayKey = PLATFORM_API_GATEWAY_URL_KEY_PATTERN.test(key);
    const isApplicationSurfaceKey = APPLICATION_SURFACE_URL_KEY_PATTERN.test(key);
    if (!isGatewayKey && !isApplicationSurfaceKey && host !== gatewayHost) {
      continue;
    }
    const parsedUrl = new URL(value);
    const localBase = localGatewayUrl.replace(/\/+$/u, '');
    const rewritten = /^wss?:\/\//iu.test(value)
      ? `${localGatewayUrl.startsWith('https') ? 'wss' : 'ws'}://${localHost}${parsedUrl.pathname === '/' ? '' : parsedUrl.pathname}${parsedUrl.search}`
      : `${localBase}${parsedUrl.pathname === '/' ? '' : parsedUrl.pathname}${parsedUrl.search}`;
    values[key] = rewritten;
  }
  return values;
}
