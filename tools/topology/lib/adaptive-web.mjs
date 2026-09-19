import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';

import { parseTcpBinding } from './development-ownership.mjs';
import { normalizeText } from './env-file.mjs';
import { spawnLifecycleCommand, waitForLifecycleCommand } from './lifecycle.mjs';

export const WEB_DEVICE_CLASSES = Object.freeze({
  DESKTOP: 'desktop',
  MOBILE: 'mobile',
});

const DEVICE_CLASS_PREFERRED_ARCHITECTURE = Object.freeze({
  [WEB_DEVICE_CLASSES.DESKTOP]: 'pc-web',
  [WEB_DEVICE_CLASSES.MOBILE]: 'h5',
});

// Shared mobile User-Agent contract from SDKWORK_DEPLOY_SPEC §8 (Adaptive Web).
const MOBILE_USER_AGENT_PATTERN = /(?:Mobile|Android|iPhone|iPod|webOS|BlackBerry|IEMobile|Opera Mini|MicroMessenger|HuaweiBrowser|HarmonyOS|UCBrowser|Quark)/iu;

// Canonical SDKWork API path prefixes that must reach the application ingress
// untouched instead of a browser renderer.
const CANONICAL_API_PATH_PATTERNS = Object.freeze([
  /^\/api(?:\/|$)/u,
  /^\/app\/v\d+\/api(?:\/|$)/u,
  /^\/backend\/v\d+\/api(?:\/|$)/u,
  /^\/im\/v\d+\/api(?:\/|$)/u,
  /^\/open\/v\d+\/api(?:\/|$)/u,
  /^\/(?:healthz|livez|metrics|openapi\.json|readyz)$/u,
]);

export const RENDERER_READY_TIMEOUT_MS = 120_000;

const DEFAULT_PROBE_USER_AGENTS = Object.freeze({
  'pc-web': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0',
  h5: 'Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 Chrome/136.0',
});

/**
 * Classify the requesting device for adaptive browser delivery.
 *
 * Detection order mirrors SDKWORK_DEPLOY_SPEC §8 (Adaptive Web):
 * 1. declarative overrides rules
 * 2. Sec-CH-UA-Mobile: ?1
 * 3. iPad carve-out (defaults to desktop unless the delivery maps tablets to h5)
 * 4. default mobile User-Agent regex
 * 5. default desktop
 */
export function detectWebDeviceClass({
  userAgent,
  secChUaMobile,
  overrides = [],
  tablet = 'pc-web',
} = {}) {
  for (const rule of overrides) {
    const pattern = normalizeText(rule?.pattern);
    if (pattern && new RegExp(pattern, 'iu').test(String(userAgent ?? ''))) {
      return rule.deviceClass === WEB_DEVICE_CLASSES.MOBILE
        ? WEB_DEVICE_CLASSES.MOBILE
        : WEB_DEVICE_CLASSES.DESKTOP;
    }
  }
  if (String(secChUaMobile ?? '').trim() === '?1') {
    return WEB_DEVICE_CLASSES.MOBILE;
  }
  const agent = String(userAgent ?? '');
  if (/ipad/iu.test(agent)) {
    return tablet === 'h5' ? WEB_DEVICE_CLASSES.MOBILE : WEB_DEVICE_CLASSES.DESKTOP;
  }
  return MOBILE_USER_AGENT_PATTERN.test(agent)
    ? WEB_DEVICE_CLASSES.MOBILE
    : WEB_DEVICE_CLASSES.DESKTOP;
}

export function preferredWebArchitecture(deviceClass) {
  return DEVICE_CLASS_PREFERRED_ARCHITECTURE[deviceClass] ?? 'pc-web';
}

/**
 * Preferred-first fallback order restricted to the delivery's declared
 * client architectures: mobile prefers h5, desktop prefers pc-web.
 */
export function webClientFallbackOrder(deviceClass, clientArchitectures = []) {
  const declared = clientArchitectures.length > 0
    ? clientArchitectures
    : [preferredWebArchitecture(deviceClass)];
  const preferred = preferredWebArchitecture(deviceClass);
  if (!declared.includes(preferred)) {
    return [...declared];
  }
  return [preferred, ...declared.filter((architecture) => architecture !== preferred)];
}

