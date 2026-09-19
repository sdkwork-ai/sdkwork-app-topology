#!/usr/bin/env node

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  canonicalRepositoryRoot,
  createTopologyRuntime,
  formatAccessEndpointCatalogLines,
  formatPrimaryAccessLines,
  formatResolvedNetworkAccessLines,
  applyDevelopmentLocalGatewayBinding,
  loadTopologySpec,
  reconcileManagedResources,
  removeRuntimeStateFile,
  resolveAccessEndpointReports,
  resolveRepositoryRuntimeStateDirectory,
  resolveTopologyLocation,
  resolveOwnedBindings,
  stopOwnedBindings,
  waitForHttpHealthy,
  writePrivateJsonAtomically,
} from '../tools/topology/lib/index.mjs';
import {
  loadPackageManifest,
  privateLifecycleScript,
  formatLifecycleError,
  resolveProcessInvocation,
  runPrivateLifecycleScript,
  spawnLifecycleCommand,
  waitForLifecycleCommand,
  validateLifecyclePackage,
} from '../tools/topology/lib/lifecycle.mjs';
import { startAdaptiveWebDelivery } from '../tools/topology/lib/adaptive-web.mjs';

const FRAMEWORK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_ROOT = path.resolve(FRAMEWORK_ROOT, '..');
const DEFAULT_WORKFLOW_CLI = path.join(WORKSPACE_ROOT, 'sdkwork-github-workflow', 'scripts', 'sdkwork-workflow.mjs');
const DEFAULT_DEPLOY_CLI = path.join(WORKSPACE_ROOT, 'sdkwork-specs', 'tools', 'deployctl.mjs');
const DEFAULT_APP_MANIFEST_CHECK_CLI = path.join(WORKSPACE_ROOT, 'sdkwork-specs', 'tools', 'check-app-manifest-standard.mjs');
const DEFAULT_SOURCE_CONFIG_CHECK_CLI = path.join(WORKSPACE_ROOT, 'sdkwork-specs', 'tools', 'check-source-config-standard.mjs');
const DEFAULT_ADAPTIVE_WEB_CHECK_CLI = path.join(WORKSPACE_ROOT, 'sdkwork-specs', 'tools', 'check-adaptive-web-standard.mjs');
const DEVELOPMENT_SESSION_HEARTBEAT_MS = 2000;
const DEVELOPMENT_SESSION_STALE_MS = 15000;

/**
 * Region deployment dimension (REGION_SPEC.md). The region is orthogonal to
 * the deployment profile and environment: it is injected through
 * `SDKWORK_<APPLICATION_CODE>_REGION_CODE` (private process variable) and
 * never becomes a profile-id segment. The default seed locale resolves from
 * the application region registry when present, otherwise zh-CN.
 */
function resolveRegionEnv(repoRoot, runtime, args, env = process.env) {
  const applicationCode = String(
    runtime.spec?.applicationCode ?? runtime.spec?.appId ?? 'APP',
  ).toUpperCase();
  const regionCode = option(args, '--region')
    ?? env[`SDKWORK_${applicationCode}_REGION_CODE`]
    ?? 'global';
  const seedLocale = env.SDKWORK_DATABASE_SEED_LOCALE
    ?? resolveRegionDefaultLocale(repoRoot, regionCode);
  return {
    [`SDKWORK_${applicationCode}_REGION_CODE`]: regionCode,
    SDKWORK_DATABASE_SEED_LOCALE: seedLocale,
  };
}

function resolveRegionDefaultLocale(repoRoot, regionCode) {
  try {
    const registry = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'etc', 'region.registry.json'), 'utf8'),
    );
    const region = (registry.regions ?? []).find((item) => item.regionCode === regionCode);
    if (region?.defaultLocale) return region.defaultLocale;
  } catch {
    // no region registry in this application; fall back to zh-CN
  }
  return 'zh-CN';
}

function option(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function frameworkCliPath(environmentKey, fallback) {
  return path.resolve(process.env[environmentKey] ?? fallback);
}

function passthroughArgs(args, excluded) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (excluded.has(args[index])) {
      index += 1;
      continue;
    }
    out.push(args[index]);
  }
  return out;
}

async function runCommand(command, args, cwd, env = process.env) {
  const result = await waitForLifecycleCommand(spawnLifecycleCommand(command, args, { cwd, env }));
  if (result.code !== 0) throw new Error(`${command} exited with code ${result.code}`);
}

function developmentSessionPath(repoRoot) {
  return path.join(resolveRepositoryRuntimeStateDirectory({
    repoRoot,
    owner: 'sdkwork-app',
  }), 'development-session.json');
}

function writeDevelopmentSession(repoRoot, session) {
  const sessionPath = developmentSessionPath(repoRoot);
  writePrivateJsonAtomically(sessionPath, {
    ...session,
    heartbeatAt: session.heartbeatAt ?? new Date().toISOString(),
  });
}

function removeDevelopmentSession(repoRoot) {
  const sessionPath = developmentSessionPath(repoRoot);
  removeRuntimeStateFile(sessionPath);
}

