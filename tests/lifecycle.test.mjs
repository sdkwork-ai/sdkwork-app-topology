// WORKSPACE-PATH:allow-fixture - this file is a test fixture that simulates a foreign
// checkout root, so the sdkwork-<name> segment below is the value under assertion rather
// than a binding to a real sibling checkout. PORTABILITY_SPEC.md section 5.2 governs it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  formatLifecycleError,
  LifecycleProcessError,
  platformLifecycleInvocation,
  resolveProcessInvocation,
  spawnLifecycleCommand,
  waitForLifecycleCommand,
} from '../tools/topology/lib/lifecycle.mjs';

import {
  applyLifecycleBootstrapAccessToken,
  prepareLifecycleAccessTokenEnv,
  loadWorkspaceBootstrapProfileEnv,
  buildClientEnvironment,
  createWorkflowDeployArgs,
  developmentAccessLines,
  isUsableLifecycleAccessToken,
  readDevelopmentSession,
  readLocalBootstrapAccessToken,
  developmentSessionPath,
  frameworkCliPath,
  main,
  passthroughArgs,
  removeDevelopmentSession,
  runGenericDevelopment,
  resolveClientApplicationRoot,
  resolveSurfaceHealthOptions,
  sameModulePath,
  stopManagedDevelopmentSession,
  writeDevelopmentSession,
} from '../scripts/sdkwork-app.mjs';
import {
  privateLifecycleScript,
  validateLifecyclePackage,
} from '../tools/topology/lib/lifecycle.mjs';

test('uses cold-build-safe shared health defaults with surface overrides', () => {
  assert.deepEqual(resolveSurfaceHealthOptions(), {
    path: '/healthz',
    attempts: 90,
    intervalMs: 1000,
    timeoutMs: 2000,
  });
  assert.deepEqual(resolveSurfaceHealthOptions({
    healthPath: '/readyz',
    healthAttempts: 12,
    healthIntervalMs: 250,
    healthTimeoutMs: 500,
  }), {
    path: '/readyz',
    attempts: 12,
    intervalMs: 250,
    timeoutMs: 500,
  });
});

test('accepts thin public lifecycle aliases and private implementation hooks', () => {
  const facade = 'pnpm exec sdkwork-app';
  const manifest = { scripts: {
    dev: 'pnpm dev:standalone',
    'dev:standalone': `${facade} dev --deployment-profile standalone`,
    'dev:cloud': `${facade} dev --deployment-profile cloud`,
    build: `${facade} build`,
    test: `${facade} test`,
    check: `${facade} check`,
    verify: `${facade} verify`,
    clean: `${facade} clean`,
    stop: `${facade} stop`,
    '_sdkwork:build': 'cargo build --workspace',
  } };
  assert.deepEqual(validateLifecyclePackage(manifest), []);
  assert.equal(privateLifecycleScript('dev', 'cloud'), '_sdkwork:dev:cloud');
});

test('generic development uses framework-resolved primary access endpoints', () => {
  assert.deepEqual(developmentAccessLines({
    accessEndpoints: [{
      id: 'application-ui',
      kind: 'user-interface',
      primary: true,
      path: '/',
      url: 'http://127.0.0.1:4173/',
      binding: { host: '127.0.0.1', port: 4173, value: '127.0.0.1:4173' },
    }],
  }, {
    unavailableText: 'unavailable',
  }), [
    '[sdkwork-app] Access URLs',
    '[sdkwork-app]   Local: http://127.0.0.1:4173/',
    '[sdkwork-app]   Network: unavailable',
  ]);
});