export function resolveAvailableWebClient({
  deviceClass,
  availableClients = [],
  clientArchitectures,
} = {}) {
  const available = new Set(availableClients);
  return webClientFallbackOrder(deviceClass, clientArchitectures)
    .find((architecture) => available.has(architecture));
}

export function matchCanonicalApiPath(requestUrl) {
  const pathname = String(requestUrl ?? '').split(/[?#]/u, 1)[0] || '/';
  return CANONICAL_API_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

export function webSocketUrlFromHttpUrl(url) {
  const websocketUrl = new URL(url);
  websocketUrl.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return websocketUrl;
}

function proxyHeaders(request, target) {
  return {
    ...request.headers,
    host: target.host,
    'x-forwarded-host': request.headers.host ?? '',
    'x-forwarded-proto': request.socket.encrypted ? 'https' : 'http',
  };
}

function appendUserAgentVary(headers) {
  const vary = String(headers.vary ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!vary.some((value) => value.toLowerCase() === 'user-agent')) {
    vary.push('user-agent');
  }
  return {
    ...headers,
    vary: vary.join(', '),
  };
}

function proxyHttp(request, response, target, onError, { varyUserAgent = false } = {}) {
  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request({
    headers: proxyHeaders(request, target),
    hostname: target.hostname,
    method: request.method,
    path: request.url,
    port: target.port || undefined,
    protocol: target.protocol,
  }, (upstreamResponse) => {
    const headers = varyUserAgent
      ? appendUserAgentVary(upstreamResponse.headers)
      : upstreamResponse.headers;
    response.writeHead(upstreamResponse.statusCode ?? 502, headers);
    upstreamResponse.pipe(response);
    upstreamResponse.once('error', (error) => {
      response.destroy();
      onError(error);
    });
  });
  upstream.once('error', (error) => onError(error));
  request.once('error', () => upstream.destroy());
  if (request.readableEnded || request.complete) {
    upstream.end();
  } else {
    request.pipe(upstream);
  }
}

function writeProxyFailure(response, message) {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  response.writeHead(502, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(message);
}

function viteDependencyCachePath(requestUrl) {
  try {
    const pathname = new URL(requestUrl ?? '/', 'http://sdkwork.local').pathname;
    return pathname.startsWith('/node_modules/.vite/') ? pathname : undefined;
  } catch {
    return undefined;
  }
}

function rendererOwningViteCache(viteCachePath, renderers) {
  if (!viteCachePath) {
    return undefined;
  }
  for (const renderer of renderers.values()) {
    if (viteCachePath.startsWith(`/node_modules/.vite/${renderer.label}/`)) {
      return renderer;
    }
  }
  return undefined;
}

function writeStaleViteDependencyResponse(response, deliveryLabel, architecture) {
  response.writeHead(410, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    vary: 'user-agent',
  });
  response.end(
    `${deliveryLabel} ${architecture} Vite dependency cache URL is stale; reload the browser page.`,
  );
}

function availableRendererClients(renderers) {
  return [...renderers.values()]
    .filter((renderer) => renderer.ready)
    .map((renderer) => renderer.architecture);
}

function proxyRendererRequest(request, response, renderers, options) {
  const { deliveryLabel, deviceOverrides, tablet } = options;
  const deviceClass = detectWebDeviceClass({
    userAgent: request.headers['user-agent'],
    secChUaMobile: request.headers['sec-ch-ua-mobile'],
    overrides: deviceOverrides,
    tablet,
  });
  const preferred = resolveAvailableWebClient({
    deviceClass,
    availableClients: availableRendererClients(renderers),
    clientArchitectures: [...renderers.keys()],
  });
  const viteCachePath = viteDependencyCachePath(request.url);
  const cacheOwnerRenderer = viteCachePath
    ? rendererOwningViteCache(viteCachePath, renderers)
    : undefined;
  if (viteCachePath && !cacheOwnerRenderer) {
    // A Vite cache URL that no renderer owns (unknown/stale cache label):
    // the browser holds a module graph from a renderer that no longer
    // matches, so require a reload instead of serving another renderer's
    // cache prefix.
    writeStaleViteDependencyResponse(response, deliveryLabel, preferred);
    return;
  }
  if (!preferred) {
    writeProxyFailure(response, `No ${deliveryLabel} browser renderer is available.`);
    return;
  }
  const preferredRenderer = renderers.get(preferred);
  // A Vite dependency cache URL belongs to the renderer whose cache label it
  // carries. Route it there regardless of device class: the browser module
  // graph may legitimately reference another renderer's cache (e.g. after a
  // renderer restart or while the device-preferred renderer is unavailable),
  // and hard-failing with 410 would leave the loaded page broken until a
  // manual reload.
  const targetRenderer = cacheOwnerRenderer ?? preferredRenderer;
  // Cross-renderer fallback only applies to ordinary page requests; a cache
  // URL must never be served by a renderer that does not own that cache.
  const fallback = !cacheOwnerRenderer
    ? [...webClientFallbackOrder(deviceClass, [...renderers.keys()])]
      .find((architecture) => architecture !== preferred
        && renderers.get(architecture)?.ready)
    : undefined;
  const proxyOptions = { varyUserAgent: true };
  proxyHttp(request, response, targetRenderer.target, (firstError) => {
    const fallbackRenderer = fallback ? renderers.get(fallback) : undefined;
    if (!fallbackRenderer?.ready || !['GET', 'HEAD'].includes(request.method ?? 'GET')) {
      writeProxyFailure(
        response,
        `${deliveryLabel} ${targetRenderer.architecture} renderer is unavailable: ${firstError.message}`,
      );
      return;
    }
    proxyHttp(request, response, fallbackRenderer.target, (fallbackError) => {
      writeProxyFailure(
        response,
        `${deliveryLabel} browser renderers are unavailable: ${firstError.message}; ${fallbackError.message}`,
      );
    }, proxyOptions);
  }, proxyOptions);
}

function serializeUpgradeRequest(request, target) {
  const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
  const headers = proxyHeaders(request, target);
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        lines.push(`${name}: ${item}`);
      }
    } else if (value !== undefined) {
      lines.push(`${name}: ${value}`);
    }
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function openUpgradeTunnel(request, socket, head, target, onError) {
  let connected = false;
  const port = Number.parseInt(target.port || (target.protocol === 'https:' ? '443' : '80'), 10);
  const upstream = target.protocol === 'https:'
    ? tls.connect({ host: target.hostname, port, servername: target.hostname })
    : net.connect({ host: target.hostname, port });
  socket.once('error', () => upstream.destroy());
  upstream.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
    connected = true;
    upstream.write(serializeUpgradeRequest(request, target));
    if (head.length > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream).pipe(socket);
  });
  upstream.once('error', (error) => {
    upstream.destroy();
    onError(error, connected);
  });
}