function readDevelopmentSession(repoRoot) {
  const sessionPath = developmentSessionPath(repoRoot);
  if (!fs.existsSync(sessionPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch {
    throw new Error(`invalid development session registry: ${sessionPath}`);
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopRecordedDevelopmentChildren(session) {
  const pids = [...new Set(
    (Array.isArray(session.childPids) ? session.childPids : [])
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
  )];
  for (const pid of pids) {
    if (!processIsAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw new Error(`failed to stop managed development process ${pid}: ${error.message}`);
      }
    }
  }
}

function stopManagedDevelopmentSession(repoRoot, ownedBindings = []) {
  const session = readDevelopmentSession(repoRoot);
  if (!session) return false;
  const heartbeatAt = Date.parse(session.heartbeatAt ?? '');
  const expectedRoot = canonicalRepositoryRoot(repoRoot);
  if (canonicalRepositoryRoot(session.repoRoot ?? '') !== expectedRoot) {
    throw new Error('development session registry belongs to another repository');
  }
  if (!Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > DEVELOPMENT_SESSION_STALE_MS) {
    // The supervisor is gone (or hung); its recorded children may still be
    // alive and holding owned ports. Reclaim them before dropping the session.
    stopRecordedDevelopmentChildren(session);
    removeDevelopmentSession(repoRoot);
    return false;
  }
  if (!processIsAlive(session.supervisorPid)) {
    stopRecordedDevelopmentChildren(session);
    removeDevelopmentSession(repoRoot);
    return false;
  }
  if (process.platform === 'win32') {
    stopOwnedBindings(ownedBindings);
    const result = spawnSync('taskkill', ['/PID', String(session.supervisorPid), '/T', '/F'], {
      stdio: 'pipe',
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    if (result.status !== 0 && processIsAlive(session.supervisorPid)) {
      const ownedPids = [
        ...(Array.isArray(session.childPids) ? session.childPids : []),
        session.supervisorPid,
      ].filter((pid, index, values) => Number.isSafeInteger(pid) && pid > 0 && values.indexOf(pid) === index);
      for (const pid of ownedPids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (error) {
          if (error.code !== 'ESRCH') {
            throw new Error(`failed to stop managed development process ${pid}: ${error.message}`);
          }
        }
      }
    }
    removeDevelopmentSession(repoRoot);
  } else {
    process.kill(session.supervisorPid, 'SIGTERM');
  }
  return true;
}

function loadRuntime(repoRoot) {
  const location = resolveTopologyLocation(repoRoot);
  const spec = loadTopologySpec(location.specPath);
  const runtime = createTopologyRuntime(spec, location.topologyRoot, location.specPath);
  if (runtime.schemaVersion !== 5) throw new Error('sdkwork-app requires topology schemaVersion 5');
  return runtime;
}

function resolveSurfaceHealthOptions(surface = {}) {
  return {
    path: surface.healthPath ?? '/healthz',
    attempts: surface.healthAttempts ?? 90,
    intervalMs: surface.healthIntervalMs ?? 1000,
    timeoutMs: surface.healthTimeoutMs ?? 2000,
  };
}

async function waitForPlanHealth(plan, runtime, signal) {
  for (const check of plan.healthChecks) {
    if (!check.url) throw new Error(`missing health URL for ${check.surfaceId}`);
    const surface = runtime.spec.surfaces[check.surfaceId] ?? {};
    const healthy = await waitForHttpHealthy(check.url, {
      ...resolveSurfaceHealthOptions(surface),
      signal,
    });
    if (signal?.aborted) return;
    if (!healthy) throw new Error(`health check failed for ${check.surfaceId}: ${check.url}`);
  }
}

function developmentAccessLines(plan, options = {}) {
  return formatPrimaryAccessLines(plan, {
    prefix: '[sdkwork-app] ',
    ...options,
  });
}

function developmentWebAccessLines(plan, options = {}) {
  const prefix = options.prefix ?? '[sdkwork-app] ';
  const reports = resolveAccessEndpointReports(plan, options);
  const webEndpoint = reports.find(
    (endpoint) => endpoint.kind === 'user-interface' && endpoint.primary,
  );
  if (!webEndpoint) {
    return [];
  }
  const lines = formatResolvedNetworkAccessLines(webEndpoint, {
    prefix: `${prefix}  `,
    localLabel: 'Local',
    networkLabel: 'Network',
    unavailableText: options.unavailableText
      ?? 'unavailable (listener is loopback-only or no LAN address was detected)',
  });
  if (lines.length === 0) {
    return [];
  }
  const adaptiveHint = (plan.browserDeliveries ?? []).some((delivery) => delivery.adaptive)
    ? [`${prefix}  PC and H5 renderers are selected automatically by device class at this origin`]
    : [];
  return [`${prefix}Web Access URLs`, ...lines, ...adaptiveHint];
}

function findNearestApplicationRoot(startPath, repoRoot) {
  const boundary = path.resolve(repoRoot);
  let current = path.resolve(startPath);
  if (current !== boundary && !current.startsWith(`${boundary}${path.sep}`)) {
    throw new Error(`client path must stay within repository root: ${startPath}`);
  }
  while (current === boundary || current.startsWith(`${boundary}${path.sep}`)) {
    if (fs.existsSync(path.join(current, 'sdkwork.app.config.json'))) {
      return current;
    }
    if (current === boundary) {
      break;
    }
    current = path.dirname(current);
  }
  return boundary;
}

function listWorkspacePackageManifests(repoRoot) {
  const manifests = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist', 'target'].includes(entry.name)) {
        continue;
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.name === 'package.json') {
        manifests.push(entryPath);
      }
    }
  };
  visit(repoRoot);
  return manifests;
}

function resolveClientApplicationRoot(repoRoot, entry) {
  const boundary = path.resolve(repoRoot);
  let applicationRoot;
  if (entry.applicationRoot) {
    applicationRoot = path.resolve(repoRoot, entry.applicationRoot);
  } else if (entry.cwd) {
    applicationRoot = findNearestApplicationRoot(path.resolve(repoRoot, entry.cwd), repoRoot);
  } else if (entry.package) {
    for (const manifestPath of listWorkspacePackageManifests(repoRoot)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.name === entry.package) {
        applicationRoot = findNearestApplicationRoot(path.dirname(manifestPath), repoRoot);
        break;
      }
    }
    if (!applicationRoot) {
      throw new Error(`cannot resolve application root for client package ${entry.package}`);
    }
  } else {
    applicationRoot = boundary;
  }
  if (applicationRoot !== boundary && !applicationRoot.startsWith(`${boundary}${path.sep}`)) {
    throw new Error(`client applicationRoot must stay within repository root: ${entry.applicationRoot}`);
  }
  if (!fs.existsSync(path.join(applicationRoot, 'sdkwork.app.config.json'))) {
    throw new Error(`client applicationRoot is missing sdkwork.app.config.json: ${applicationRoot}`);
  }
  return applicationRoot;
}

async function loadOptionalWorkspaceModule(applicationRoot, specifier) {
  const roots = [applicationRoot, path.join(WORKSPACE_ROOT, 'sdkwork-iam')];
  for (const root of roots) {
    const packageJson = path.join(root, 'package.json');
    if (!fs.existsSync(packageJson)) {
      continue;
    }
    try {
      const require = createRequire(packageJson);
      const modulePath = require.resolve(specifier);
      return await import(pathToFileURL(modulePath).href);
    } catch {
      continue;
    }
  }
  return null;
}

async function loadCredentialEntryBootstrap(applicationRoot) {
  return loadOptionalWorkspaceModule(applicationRoot, '@sdkwork/iam-credential-entry/node-bootstrap');
}

async function loadApplicationBootstrap(applicationRoot) {
  return loadOptionalWorkspaceModule(applicationRoot, '@sdkwork/iam-application-bootstrap');
}

function mapLifecycleToWorkspaceProfile(environment) {
  if (environment === 'development' || environment === 'dev' || environment === 'local') {
    return 'dev';
  }
  if (environment === 'production' || environment === 'prod') {
    return 'production';
  }
  return environment;
}

function parseDotEnvAssignments(contents) {
  const values = {};
  for (const rawLine of String(contents ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && value) values[key] = value;
  }
  return values;
}

function applyBlankEnv(target, source = {}) {
  for (const [key, value] of Object.entries(source)) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) continue;
    if (!String(target[key] ?? '').trim()) {
      target[key] = trimmed;
    }
  }
  return target;
}