test('generic development fails immediately when an early process exits before health', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-app-early-exit-'));
  const runtime = {
    spec: {
      surfaces: {
        'application.public-ingress': {
          healthAttempts: 300,
          healthIntervalMs: 1000,
          healthTimeoutMs: 2000,
        },
      },
    },
  };
  const plan = {
    activeProfile: 'standalone.development',
    runtimeTarget: 'server',
    localProcesses: [{
      id: 'failing-gateway',
      role: 'api-standalone-gateway',
      command: process.execPath,
      args: ['-e', 'process.exit(17)'],
    }],
    ownedBindings: [],
    managedResources: [],
    healthChecks: [{
      surfaceId: 'application.public-ingress',
      url: 'http://127.0.0.1:9',
      required: true,
    }],
    accessEndpoints: [],
  };

  const startedAt = Date.now();
  await assert.rejects(
    () => runGenericDevelopment(repoRoot, runtime, plan, process.env, false),
    /development process failing-gateway exited with code 17 before required health checks completed/u,
  );
  assert.ok(Date.now() - startedAt < 5000, 'early process failure must not wait for health timeout');
  assert.equal(fs.existsSync(developmentSessionPath(repoRoot)), false);
});

test('generic development preserves a process launch failure during cleanup', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-app-launch-error-'));
  const runtime = { spec: { surfaces: {} } };
  const missingCommand = `sdkwork-command-that-does-not-exist-${process.pid}`;
  const plan = {
    activeProfile: 'standalone.development',
    runtimeTarget: 'server',
    localProcesses: [{
      id: 'missing-gateway',
      role: 'api-standalone-gateway',
      command: missingCommand,
    }],
    ownedBindings: [],
    managedResources: [],
    healthChecks: [],
    accessEndpoints: [],
  };

  await assert.rejects(
    () => runGenericDevelopment(repoRoot, runtime, plan, process.env, false),
    (error) => error instanceof LifecycleProcessError
      && error.code === 'ENOENT'
      && error.details.processId === 'missing-gateway',
  );
  assert.equal(fs.existsSync(developmentSessionPath(repoRoot)), false);
});

test('rejects public scripts that bypass the lifecycle facade', () => {
  const issues = validateLifecyclePackage({ scripts: { dev: 'vite', build: 'cargo build' } });
  assert.ok(issues.some((issue) => issue.includes('dev must delegate')));
  assert.ok(issues.some((issue) => issue.includes('scripts.build')));
});

test('framework-owned stop does not require an application-private stop hook', () => {
  const facade = 'pnpm exec sdkwork-app';
  const manifest = { scripts: {
    dev: 'pnpm dev:standalone',
    'dev:standalone': `${facade} dev --deployment-profile standalone`,
    'dev:cloud': `${facade} dev --deployment-profile cloud`,
    stop: `${facade} stop`,
    build: `${facade} build`,
    test: `${facade} test`,
    check: `${facade} check`,
    verify: `${facade} verify`,
    clean: `${facade} clean`,
    '_sdkwork:dev:standalone': 'node scripts/dev.mjs',
  } };
  assert.deepEqual(validateLifecyclePackage(manifest), []);
  manifest.scripts['_sdkwork:stop'] = 'node scripts/stop.mjs';
  assert.ok(validateLifecyclePackage(manifest).some((issue) => issue.includes('is forbidden')));
});

test('resolves script, command, and cargo topology processes without a shell', () => {
  assert.deepEqual(resolveProcessInvocation({ package: '@sdkwork/demo-pc', script: 'dev' }), {
    command: 'pnpm', args: ['--filter', '@sdkwork/demo-pc', 'run', 'dev'],
  });
  assert.deepEqual(resolveProcessInvocation({ script: 'dev:client' }), { command: 'pnpm', args: ['run', 'dev:client'] });
  assert.deepEqual(resolveProcessInvocation({ command: 'flutter', args: ['run'] }), { command: 'flutter', args: ['run'] });
  assert.deepEqual(resolveProcessInvocation({ crate: 'sdkwork-demo', binary: 'sdkwork-demo' }), {
    command: 'cargo', args: ['run', '-p', 'sdkwork-demo', '--bin', 'sdkwork-demo'],
  });
});