function proxyUpgrade(request, socket, head, target, fallbackTarget) {
  openUpgradeTunnel(request, socket, head, target, (firstError, connected) => {
    if (connected || !fallbackTarget) {
      socket.destroy(firstError);
      return;
    }
    openUpgradeTunnel(request, socket, head, fallbackTarget, (fallbackError) => {
      socket.destroy(fallbackError);
    });
  });
}

/**
 * One same-origin ingress that selects the browser renderer by device class,
 * keeps canonical API paths on the application ingress, and falls back to the
 * other renderer when the preferred one is unavailable.
 */
export function createAdaptiveWebServer({
  apiTarget,
  renderers,
  apiPathMatcher = matchCanonicalApiPath,
  deviceOverrides = [],
  tablet = 'pc-web',
  deliveryLabel = 'adaptive web',
}) {
  const server = http.createServer((request, response) => {
    if (apiPathMatcher(request.url)) {
      proxyHttp(request, response, apiTarget, (error) => {
        writeProxyFailure(
          response,
          `${deliveryLabel} application ingress is unavailable: ${error.message}`,
        );
      });
      return;
    }
    proxyRendererRequest(request, response, renderers, {
      deliveryLabel,
      deviceOverrides,
      tablet,
    });
  });
  server.on('upgrade', (request, socket, head) => {
    if (apiPathMatcher(request.url)) {
      proxyUpgrade(request, socket, head, apiTarget);
      return;
    }
    const deviceClass = detectWebDeviceClass({
      userAgent: request.headers['user-agent'],
      secChUaMobile: request.headers['sec-ch-ua-mobile'],
      overrides: deviceOverrides,
      tablet,
    });
    const preferred = resolveAvailableWebClient({
      deviceClass,
      availableClients: availableRendererClients(renderers),
      clientArchitectures: [...renderers.keys()],
    });
    const target = preferred ? renderers.get(preferred)?.target : undefined;
    const fallback = preferred
      ? [...webClientFallbackOrder(deviceClass, [...renderers.keys()])]
        .find((architecture) => architecture !== preferred
          && renderers.get(architecture)?.ready)
      : undefined;
    const fallbackTarget = fallback ? renderers.get(fallback).target : undefined;
    if (!target) {
      socket.destroy();
      return;
    }
    proxyUpgrade(request, socket, head, target, fallbackTarget);
  });
  return server;
}