function loadWorkspaceBootstrapProfileEnv(environment, workspaceRoot = WORKSPACE_ROOT) {
  const profile = mapLifecycleToWorkspaceProfile(environment);
  const dirs = [
    path.join(workspaceRoot, 'configs', 'bootstrap', 'profiles'),
    path.join(workspaceRoot, 'etc', 'bootstrap', 'profiles'),
  ];
  const values = {};
  for (const dir of dirs) {
    let found = false;
    for (const name of [`${profile}.env`, `${profile}.local.env`]) {
      const filePath = path.join(dir, name);
      if (!fs.existsSync(filePath)) continue;
      Object.assign(values, parseDotEnvAssignments(fs.readFileSync(filePath, 'utf8')));
      found = true;
    }
    if (found) break;
  }
  return values;
}

async function applyHomeBootstrapAuth(env, environment) {
  const bootstrap = await loadApplicationBootstrap(path.join(WORKSPACE_ROOT, 'sdkwork-iam'));
  if (typeof bootstrap?.loadBootstrapAuthProfileFromHome !== 'function') {
    return env;
  }
  const loaded = await bootstrap.loadBootstrapAuthProfileFromHome({
    env,
    lifecycleEnvironment: mapLifecycleToWorkspaceProfile(environment) === 'dev'
      ? 'development'
      : environment === 'prod'
        ? 'production'
        : environment,
  });
  const username = String(
    loaded?.profile?.username ?? loaded?.profile?.email ?? loaded?.profile?.account ?? '',
  ).trim();
  const password = String(loaded?.profile?.password ?? '').trim();
  if (!username || !password) return env;
  if (!String(
    env.SDKWORK_IAM_BOOTSTRAP_OPERATOR_USERNAME
    ?? env.SDKWORK_IAM_BOOTSTRAP_USERNAME
    ?? env.SDKWORK_IAM_SUPER_ADMIN_USERNAME
    ?? '',
  ).trim()) {
    env.SDKWORK_IAM_BOOTSTRAP_OPERATOR_USERNAME = username;
  }
  if (!String(
    env.SDKWORK_IAM_BOOTSTRAP_OPERATOR_PASSWORD
    ?? env.SDKWORK_IAM_BOOTSTRAP_PASSWORD
    ?? env.SDKWORK_IAM_SUPER_ADMIN_PASSWORD
    ?? '',
  ).trim()) {
    env.SDKWORK_IAM_BOOTSTRAP_OPERATOR_PASSWORD = password;
  }
  return env;
}