test('resolves pnpm through its JavaScript CLI on Windows without a shell', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-pnpm-cli-'));
  const pnpmCli = path.join(root, 'pnpm.cjs');
  fs.writeFileSync(pnpmCli, '');
  assert.deepEqual(
    platformLifecycleInvocation('pnpm', ['run', 'check'], {
      platform: 'win32',
      env: { npm_execpath: pnpmCli },
      nodeExecutable: 'node.exe',
    }),
    { command: 'node.exe', args: [pnpmCli, 'run', 'check'] },
  );
  assert.deepEqual(
    platformLifecycleInvocation('cargo', ['check'], { platform: 'win32' }),
    { command: 'cargo', args: ['check'] },
  );
  assert.deepEqual(
    platformLifecycleInvocation('pnpm', ['test'], { platform: 'linux' }),
    { command: 'pnpm', args: ['test'] },
  );
});

test('spawns the native pnpm binary on Windows without a shell', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-pnpm-native-'));
  const pnpmExe = path.join(root, 'pnpm.exe');
  fs.writeFileSync(pnpmExe, '');

  assert.deepEqual(
    platformLifecycleInvocation('pnpm', ['run', 'dev:standalone'], {
      platform: 'win32',
      env: { npm_execpath: pnpmExe },
      nodeExecutable: 'node.exe',
    }),
    { command: pnpmExe, args: ['run', 'dev:standalone'] },
  );

  const extensionless = path.join(root, 'pnpm');
  fs.writeFileSync(extensionless, '');
  assert.deepEqual(
    platformLifecycleInvocation('pnpm', ['run', 'dev:standalone'], {
      platform: 'win32',
      env: { npm_execpath: extensionless },
      nodeExecutable: 'node.exe',
    }),
    { command: extensionless, args: ['run', 'dev:standalone'] },
  );
});

test('runs the pnpm ESM CLI through node on Windows and reports an actionable failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-pnpm-esm-'));
  const pnpmMjs = path.join(root, 'pnpm.mjs');
  fs.writeFileSync(pnpmMjs, '');

  assert.deepEqual(
    platformLifecycleInvocation('pnpm', ['run', 'check'], {
      platform: 'win32',
      env: { npm_execpath: pnpmMjs },
      nodeExecutable: 'node.exe',
    }),
    { command: 'node.exe', args: [pnpmMjs, 'run', 'check'] },
  );

  assert.throws(
    () => platformLifecycleInvocation('pnpm', ['run', 'check'], {
      platform: 'win32',
      env: { npm_execpath: path.join(root, 'missing-pnpm.exe') },
      nodeExecutable: 'node.exe',
    }),
    /cannot resolve the pnpm executable for shell-free Windows lifecycle execution/u,
  );
});

test('preserves dry-run while removing facade-only root selection', () => {
  assert.deepEqual(
    passthroughArgs(
      ['--root', 'demo', '--deployment-profile', 'cloud', '--dry-run'],
      new Set(['--root']),
    ),
    ['--deployment-profile', 'cloud', '--dry-run'],
  );
});

test('preserves process context and the native cause when an executable cannot start', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-process-error-'));
  const command = `sdkwork-command-that-does-not-exist-${process.pid}`;
  const child = spawnLifecycleCommand(command, ['--version'], {
    cwd,
    env: { ...process.env, PATH: '' },
    processId: 'application.public-ingress',
    processRole: 'api-standalone-gateway',
  });
  let error;
  try {
    await waitForLifecycleCommand(child);
    assert.fail('missing executable must reject');
  } catch (caught) {
    error = caught;
  }
  assert.equal(error instanceof LifecycleProcessError, true);
  assert.equal(error.code, 'ENOENT');
  assert.equal(error.cause.code, 'ENOENT');
  assert.equal(error.details.processId, 'application.public-ingress');
  assert.equal(error.details.cwd, cwd);
  assert.equal(error.details.resolvedExecutable, undefined);
  assert.match(error.details.diagnosis, /was not found on PATH/u);
});