function rendererSourceExists(applicationRoot) {
  try {
    return fs.statSync(path.join(applicationRoot, 'package.json')).isFile();
  } catch {
    return false;
  }
}

/**
 * Forward a renderer output stream line by line under an explicit tag.
 *
 * Renderer listeners are private client tooling (APP_RUNTIME_TOPOLOGY_SPEC
 * §8.2): tagging their output keeps the console's only untagged browser entry
 * on the adaptive ingress origin instead of surfacing the internal Vite
 * renderer ports as if they were second access URLs.
 */
function forwardTaggedRendererStream(stream, tag, write) {
  if (!stream) return;
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    let newlineIndex = buffered.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffered.slice(0, newlineIndex).replace(/\r$/u, '');
      buffered = buffered.slice(newlineIndex + 1);
      if (line) write(`[${tag}] ${line}\n`);
      newlineIndex = buffered.indexOf('\n');
    }
  });
  stream.once('end', () => {
    const trailing = buffered.trim();
    if (trailing) write(`[${tag}] ${trailing}\n`);
  });
  stream.once('error', () => {});
}

function substituteInvocationArgs(args, { host, port }) {
  return (args ?? []).map((value) => String(value)
    .replaceAll('{port}', String(port))
    .replaceAll('{host}', host));
}

function buildRendererEnvironment({ env, renderer, delivery, runtime }) {
  const surface = runtime.spec.surfaces?.[delivery.apiSurfaceId];
  const httpOrigin = String(delivery.browserVisibleOrigin ?? '').replace(/\/$/u, '');
  const websocketOrigin = httpOrigin
    ? webSocketUrlFromHttpUrl(httpOrigin).toString().replace(/\/$/u, '')
    : '';
  const substitute = (value) => String(value)
    .replaceAll('{httpOrigin}', httpOrigin)
    .replaceAll('{wsOrigin}', websocketOrigin);
  const rendererEnv = {
    ...env,
    ...Object.fromEntries(
      Object.entries(renderer.env ?? {}).map(([key, value]) => [key, substitute(value)]),
    ),
  };
  if (renderer.hostEnv) {
    rendererEnv[renderer.hostEnv] = renderer.host;
  }
  if (renderer.portEnv) {
    rendererEnv[renderer.portEnv] = String(renderer.port);
  }
  if (httpOrigin && surface?.clientHttpEnv) {
    rendererEnv[surface.clientHttpEnv] = httpOrigin;
  }
  if (httpOrigin && surface?.clientWebsocketEnv) {
    rendererEnv[surface.clientWebsocketEnv] = websocketOrigin;
  }
  return rendererEnv;
}