/**
 * Start/build env: fill blank workspace bootstrap profile keys and home
 * operator credentials, then ensure `SDKWORK_ACCESS_TOKEN`.
 */
async function prepareLifecycleAccessTokenEnv(repoRoot, env, environment, extra = {}) {
  const merged = { ...env };
  applyBlankEnv(merged, loadWorkspaceBootstrapProfileEnv(environment));
  await applyHomeBootstrapAuth(merged, environment);
  return applyLifecycleBootstrapAccessToken(repoRoot, merged, environment, extra);
}

function looksLikeLocalFixtureJwt(token) {
  const [headerPart, , signaturePart, ...rest] = String(token ?? '').split('.');
  if (headerPart === undefined || signaturePart === undefined || rest.length > 0) {
    return false;
  }
  if (signaturePart !== 'signature') {
    return false;
  }
  try {
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    return header.alg === 'none';
  } catch {
    return false;
  }
}

function isLoopbackBackendUrl(url) {
  const trimmed = String(url ?? '').trim();
  if (!trimmed) {
    return false;
  }
  try {
    const hostname = new URL(trimmed).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function isUsableLifecycleAccessToken(token, backendBaseUrl) {
  const trimmed = String(token ?? '').trim();
  if (!trimmed) {
    return false;
  }
  if (!looksLikeLocalFixtureJwt(trimmed)) {
    return true;
  }
  return isLoopbackBackendUrl(backendBaseUrl);
}

function readLocalBootstrapAccessToken(repoRoot, environment) {
  const lifecycle = environment === 'dev'
    ? 'development'
    : environment === 'prod'
      ? 'production'
      : environment;
  const candidates = [
    path.join(repoRoot, '.sdkwork.local.env'),
    path.join(repoRoot, `.env.standalone.${lifecycle}.bootstrap.local`),
    path.join(repoRoot, `.env.${lifecycle}.bootstrap.local`),
  ];
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex <= 0) continue;
      if (trimmed.slice(0, separatorIndex).trim() !== 'SDKWORK_ACCESS_TOKEN') continue;
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value) return value;
    }
  }
  return undefined;
}

async function tryEnsureRegisteredBootstrapToken(repoRoot, env, environment) {
  const bootstrap = await loadApplicationBootstrap(repoRoot);
  if (typeof bootstrap?.ensureRepoBootstrapAccessToken !== 'function') {
    return null;
  }
  return bootstrap.ensureRepoBootstrapAccessToken({
    env,
    environment,
    repoRoot,
    tryApplicationBootstrap: true,
    warn: (line) => process.stderr.write(`[sdkwork-app] ${line}\n`),
  });
}

async function applyLifecycleBootstrapAccessToken(repoRoot, env, environment, extra = {}) {
  const merged = { ...env };
  const backendBaseUrl = String(merged.SDKWORK_BACKEND_BASE_URL ?? '').trim();
  if (!isUsableLifecycleAccessToken(merged.SDKWORK_ACCESS_TOKEN, backendBaseUrl)) {
    const fromFiles = readLocalBootstrapAccessToken(repoRoot, environment);
    if (isUsableLifecycleAccessToken(fromFiles, backendBaseUrl)) {
      merged.SDKWORK_ACCESS_TOKEN = fromFiles;
    } else if (merged.SDKWORK_ACCESS_TOKEN && looksLikeLocalFixtureJwt(merged.SDKWORK_ACCESS_TOKEN)) {
      delete merged.SDKWORK_ACCESS_TOKEN;
    }
  }

  if (
    extra.tryApplicationBootstrap !== false
    && backendBaseUrl
    && !isUsableLifecycleAccessToken(merged.SDKWORK_ACCESS_TOKEN, backendBaseUrl)
  ) {
    const ensured = await tryEnsureRegisteredBootstrapToken(repoRoot, merged, environment);
    if (isUsableLifecycleAccessToken(ensured?.token, backendBaseUrl)) {
      merged.SDKWORK_ACCESS_TOKEN = ensured.token;
      return merged;
    }
  }

  if (isUsableLifecycleAccessToken(merged.SDKWORK_ACCESS_TOKEN, backendBaseUrl)) {
    return merged;
  }

  const credentialEntry = await loadCredentialEntryBootstrap(repoRoot);
  if (credentialEntry?.mergeRepoBootstrapAccessTokenEnv) {
    const next = credentialEntry.mergeRepoBootstrapAccessTokenEnv({
      repoRoot,
      env: merged,
      environment,
      ...extra,
    });
    const nextBackend = String(next.SDKWORK_BACKEND_BASE_URL ?? backendBaseUrl).trim();
    if (isUsableLifecycleAccessToken(next.SDKWORK_ACCESS_TOKEN, nextBackend)) {
      return next;
    }
    if (next.SDKWORK_ACCESS_TOKEN && looksLikeLocalFixtureJwt(next.SDKWORK_ACCESS_TOKEN)) {
      delete next.SDKWORK_ACCESS_TOKEN;
    }
    return next;
  }
  return merged;
}

async function buildClientEnvironment(repoRoot, entry, env, plan) {
  const applicationRoot = resolveClientApplicationRoot(repoRoot, entry);
  return applyLifecycleBootstrapAccessToken(
    applicationRoot,
    { ...env, ...(entry.env ?? {}) },
    plan.environment,
    { runtimeTarget: plan.runtimeTarget },
  );
}