test('formats complete lifecycle process context, cause properties, and stacks', () => {
  const cause = Object.assign(new Error('spawn cargo ENOENT'), {
    code: 'ENOENT',
    errno: -4058,
    syscall: 'spawn cargo',
    path: 'cargo',
    spawnargs: ['run', '-p', 'sdkwork-demo'],
  });
  const error = new LifecycleProcessError('failed to start development process gateway', {
    processId: 'gateway',
    processRole: 'api-standalone-gateway',
    command: 'cargo',
    args: ['run', '-p', 'sdkwork-demo'],
    effectiveCommand: 'cargo',
    effectiveArgs: ['run', '-p', 'sdkwork-demo'],
    cwd: 'E:\\workspace\\sdkwork-demo',
    resolvedExecutable: undefined,
    path: 'C:\\Windows\\System32',
    diagnosis: 'executable "cargo" was not found on PATH',
  }, cause);
  const output = formatLifecycleError(error, { summary: 'startup failed' });
  assert.match(output, /\[sdkwork-app\] startup failed/u);
  assert.match(output, /process: gateway/u);
  assert.match(output, /command: cargo run -p sdkwork-demo/u);
  assert.match(output, /diagnosis: executable "cargo" was not found on PATH/u);
  assert.match(output, /2\. Error: spawn cargo ENOENT/u);
  assert.match(output, /code: ENOENT/u);
  assert.match(output, /spawnargs: \["run","-p","sdkwork-demo"\]/u);
  assert.match(output, /stack:/u);
});

test('resolves independent client application roots explicitly', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-client-root-'));
  const pcRoot = path.join(repoRoot, 'apps', 'demo-pc');
  const h5Root = path.join(repoRoot, 'apps', 'demo-h5');
  fs.mkdirSync(pcRoot, { recursive: true });
  fs.mkdirSync(h5Root, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'sdkwork.app.config.json'), '{}');
  fs.writeFileSync(path.join(pcRoot, 'sdkwork.app.config.json'), '{}');
  fs.writeFileSync(path.join(h5Root, 'sdkwork.app.config.json'), '{}');

  assert.equal(
    resolveClientApplicationRoot(repoRoot, { applicationRoot: 'apps/demo-pc', role: 'client' }),
    pcRoot,
  );
  assert.equal(
    resolveClientApplicationRoot(repoRoot, { cwd: 'apps/demo-h5', role: 'client' }),
    h5Root,
  );
  assert.throws(
    () => resolveClientApplicationRoot(repoRoot, { applicationRoot: '..', role: 'client' }),
    /must stay within repository root/u,
  );
});

test('builds private per-application client environments without public token aliases', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-client-env-'));
  const packageRoot = path.join(repoRoot, 'node_modules', '@sdkwork', 'iam-credential-entry');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@sdkwork/iam-credential-entry',
    type: 'module',
    exports: { './node-bootstrap': './node-bootstrap.mjs' },
  }));
  fs.writeFileSync(path.join(packageRoot, 'node-bootstrap.mjs'), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    'export function mergeRepoBootstrapAccessTokenEnv({ repoRoot, env, environment, runtimeTarget }) {',
    "  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'sdkwork.app.config.json'), 'utf8'));",
    "  const configured = String(env.SDKWORK_ACCESS_TOKEN ?? '').trim();",
    '  return {',
    '    ...env,',
    "    SDKWORK_ACCESS_TOKEN: configured || ['fixture', manifest.app.key, environment, runtimeTarget].join(':'),",
    '  };',
    '}',
    '',
  ].join('\n'));

  for (const appId of ['demo-pc', 'demo-h5']) {
    const appRoot = path.join(repoRoot, 'apps', appId);
    fs.mkdirSync(appRoot, { recursive: true });
    fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ name: `@sdkwork/${appId}` }));
    fs.writeFileSync(path.join(appRoot, 'sdkwork.app.config.json'), JSON.stringify({ app: { key: appId } }));
  }

  const plan = { environment: 'development', runtimeTarget: 'browser' };
  const pcEnv = await buildClientEnvironment(
    repoRoot,
    { applicationRoot: 'apps/demo-pc', role: 'client' },
    { SHARED_VALUE: 'shared' },
    plan,
  );
  const h5Env = await buildClientEnvironment(
    repoRoot,
    { applicationRoot: 'apps/demo-h5', role: 'client' },
    { SDKWORK_ACCESS_TOKEN: 'configured-token' },
    plan,
  );

  assert.equal(pcEnv.SDKWORK_ACCESS_TOKEN, 'fixture:demo-pc:development:browser');
  assert.equal(pcEnv.SHARED_VALUE, 'shared');
  assert.equal(h5Env.SDKWORK_ACCESS_TOKEN, 'configured-token');
  assert.equal(pcEnv.VITE_ACCESS_TOKEN, undefined);
  assert.equal(h5Env.VITE_ACCESS_TOKEN, undefined);
});