export function spawnWebRenderer({ runtime, delivery, renderer, env, report = {
  stdout: () => {},
  stderr: () => {},
} }) {
  const applicationRoot = path.resolve(runtime.repoRoot, renderer.applicationRoot);
  if (!rendererSourceExists(applicationRoot)) {
    return undefined;
  }
  const args = substituteInvocationArgs(renderer.invocation.args, {
    host: renderer.host,
    port: renderer.port,
  });
  const child = spawnLifecycleCommand(renderer.invocation.command, args, {
    cwd: applicationRoot,
    env: buildRendererEnvironment({ env, renderer, delivery, runtime }),
    processId: `${delivery.id}:${renderer.architecture}`,
    processRole: 'web-renderer',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const outputTag = `renderer ${renderer.architecture}`;
  forwardTaggedRendererStream(child.stdout, outputTag, (line) => report.stdout(line));
  forwardTaggedRendererStream(child.stderr, outputTag, (line) => report.stderr(line));
  return {
    architecture: renderer.architecture,
    label: renderer.label,
    child,
    ready: false,
    target: new URL(`http://${renderer.host}:${renderer.port}`),
    userAgent: renderer.userAgent,
  };
}

export function waitForWebRenderer(renderer, report, timeoutMs = RENDERER_READY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const finish = (ready) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(timer);
      renderer.ready = ready;
      resolve(ready);
    };
    const probe = () => {
      const request = http.get(renderer.target, {
        headers: { 'user-agent': renderer.userAgent },
      }, (response) => {
        response.resume();
        finish((response.statusCode ?? 500) < 500);
      });
      request.setTimeout(1_000, () => request.destroy());
      request.once('error', () => {
        if (Date.now() - startedAt >= timeoutMs) {
          finish(false);
        }
      });
    };
    const timer = setInterval(probe, 500);
    renderer.child.once('exit', (code, signal) => {
      finish(false);
      renderer.ready = false;
      report.stderr(
        `${renderer.label} stopped (${signal ?? code ?? 'unknown'}); fallback remains active`,
      );
    });
    probe();
  });
}

/**
 * Spawn every declared renderer, wait for readiness, and start the adaptive
 * same-origin ingress for one dev-server-proxy browser delivery.
 */
export async function startAdaptiveWebDelivery({
  runtime,
  plan,
  delivery,
  env,
  report = {
    stdout: (message) => process.stdout.write(`[sdkwork-app] ${message}\n`),
    stderr: (message) => process.stderr.write(`[sdkwork-app] ${message}\n`),
  },
}) {
  const clientProcess = (plan.localProcesses ?? [])
    .find((process) => process.id === delivery.clientProcessId);
  if (!clientProcess?.bindEnv) {
    throw new Error(`adaptive browser delivery ${delivery.id} requires a client process with bindEnv`);
  }
  const bind = parseTcpBinding(env[clientProcess.bindEnv], clientProcess.bindEnv);
  const renderers = new Map();
  for (const renderer of delivery.renderers) {
    const spawned = spawnWebRenderer({ runtime, delivery, renderer, env, report });
    if (!spawned) {
      report.stderr(
        `${renderer.applicationRoot} source is unavailable; using the other renderer`,
      );
      continue;
    }
    renderers.set(spawned.architecture, spawned);
  }
  if (renderers.size === 0) {
    throw new Error(`adaptive browser delivery ${delivery.id} has no available renderers`);
  }

  await Promise.all([...renderers.values()].map(async (renderer) => {
    const ready = await waitForWebRenderer(renderer, report);
    if (!ready) {
      report.stderr(`${renderer.label} did not become ready; using the other renderer`);
    }
  }));

  if (availableRendererClients(renderers).length === 0) {
    throw new Error(`adaptive browser delivery ${delivery.id} has no ready renderers`);
  }

  const server = createAdaptiveWebServer({
    apiTarget: new URL(delivery.apiTargetOrigin),
    renderers,
    deviceOverrides: delivery.deviceOverrides ?? [],
    tablet: delivery.tabletArchitecture ?? 'pc-web',
    deliveryLabel: delivery.id,
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(bind.port, bind.host, resolve);
    });
  } catch (error) {
    server.close();
    for (const renderer of renderers.values()) {
      if (renderer.child?.pid && renderer.child.exitCode === null) {
        renderer.child.kill('SIGTERM');
      }
    }
    throw error;
  }
  report.stdout(
    `adaptive browser delivery ${delivery.id} ready at ${delivery.browserVisibleOrigin}`,
  );
  return {
    server,
    bind,
    delivery,
    renderers,
    close: () => {
      server.close();
      for (const renderer of renderers.values()) {
        if (renderer.child?.pid && renderer.child.exitCode === null) {
          renderer.child.kill('SIGTERM');
        }
      }
    },
  };
}