async function runGenericDevelopment(repoRoot, runtime, plan, env, dryRun) {
  const adaptiveDeliveries = (plan.browserDeliveries ?? []).filter((delivery) => (
    delivery.deliveryMode === 'dev-server-proxy'
    && Array.isArray(delivery.renderers)
    && delivery.renderers.length > 0
  ));
  const coveredClientProcessIds = new Set(
    adaptiveDeliveries.map((delivery) => delivery.clientProcessId),
  );
  const early = plan.localProcesses.filter((entry) => (
    entry.role !== 'client' && !coveredClientProcessIds.has(entry.id)
  ));
  const clients = plan.localProcesses.filter((entry) => (
    entry.role === 'client' && !coveredClientProcessIds.has(entry.id)
  ));
  const resolved = plan.localProcesses
    .filter((entry) => !coveredClientProcessIds.has(entry.id))
    .map((entry) => ({ entry, invocation: resolveProcessInvocation(entry) }));
  const missing = resolved.filter((item) => !item.invocation).map((item) => item.entry.id);
  if (missing.length > 0) throw new Error(`process commands are unresolved: ${missing.join(', ')}`);
  if (dryRun) {
    console.log(JSON.stringify({ plan, invocations: resolved }, null, 2));
    return;
  }
  const clientEnvironments = new Map();
  for (const entry of clients) {
    clientEnvironments.set(entry, await buildClientEnvironment(repoRoot, entry, env, plan));
  }
  const children = [];
  const adaptiveHandles = [];
  const launch = (entry) => {
    const invocation = resolveProcessInvocation(entry);
    const childEnv = entry.role === 'client'
      ? clientEnvironments.get(entry)
      : { ...env, ...(entry.env ?? {}) };
    const child = spawnLifecycleCommand(invocation.command, invocation.args, {
      cwd: path.resolve(repoRoot, entry.cwd ?? '.'),
      env: childEnv,
      detached: process.platform !== 'win32',
      processId: entry.id,
      processRole: entry.role,
    });
    children.push({
      child,
      entry,
      result: waitForLifecycleCommand(child),
    });
    refreshSession();
  };
  const terminate = () => {
    for (const handle of adaptiveHandles) {
      handle.close();
    }
    children.forEach(({ child }) => {
      if (child.killed || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
      if (process.platform === 'win32') {
        child.kill('SIGTERM');
        return;
      }
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    });
  };
  const session = {
    schemaVersion: 1,
    repoRoot: canonicalRepositoryRoot(repoRoot),
    supervisorPid: process.pid,
    profileId: plan.activeProfile,
    runtimeTarget: plan.runtimeTarget,
    ownedBindings: plan.ownedBindings,
    startedAt: new Date().toISOString(),
  };
  const refreshSession = () => writeDevelopmentSession(repoRoot, {
    ...session,
    childPids: [
      ...children.map(({ child }) => child.pid),
      ...adaptiveHandles.flatMap((handle) => (
        [...handle.renderers.values()].map((renderer) => renderer.child.pid)
      )),
    ].filter((pid) => Number.isSafeInteger(pid) && pid > 0),
  });
  let resolveSignal;
  const signalReceived = new Promise((resolve) => { resolveSignal = resolve; });
  const onSignal = () => {
    terminate();
    resolveSignal(true);
  };
  refreshSession();
  const heartbeat = setInterval(refreshSession, DEVELOPMENT_SESSION_HEARTBEAT_MS);
  heartbeat.unref();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    reconcileManagedResources(plan.managedResources, env, 'provision');
    early.forEach(launch);
    const startupAbort = new AbortController();
    let startup;
    try {
      startup = await Promise.race([
        waitForPlanHealth(plan, runtime, startupAbort.signal).then(() => ({ kind: 'healthy' })),
        signalReceived.then(() => ({ kind: 'signal' })),
        ...children.map(({ entry, result }) => result.then((outcome) => ({
          kind: 'early-exit',
          entry,
          outcome,
        }))),
      ]);
    } finally {
      startupAbort.abort();
    }
    if (startup.kind === 'signal') return;
    if (startup.kind === 'early-exit') {
      throw new Error(
        `development process ${startup.entry.id} exited with code ${startup.outcome.code} before required health checks completed`,
      );
    }
    clients.forEach(launch);
    for (const delivery of adaptiveDeliveries) {
      adaptiveHandles.push(await startAdaptiveWebDelivery({
        runtime,
        plan,
        delivery,
        env,
        report: {
          stdout: (message) => process.stdout.write(`[sdkwork-app] ${message}\n`),
          stderr: (message) => process.stderr.write(`[sdkwork-app] ${message}\n`),
        },
      }));
    }
    refreshSession();
    for (const line of developmentWebAccessLines(plan)) {
      console.log(line);
    }
    for (const line of formatAccessEndpointCatalogLines(plan, { prefix: '[sdkwork-app] ' })) {
      console.log(line);
    }
    if (children.length === 0 && adaptiveHandles.length === 0) {
      throw new Error('development plan has no local processes; declare a client process, an adaptive browser delivery, or a private _sdkwork:dev hook');
    }
    const first = await Promise.race([
      ...children.map(({ result }) => result),
      signalReceived.then(() => ({ code: 0, signal: 'SIGTERM' })),
    ]);
    if (first.code !== 0) throw new Error(`development process exited with code ${first.code}`);
  } finally {
    clearInterval(heartbeat);
    try {
      stopOwnedBindings(plan.ownedBindings);
    } catch (error) {
      // Cleanup must not mask the primary startup failure: report the
      // occupied bindings as a warning and keep the original error chain.
      process.stderr.write(
        `[sdkwork-app] warning: owned TCP bindings could not be reclaimed during cleanup: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      terminate();
      try {
        reconcileManagedResources(plan.managedResources, env, 'remove');
      } finally {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
        removeDevelopmentSession(repoRoot);
      }
    }
  }
}

function developmentCleanupTargets(runtime) {
  const bindings = [];
  const resources = [];
  const bindingPorts = new Set();
  const resourceIds = new Set();
  for (const [profileId, profile] of Object.entries(runtime.spec.orchestration?.profiles ?? {})) {
    if (runtime.parseProfileId(profileId).environment !== 'development') continue;
    const environment = runtime.applyProfileEnv(profileId, [process.env, runtime.loadProfile(profileId)]);
    for (const binding of resolveOwnedBindings(runtime.spec, profile, environment)) {
      if (!bindingPorts.has(binding.port)) {
        bindingPorts.add(binding.port);
        bindings.push(binding);
      }
    }
    for (const resource of profile.managedResources ?? []) {
      if (!resourceIds.has(resource.id)) {
        resourceIds.add(resource.id);
        resources.push({ resource, environment });
      }
    }
  }
  return { bindings, resources };
}

async function runDevelopment(repoRoot, packageManifest, args) {
  const deploymentProfile = option(args, '--deployment-profile', 'standalone');
  const environment = option(args, '--environment', 'development');
  const runtimeTarget = option(args, '--runtime-target', 'browser');
  const clientArchitecture = option(args, '--client-architecture');
  const dryRun = args.includes('--dry-run');
  const runtime = loadRuntime(repoRoot);
  const activeProfileId = `${deploymentProfile}.${environment}`;
  // First pass on the raw profile file: role detection decides whether local
  // API processes (and therefore PostgreSQL credentials) are needed. The
  // execution plan is re-resolved below from the dev-bound profile env so
  // browser delivery API targets and health checks follow PNPM_SCRIPT_SPEC §3
  // (`dev:cloud` binds the local platform gateway, never deployed domains).
  const rawPlan = runtime.resolvePlan(activeProfileId, runtimeTarget, clientArchitecture);
  if (rawPlan.forbiddenProcesses.length > 0) throw new Error(`forbidden local processes: ${rawPlan.forbiddenProcesses.join(', ')}`);
  const regionEnv = resolveRegionEnv(repoRoot, runtime, args);
  const profileEnv = runtime.applyProfileEnv(activeProfileId, [process.env, runtime.loadProfile(activeProfileId), regionEnv]);
  // Local API/worker processes require PostgreSQL credentials from `.env.postgres`
  // (SDKWORK_DATABASE_URL synthesized via resolveIamDevEnv). Cloud client-only
  // profiles do not start those processes and skip the postgres merge.
  const needsLocalDatabase = (rawPlan.localProcesses ?? []).some((entry) => (
    entry.role === 'api-standalone-gateway'
    || entry.role === 'worker'
    || entry.role === 'database'
  ));
  const databaseAwareProfileEnv = needsLocalDatabase
    ? runtime.resolveIamDevEnv(profileEnv)
    : profileEnv;
  // PNPM_SCRIPT_SPEC §3: cloud-mode development binds gateway-anchored base
  // URLs to the locally started sdkwork-api-cloud-gateway (ip:port) so
  // `pnpm dev:cloud` quick-starts and debugs against the local process. Domain
  // edges remain authoritative for cloud-mode builds and deployed services.
  const devProfileEnv = applyDevelopmentLocalGatewayBinding(databaseAwareProfileEnv, { profileId: activeProfileId });
  const env = await prepareLifecycleAccessTokenEnv(repoRoot, devProfileEnv, environment);
  // Deterministic plan surface: profile file values plus the dev-process
  // gateway binding only — shell environment must not reshape the plan.
  const plan = runtime.resolvePlan(activeProfileId, runtimeTarget, clientArchitecture, {
    profileEnv: applyDevelopmentLocalGatewayBinding(
      runtime.loadProfile(activeProfileId),
      { profileId: activeProfileId },
    ),
  });
  console.log(`[sdkwork-app] ${plan.appId} ${plan.activeProfile} runtimeTarget=${runtimeTarget} clientArchitecture=${plan.clientArchitecture ?? 'none'}`);
  const privateScript = privateLifecycleScript('dev', deploymentProfile);
  if (packageManifest.scripts?.[privateScript] && !dryRun) {
    const result = await runPrivateLifecycleScript(repoRoot, packageManifest, privateScript, [
      '--deployment-profile', deploymentProfile,
      '--environment', environment,
      '--runtime-target', runtimeTarget,
    ], { env });
    if (result.code !== 0) throw new Error(`${privateScript} exited with code ${result.code}`);
    return;
  }
  await runGenericDevelopment(repoRoot, runtime, plan, env, dryRun);
}

async function runWorkflow(repoRoot, command, args) {
  const workflowCli = frameworkCliPath('SDKWORK_GITHUB_WORKFLOW_CLI', DEFAULT_WORKFLOW_CLI);
  if (!fs.existsSync(workflowCli)) {
    throw new Error(`missing workflow framework: ${workflowCli}; set SDKWORK_GITHUB_WORKFLOW_CLI for a non-workspace installation`);
  }
  const config = path.join(repoRoot, 'sdkwork.workflow.json');
  if (!fs.existsSync(config)) throw new Error('sdkwork.workflow.json is required');
  await runCommand(process.execPath, [workflowCli, command, '--config', config, ...args], repoRoot);
}

async function runRelease(repoRoot, packageManifest, command, args) {
  const phase = command.split(':')[1];
  if (phase === 'plan') {
    await runWorkflow(repoRoot, 'matrix', args);
    return;
  }
  const workflowPhases = new Set(['preflight', 'build', 'stage', 'package', 'sign', 'sbom', 'validate', 'publish']);
  if (!workflowPhases.has(phase)) throw new Error(`unsupported release phase ${phase}`);
  if (!option(args, '--target-id') && !option(args, '--deployment-profile')) {
    throw new Error(`${command} requires --target-id or --deployment-profile`);
  }
  await runWorkflow(repoRoot, 'lifecycle', ['--phase', phase, '--run', ...args]);
}

async function runDeploy(repoRoot, command, args) {
  const deployCli = frameworkCliPath('SDKWORK_DEPLOY_CLI', DEFAULT_DEPLOY_CLI);
  if (!fs.existsSync(deployCli)) {
    throw new Error(`missing deploy framework: ${deployCli}; set SDKWORK_DEPLOY_CLI for a non-workspace installation`);
  }
  const phase = command.split(':')[1];
  if (phase === 'validate' || phase === 'plan') {
    await runCommand(process.execPath, [deployCli, phase, '--root', repoRoot, ...args], repoRoot);
  } else if (phase === 'apply' || phase === 'rollback') {
    await runCommand(process.execPath, [deployCli, phase, '--root', repoRoot, ...args], repoRoot);
  } else throw new Error(`unsupported deploy phase ${phase}`);
}

function requiredWorkflowDeployValue(environment, key) {
  const value = String(environment[key] ?? '').trim();
  if (!value) throw new Error(`${key} is required for side-effecting deployment`);
  return value;
}

function createWorkflowDeployArgs(repoRoot, environment = process.env) {
  const deploymentProfile = requiredWorkflowDeployValue(environment, 'SDKWORK_DEPLOYMENT_PROFILE');
  const deployEnvironment = requiredWorkflowDeployValue(environment, 'SDKWORK_DEPLOY_ENVIRONMENT');
  if (!/^(standalone|cloud)$/u.test(deploymentProfile)) {
    throw new Error('SDKWORK_DEPLOYMENT_PROFILE must be standalone or cloud');
  }
  if (!/^(test|staging|production)$/u.test(deployEnvironment)) {
    throw new Error('SDKWORK_DEPLOY_ENVIRONMENT must be test, staging, or production');
  }
  const evidencePath = path.resolve(
    repoRoot,
    requiredWorkflowDeployValue(environment, 'SDKWORK_ARTIFACT_EVIDENCE_PATH'),
  );
  const boundary = path.resolve(repoRoot);
  if (evidencePath !== boundary && !evidencePath.startsWith(`${boundary}${path.sep}`)) {
    throw new Error('SDKWORK_ARTIFACT_EVIDENCE_PATH must stay within the application root');
  }
  if (!fs.existsSync(evidencePath)) throw new Error(`artifact evidence does not exist: ${evidencePath}`);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const artifactId = String(evidence.artifactId ?? '').trim();
  const digest = String(evidence.digest ?? '').trim();
  if (!artifactId) throw new Error('artifact evidence artifactId is required');
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) {
    throw new Error('artifact evidence digest must be immutable sha256');
  }
  return [
    '--profile', `${deploymentProfile}.${deployEnvironment}`,
    '--environment', deployEnvironment,
    '--artifact-id', artifactId,
    '--artifact-digest', digest,
    '--artifact-evidence', evidencePath,
    '--artifact-root', path.join(boundary, '.sdkwork', 'artifacts'),
    '--rollback-target', requiredWorkflowDeployValue(environment, 'SDKWORK_DEPLOY_ROLLBACK_TARGET'),
    '--approval-ref', requiredWorkflowDeployValue(environment, 'SDKWORK_DEPLOY_APPROVAL_REF'),
  ];
}

async function runStandardCheck(repoRoot, environmentKey, fallback) {
  const cli = frameworkCliPath(environmentKey, fallback);
  if (!fs.existsSync(cli)) {
    throw new Error(`missing standards validator: ${cli}; set ${environmentKey} for a non-workspace installation`);
  }
  await runCommand(process.execPath, [cli, '--root', repoRoot], repoRoot);
}

async function runStop(repoRoot, packageManifest, args) {
  const privateScript = privateLifecycleScript('stop');
  const privateResult = await runPrivateLifecycleScript(repoRoot, packageManifest, privateScript, args);
  if (privateResult) {
    if (privateResult.code !== 0) throw new Error(`${privateScript} exited with code ${privateResult.code}`);
  }
  const runtime = loadRuntime(repoRoot);
  const cleanup = developmentCleanupTargets(runtime);
  const stoppedSession = stopManagedDevelopmentSession(repoRoot, cleanup.bindings);
  const stoppedPids = stopOwnedBindings(cleanup.bindings);
  const removedResources = [];
  for (const { resource, environment } of cleanup.resources) {
    removedResources.push(...reconcileManagedResources([resource], environment, 'remove'));
  }
  if (!stoppedSession && stoppedPids.size === 0 && removedResources.length === 0 && !privateResult) {
    console.log(`[sdkwork-app] no active managed development resources: ${repoRoot}`);
    return;
  }
  console.log(`[sdkwork-app] stopped managed development resources: ${repoRoot}`);
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log('Usage: sdkwork-app <dev|stop|build|test|check|verify|clean|doctor|topology:plan|topology:validate|release:<phase>|deploy:validate|deploy:plan|deploy:apply|deploy:rollback|deploy:workflow-apply> [options]');
    return;
  }
  const repoRoot = path.resolve(option(args, '--root', process.cwd()));
  const forwarded = passthroughArgs(args, new Set(['--root']));
  const packageManifest = loadPackageManifest(repoRoot);
  if (command === 'doctor') {
    const issues = validateLifecyclePackage(packageManifest);
    if (issues.length > 0) throw new Error(`lifecycle contract failed: ${issues.join('; ')}`);
    await runStandardCheck(repoRoot, 'SDKWORK_APP_MANIFEST_CHECK_CLI', DEFAULT_APP_MANIFEST_CHECK_CLI);
    await runStandardCheck(repoRoot, 'SDKWORK_SOURCE_CONFIG_CHECK_CLI', DEFAULT_SOURCE_CONFIG_CHECK_CLI);
    await runStandardCheck(repoRoot, 'SDKWORK_ADAPTIVE_WEB_CHECK_CLI', DEFAULT_ADAPTIVE_WEB_CHECK_CLI);
    loadRuntime(repoRoot);
    if (fs.existsSync(path.join(repoRoot, 'sdkwork.workflow.json'))) {
      await runWorkflow(repoRoot, 'validate', []);
    }
    if (fs.existsSync(path.join(repoRoot, 'deployments', 'deploy.yaml'))) {
      await runDeploy(repoRoot, 'deploy:validate', []);
    }
    console.log(`[sdkwork-app] lifecycle contract ok: ${repoRoot}`);
    return;
  }
  if (command === 'dev') return runDevelopment(repoRoot, packageManifest, forwarded);
  if (command === 'stop') return runStop(repoRoot, packageManifest, forwarded);
  if (command === 'topology:validate') {
    loadRuntime(repoRoot);
    console.log(`[sdkwork-app] topology v5 valid: ${repoRoot}`);
    return;
  }
  if (command === 'topology:plan') {
    const runtime = loadRuntime(repoRoot);
    const profile = `${option(forwarded, '--deployment-profile', 'standalone')}.${option(forwarded, '--environment', 'development')}`;
    console.log(JSON.stringify(runtime.resolvePlan(
      profile,
      option(forwarded, '--runtime-target', 'browser'),
      option(forwarded, '--client-architecture'),
    ), null, 2));
    return;
  }
  if (['build', 'test', 'check', 'verify', 'clean'].includes(command)) {
    const script = privateLifecycleScript(command);
    const environment = option(forwarded, '--environment', 'development');
    const runtime = loadRuntime(repoRoot);
    const regionEnv = resolveRegionEnv(repoRoot, runtime, forwarded);
    const env = await prepareLifecycleAccessTokenEnv(
      repoRoot,
      { ...process.env, ...regionEnv },
      environment,
    );
    const result = await runPrivateLifecycleScript(repoRoot, packageManifest, script, forwarded, { env });
    if (!result) throw new Error(`missing private lifecycle hook ${script}`);
    if (result.code !== 0) throw new Error(`${script} exited with code ${result.code}`);
    return;
  }
  if (command.startsWith('release:')) return runRelease(repoRoot, packageManifest, command, forwarded);
  if (command === 'deploy:workflow-apply') {
    return runDeploy(repoRoot, 'deploy:apply', createWorkflowDeployArgs(repoRoot));
  }
  if (command.startsWith('deploy:')) return runDeploy(repoRoot, command, forwarded);
  throw new Error(`unsupported lifecycle command ${command}`);
}

function sameModulePath(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

const invokedPath = process.argv[1] ? process.argv[1] : null;
if (invokedPath && sameModulePath(invokedPath, fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const command = process.argv[2];
    const summary = command === 'dev' ? 'startup failed' : `command ${command ?? '<unknown>'} failed`;
    console.error(formatLifecycleError(error, { summary }));
    process.exitCode = 1;
  });
}

export {
  applyLifecycleBootstrapAccessToken,
  prepareLifecycleAccessTokenEnv,
  loadWorkspaceBootstrapProfileEnv,
  buildClientEnvironment,
  createWorkflowDeployArgs,
  developmentAccessLines,
  developmentWebAccessLines,
  developmentSessionPath,
  frameworkCliPath,
  isUsableLifecycleAccessToken,
  main,
  passthroughArgs,
  readDevelopmentSession,
  readLocalBootstrapAccessToken,
  removeDevelopmentSession,
  runGenericDevelopment,
  resolveClientApplicationRoot,
  resolveSurfaceHealthOptions,
  sameModulePath,
  stopManagedDevelopmentSession,
  developmentCleanupTargets,
  writeDevelopmentSession,
};