test('lifecycle start/build reuse a registered overlay token and reject remote fixture JWTs', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-lifecycle-token-'));
  const fixture = [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ token_type: 'access' })).toString('base64url'),
    'signature',
  ].join('.');
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'demo-app' }));
  fs.writeFileSync(path.join(repoRoot, 'sdkwork.app.config.json'), JSON.stringify({ app: { key: 'demo' } }));
  fs.writeFileSync(path.join(repoRoot, '.sdkwork.local.env'), 'SDKWORK_ACCESS_TOKEN=signed-dev-token\r\n', 'utf8');

  assert.equal(isUsableLifecycleAccessToken(fixture, 'http://api-dev.birdcoder.com'), false);
  assert.equal(isUsableLifecycleAccessToken(fixture, 'http://127.0.0.1:8080'), true);
  assert.equal(readLocalBootstrapAccessToken(repoRoot, 'development'), 'signed-dev-token');

  const remote = await applyLifecycleBootstrapAccessToken(
    repoRoot,
    { SDKWORK_BACKEND_BASE_URL: 'http://api-dev.birdcoder.com', SDKWORK_ACCESS_TOKEN: fixture },
    'development',
    { tryApplicationBootstrap: false },
  );
  assert.equal(remote.SDKWORK_ACCESS_TOKEN, 'signed-dev-token');

  const loopback = await applyLifecycleBootstrapAccessToken(
    repoRoot,
    { SDKWORK_BACKEND_BASE_URL: 'http://127.0.0.1:8080' },
    'development',
    { tryApplicationBootstrap: false },
  );
  assert.equal(loopback.SDKWORK_ACCESS_TOKEN, 'signed-dev-token');
});

test('workspace bootstrap profile fills blank backend URL without overriding process env', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-workspace-profile-'));
  const profileDir = path.join(workspaceRoot, 'configs', 'bootstrap', 'profiles');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'dev.env'),
    'SDKWORK_BACKEND_BASE_URL=http://127.0.0.1:8080\nSDKWORK_TENANT_ID=100001\n',
    'utf8',
  );
  const loaded = loadWorkspaceBootstrapProfileEnv('development', workspaceRoot);
  assert.equal(loaded.SDKWORK_BACKEND_BASE_URL, 'http://127.0.0.1:8080');
  assert.equal(loaded.SDKWORK_TENANT_ID, '100001');
});

test('prepareLifecycleAccessTokenEnv keeps an explicit backend URL', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-prepare-token-'));
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'demo-app' }));
  fs.writeFileSync(path.join(repoRoot, 'sdkwork.app.config.json'), JSON.stringify({ app: { key: 'demo' } }));
  fs.writeFileSync(path.join(repoRoot, '.sdkwork.local.env'), 'SDKWORK_ACCESS_TOKEN=signed-dev-token\n', 'utf8');
  const env = await prepareLifecycleAccessTokenEnv(
    repoRoot,
    { SDKWORK_BACKEND_BASE_URL: 'http://api-dev.birdcoder.com' },
    'development',
    { tryApplicationBootstrap: false },
  );
  assert.equal(env.SDKWORK_BACKEND_BASE_URL, 'http://api-dev.birdcoder.com');
  assert.equal(env.SDKWORK_ACCESS_TOKEN, 'signed-dev-token');
});

