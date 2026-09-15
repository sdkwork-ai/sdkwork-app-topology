import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createProcessLaunchError } from './process-diagnostics.mjs';

const PROCESS_INVOCATION = Symbol('sdkwork.lifecycle.process-invocation');

export const PUBLIC_LIFECYCLE_COMMANDS = Object.freeze([
  'build', 'test', 'check', 'verify', 'clean', 'stop',
]);

function facadeCommand(value, command) {
  return new RegExp(`sdkwork-app(?:\\.mjs)?\\s+${command.replaceAll(':', '\\:')}(?:\\s|$)`, 'u').test(String(value ?? ''));
}

export function validateLifecyclePackage(packageManifest) {
  const scripts = packageManifest?.scripts ?? {};
  const issues = [];
  if (!/^(?:pnpm\s+(?:run\s+)?dev:standalone)$/u.test(String(scripts.dev ?? '').trim())) {
    issues.push('scripts.dev must delegate exactly to pnpm dev:standalone');
  }
  if (!facadeCommand(scripts['dev:standalone'], 'dev') || !/--deployment-profile\s+standalone/u.test(scripts['dev:standalone'])) {
    issues.push('scripts.dev:standalone must use sdkwork-app dev --deployment-profile standalone');
  }
  if (!facadeCommand(scripts['dev:cloud'], 'dev') || !/--deployment-profile\s+cloud/u.test(scripts['dev:cloud'])) {
    issues.push('scripts.dev:cloud must use sdkwork-app dev --deployment-profile cloud');
  }
  for (const command of PUBLIC_LIFECYCLE_COMMANDS) {
    if (!facadeCommand(scripts[command], command)) issues.push(`scripts.${command} must use sdkwork-app ${command}`);
  }
  if (scripts['_sdkwork:stop']) {
    issues.push('private _sdkwork:stop is forbidden; declare owned bindings and managed resources in topology');
  }
  return issues;
}

export function privateLifecycleScript(command, deploymentProfile) {
  if (command === 'dev') return `_sdkwork:dev:${deploymentProfile}`;
  return `_sdkwork:${command}`;
}

export function resolveProcessInvocation(process) {
  if (process.package && process.script) {
    return {
      command: 'pnpm',
      args: ['--filter', process.package, 'run', process.script],
    };
  }
  if (process.script) return { command: 'pnpm', args: ['run', process.script] };
  if (process.command) return { command: process.command, args: process.args ?? [] };
  if (process.crate) {
    return {
      command: 'cargo',
      args: ['run', '-p', process.crate, ...(process.binary ? ['--bin', process.binary] : [])],
    };
  }
  return null;
}

const PNPM_JS_CLI_PATTERN = /(?:^|[\\/])pnpm(?:\.[cm])?js$/iu;
const PNPM_NATIVE_CLI_PATTERN = /(?:^|[\\/])pnpm(?:\.exe)?$/iu;

function firstExistingFile(candidates) {
  return candidates.find((candidate) => typeof candidate === 'string'
    && fs.existsSync(candidate)
    && fs.statSync(candidate).isFile()) ?? null;
}

export function platformLifecycleInvocation(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  if (platform !== 'win32' || command !== 'pnpm') return { command, args };

  const execpath = typeof env.npm_execpath === 'string' ? env.npm_execpath : null;

  // npm / corepack 安装形态：npm_execpath 指向 pnpm 的 JavaScript CLI（.cjs，pnpm 11 起
  // 也可能是 .mjs）。Windows 上 .js 入口不可直接执行，必须交给 node。
  if (execpath && PNPM_JS_CLI_PATTERN.test(execpath) && fs.existsSync(execpath)) {
    return { command: nodeExecutable, args: [execpath, ...args] };
  }

  // standalone / `pnpm tools` / @pnpm/exe 安装形态：npm_execpath 指向原生可执行文件
  // （`...\@pnpm\exe\pnpm.exe`，或 `.tools\pnpm\<version>\node_modules\pnpm\pnpm` 这种
  // 不带扩展名的 44MB 二进制）。这类形态下 pnpm.cjs 根本不存在，也不需要用：
  // shell:false 可直接 spawn 原生二进制。缺扩展名时补 .exe 再探一次。
  if (execpath && PNPM_NATIVE_CLI_PATTERN.test(execpath)) {
    const native = firstExistingFile([execpath, `${execpath}.exe`]);
    if (native) return { command: native, args };
  }

  // 兜底：PNPM_HOME 或 node 安装目录下一层的 pnpm JavaScript CLI。
  const fallback = firstExistingFile([
    env.PNPM_HOME ? path.join(env.PNPM_HOME, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs') : null,
    path.join(path.dirname(nodeExecutable), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  ]);
  if (!fallback) {
    throw new Error('cannot resolve the pnpm executable for shell-free Windows lifecycle execution: '
      + 'npm_execpath is absent or points at nothing spawnable and no pnpm.cjs fallback exists; '
      + 'reinstall pnpm with `npm i -g pnpm` or fix npm_execpath');
  }
  return { command: nodeExecutable, args: [fallback, ...args] };
}

export function spawnLifecycleCommand(command, args, options = {}) {
  const processInvocation = {
    processId: options.processId,
    processRole: options.processRole,
    command,
    args: [...args],
    cwd: options.cwd,
    environment: options.env,
  };
  let invocation;
  try {
    invocation = platformLifecycleInvocation(command, args, { env: options.env });
  } catch (error) {
    throw createProcessLaunchError(error, processInvocation);
  }
  processInvocation.effectiveCommand = invocation.command;
  processInvocation.effectiveArgs = [...invocation.args];
  let child;
  try {
    child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? 'inherit',
      shell: false,
      detached: options.detached ?? false,
      windowsHide: true,
    });
  } catch (error) {
    throw createProcessLaunchError(error, processInvocation);
  }
  child[PROCESS_INVOCATION] = processInvocation;
  return child;
}

export function waitForLifecycleCommand(child) {
  return new Promise((resolve, reject) => {
    child.once('error', (error) => {
      reject(createProcessLaunchError(error, child[PROCESS_INVOCATION] ?? {}));
    });
    child.once('exit', (code, signal) => resolve({
      code: code ?? 1,
      signal,
      invocation: child[PROCESS_INVOCATION],
    }));
  });
}

export async function runPrivateLifecycleScript(repoRoot, packageManifest, scriptName, args = [], options = {}) {
  if (!packageManifest.scripts?.[scriptName]) return null;
  const child = spawnLifecycleCommand('pnpm', ['run', scriptName, ...(args.length > 0 ? ['--', ...args] : [])], {
    cwd: repoRoot,
    env: options.env ?? process.env,
    processId: scriptName,
    processRole: 'lifecycle-hook',
  });
  return waitForLifecycleCommand(child);
}

export { formatLifecycleError, LifecycleProcessError } from './process-diagnostics.mjs';

export function loadPackageManifest(repoRoot) {
  const packagePath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(packagePath)) throw new Error(`missing ${packagePath}`);
  return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
}