test('recognizes the CLI through a workspace directory link', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-app-bin-link-'));
  const link = path.join(root, 'app-topology');
  const frameworkRoot = path.resolve('.');
  fs.symlinkSync(frameworkRoot, link, 'junction');
  assert.equal(
    sameModulePath(
      path.join(link, 'scripts', 'sdkwork-app.mjs'),
      path.join(frameworkRoot, 'scripts', 'sdkwork-app.mjs'),
    ),
    true,
  );
});

test('writes a scoped development session and refuses stale sessions', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-app-session-'));
  writeDevelopmentSession(repoRoot, {
    schemaVersion: 1,
    repoRoot,
    supervisorPid: process.pid,
    profileId: 'standalone.development',
    runtimeTarget: 'browser',
  });
  const sessionPath = developmentSessionPath(repoRoot);
  assert.equal(path.relative(repoRoot, sessionPath).startsWith('..'), true);
  assert.equal(sessionPath.includes(path.join('sdkwork', 'sdkwork-app')), true);
  assert.equal(readDevelopmentSession(repoRoot).repoRoot, repoRoot);
  const session = readDevelopmentSession(repoRoot);
  writeDevelopmentSession(repoRoot, { ...session, heartbeatAt: new Date(Date.now() - 60000).toISOString() });
  assert.equal(stopManagedDevelopmentSession(repoRoot), false);
  assert.equal(fs.existsSync(developmentSessionPath(repoRoot)), false);
  removeDevelopmentSession(repoRoot);
});

test('stops only the live supervisor recorded by the scoped development session', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-app-live-stop-'));
  const childPidFile = path.join(repoRoot, 'owned-child.pid');
  const supervisorScript = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const owned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    "fs.writeFileSync(process.argv[1], String(owned.pid));",
    "const stop = () => { try { owned.kill('SIGTERM'); } finally { process.exit(0); } };",
    "process.once('SIGINT', stop);",
    "process.once('SIGTERM', stop);",
    "setInterval(() => {}, 1000);",
  ].join(' ');
  const child = spawn(process.execPath, ['-e', supervisorScript, childPidFile], {
    detached: process.platform === 'win32',
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  try {
    const childPid = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const read = () => {
        if (fs.existsSync(childPidFile)) {
          resolve(Number(fs.readFileSync(childPidFile, 'utf8')));
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error('owned child PID was not registered by supervisor'));
          return;
        }
        setTimeout(read, 25);
      };
      read();
    });
    writeDevelopmentSession(repoRoot, {
      schemaVersion: 1,
      repoRoot,
      supervisorPid: child.pid,
      childPids: [childPid],
      profileId: 'standalone.development',
      runtimeTarget: 'browser',
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    assert.equal(stopManagedDevelopmentSession(repoRoot), true);
    let timeout;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('managed supervisor did not exit')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(child.exitCode !== null || child.signalCode !== null, true);
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => {
        try {
          process.kill(childPid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') {
            resolve();
            return;
          }
          reject(error);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error('owned child process did not exit'));
          return;
        }
        setTimeout(check, 25);
      };
      check();
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    removeDevelopmentSession(repoRoot);
  }
});

test('reclaims recorded children when the supervisor is no longer alive', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-app-orphan-reclaim-'));
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => dead.once('exit', resolve));
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    orphan.once('spawn', resolve);
    orphan.once('error', reject);
  });
  try {
    writeDevelopmentSession(repoRoot, {
      schemaVersion: 1,
      repoRoot,
      supervisorPid: dead.pid,
      childPids: [orphan.pid],
      profileId: 'standalone.development',
      runtimeTarget: 'browser',
    });
    assert.equal(stopManagedDevelopmentSession(repoRoot), false);
    assert.equal(fs.existsSync(developmentSessionPath(repoRoot)), false);
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => {
        try {
          process.kill(orphan.pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') {
            resolve();
            return;
          }
          reject(error);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error('orphaned development child was not reclaimed'));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  } finally {
    try {
      process.kill(orphan.pid, 'SIGTERM');
    } catch {
      // already reclaimed
    }
    removeDevelopmentSession(repoRoot);
  }
});

test('doctor validates manifest, source config, topology, workflow, and deploy contracts as one application fixture', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-app-doctor-'));
  const repoRoot = path.join(workspace, 'sdkwork-drive');
  fs.mkdirSync(repoRoot, { recursive: true });
  const topology = JSON.parse(fs.readFileSync(
    path.resolve('examples', 'sdkwork-drive', 'topology.spec.json'),
    'utf8',
  ));
  topology.profileRoot = 'etc/topology';
  for (const profileId of Object.keys(topology.profileFiles)) {
    topology.profileFiles[profileId] = `etc/topology/${profileId}.env`;
  }
  fs.mkdirSync(path.join(repoRoot, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'etc', 'topology'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'deployments'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'specs', 'topology.spec.json'), JSON.stringify(topology, null, 2));
  for (const profileId of Object.keys(topology.profileFiles)) {
    const source = path.resolve('examples', 'sdkwork-drive', 'etc', 'topology', `${profileId}.env`);
    fs.copyFileSync(source, path.join(repoRoot, 'etc', 'topology', `${profileId}.env`));
  }
  const facade = 'pnpm exec sdkwork-app';
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
    scripts: {
      dev: 'pnpm dev:standalone',
      'dev:standalone': `${facade} dev --deployment-profile standalone`,
      'dev:cloud': `${facade} dev --deployment-profile cloud`,
      stop: `${facade} stop`,
      build: `${facade} build`,
      test: `${facade} test`,
      check: `${facade} check`,
      verify: `${facade} verify`,
      clean: `${facade} clean`,
    },
  }, null, 2));
  fs.writeFileSync(path.join(repoRoot, 'sdkwork.workflow.json'), JSON.stringify({
    schemaVersion: '2026-06-06.sdkwork.workflow.v1',
    app: { id: 'sdkwork-drive', repository: 'sdkwork-ai/sdkwork-drive' },
    release: { artifactPrefix: 'sdkwork-drive', defaultVersion: '1.0.0' },
    targets: [{
      id: 'linux-x64-standalone-server-tar-gz',
      profileBinding: 'fixed',
      deploymentProfile: 'standalone',
      runtimeTarget: 'server',
      profile: 'server',
      platform: 'linux',
      architecture: 'x64',
      formats: ['tar.gz'],
      runner: 'ubuntu-24.04',
      outputGlobs: ['dist/*.tar.gz'],
    }],
  }, null, 2));
  fs.writeFileSync(path.join(repoRoot, 'deployments', 'deploy.yaml'), [
    'version: 2',
    'profile: cloud.production',
    'deployment:',
    '  deploymentProfile: cloud',
    '  environment: production',
    '  deliveryKind: configuration-bundle',
    '  deploymentDriver: nginx',
    '  managementModel: sdkwork-managed',
    '  tenancyModel: multi-tenant',
    '  isolationModel: shared',
    '  networkExposure: public',
    '  rolloutStrategy: rolling',
    '  availabilityMode: high-availability',
    'install:',
    '  layout: binary-package',
    'expose: []',
    'packages: []',
    'overrides: {}',
    '',
  ].join('\n'));

  const workflowKey = 'SDKWORK_GITHUB_WORKFLOW_CLI';
  const deployKey = 'SDKWORK_DEPLOY_CLI';
  const appManifestCheckKey = 'SDKWORK_APP_MANIFEST_CHECK_CLI';
  const sourceConfigCheckKey = 'SDKWORK_SOURCE_CONFIG_CHECK_CLI';
  const standardCheckLogKey = 'SDKWORK_STANDARD_CHECK_LOG';
  const previousWorkflow = process.env[workflowKey];
  const previousDeploy = process.env[deployKey];
  const previousAppManifestCheck = process.env[appManifestCheckKey];
  const previousSourceConfigCheck = process.env[sourceConfigCheckKey];
  const previousStandardCheckLog = process.env[standardCheckLogKey];
  const standardCheckStub = path.join(workspace, 'standard-check.mjs');
  const standardCheckLog = path.join(workspace, 'standard-check.log');
  fs.writeFileSync(standardCheckStub, [
    "import fs from 'node:fs';",
    "fs.appendFileSync(process.env.SDKWORK_STANDARD_CHECK_LOG, `${process.argv.slice(2).join(' ')}\\n`);",
    '',
  ].join('\n'));
  process.env[workflowKey] = path.resolve('..', 'sdkwork-github-workflow', 'scripts', 'sdkwork-workflow.mjs');
  process.env[deployKey] = path.resolve('..', 'sdkwork-specs', 'tools', 'deployctl.mjs');
  process.env[appManifestCheckKey] = standardCheckStub;
  process.env[sourceConfigCheckKey] = standardCheckStub;
  process.env[standardCheckLogKey] = standardCheckLog;
  try {
    await main(['doctor', '--root', repoRoot]);
    assert.deepEqual(
      fs.readFileSync(standardCheckLog, 'utf8').trim().split(/\r?\n/u),
      [`--root ${repoRoot}`, `--root ${repoRoot}`],
    );
  } finally {
    if (previousWorkflow === undefined) delete process.env[workflowKey];
    else process.env[workflowKey] = previousWorkflow;
    if (previousDeploy === undefined) delete process.env[deployKey];
    else process.env[deployKey] = previousDeploy;
    if (previousAppManifestCheck === undefined) delete process.env[appManifestCheckKey];
    else process.env[appManifestCheckKey] = previousAppManifestCheck;
    if (previousSourceConfigCheck === undefined) delete process.env[sourceConfigCheckKey];
    else process.env[sourceConfigCheckKey] = previousSourceConfigCheck;
    if (previousStandardCheckLog === undefined) delete process.env[standardCheckLogKey];
    else process.env[standardCheckLogKey] = previousStandardCheckLog;
  }
});

test('release publication cannot bypass the workflow contract through a private hook', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-app-release-'));
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
    scripts: {
      '_sdkwork:release:publish': 'node -e "process.exit(0)"',
    },
  }));
  await assert.rejects(
    () => main(['release:publish', '--root', repoRoot, '--target-id', 'web-universal-cloud-browser-web-url']),
    /sdkwork\.workflow\.json is required/u,
  );
});

test('creates a workflow deploy invocation from immutable artifact evidence', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkwork-app-workflow-deploy-'));
  const evidencePath = path.join(repoRoot, '.sdkwork', 'evidence', 'demo.json');
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify({
    artifactId: 'demo-0.1.0',
    digest: `sha256:${'a'.repeat(64)}`,
  }));
  const args = createWorkflowDeployArgs(repoRoot, {
    SDKWORK_DEPLOYMENT_PROFILE: 'standalone',
    SDKWORK_DEPLOY_ENVIRONMENT: 'production',
    SDKWORK_ARTIFACT_EVIDENCE_PATH: path.relative(repoRoot, evidencePath),
    SDKWORK_DEPLOY_ROLLBACK_TARGET: 'release-0.0.9',
    SDKWORK_DEPLOY_APPROVAL_REF: 'change-1234',
  });
  assert.deepEqual(args.slice(0, 4), ['--profile', 'standalone.production', '--environment', 'production']);
  assert.ok(args.includes('demo-0.1.0'));
  assert.ok(args.includes('release-0.0.9'));
  assert.ok(args.includes('change-1234'));
});

test('resolves framework CLIs from explicit non-workspace overrides', () => {
  const key = 'SDKWORK_TEST_FRAMEWORK_CLI';
  const previous = process.env[key];
  process.env[key] = path.join('tooling', 'framework.mjs');
  try {
    assert.equal(frameworkCliPath(key, 'fallback.mjs'), path.resolve('tooling', 'framework.mjs'));
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});
