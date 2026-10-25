#!/usr/bin/env node
/**
 * Generic cloud gateway config bundle for SDKWork application repositories.
 * See APPLICATION_GATEWAY_SPEC.md and APP_RUNTIME_TOPOLOGY_SPEC.md.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return `Usage: node gateway-cloud-bundle.mjs <bundle|validate> [--root <path>] [--spec <path>] [--version <value>]

Bundle application-owned sdkwork-api-cloud-gateway route configs for cloud topology deployment.`;
}

function resolveCloudConfigFiles(spec, repoRoot) {
  const fromPackaging = spec.packaging?.cloudConfigFiles ?? [];
  if (fromPackaging.length > 0) return fromPackaging;

  const glob = spec.components?.cloudGateway?.configGlob ?? '';
  const match = /sdkwork-api-cloud-gateway\.([^.]+)\.\{profile\}/.exec(glob);
  const slug = match?.[1] ?? spec.appId?.replace(/^sdkwork-/, '') ?? 'app';
  return [
    `sdkwork-api-cloud-gateway.${slug}.development.toml`,
    `sdkwork-api-cloud-gateway.${slug}.production.toml`,
  ];
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      spec: { type: 'string', default: 'specs/topology.spec.json' },
      version: { type: 'string' },
      format: { type: 'string', default: 'tar.gz' },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    console.log(usage());
    return;
  }

  const command = positionals[0] ?? 'bundle';
  const repoRoot = path.resolve(values.root ?? process.cwd());
  const specPath = path.join(repoRoot, values.spec);
  const spec = JSON.parse(await readFile(specPath, 'utf8'));
  const appId = spec.appId ?? path.basename(repoRoot);
  const configFiles = resolveCloudConfigFiles(spec, repoRoot);

  const manifestPath = path.join(repoRoot, 'agent.app.config.json');
  const manifest = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, 'utf8'))
    : {};
  const version =
    values.version ??
    process.env.SDKWORK_PACKAGE_VERSION ??
    manifest.release?.currentVersion ??
    manifest.release?.version ??
    '0.0.0-dev';

  const stageRoot = path.join(repoRoot, 'dist', 'cloud-config', '.stage');
  const stageName = `${appId}-api-gateway-config-${version}`;
  const archivePath = path.join(repoRoot, 'dist', 'cloud-config', `${stageName}.${values.format}`);

  if (command === 'bundle') {
    await rm(stageRoot, { recursive: true, force: true });
    const configDir = path.join(stageRoot, stageName, 'etc');
    await mkdir(configDir, { recursive: true });

    for (const configName of configFiles) {
      const source = path.join(repoRoot, 'etc', configName);
      if (!existsSync(source)) {
        throw new Error(`Missing cloud gateway config: ${source}`);
      }
      await copyFile(source, path.join(configDir, configName));
    }

    const readme = `# ${appId} Cloud Gateway Config Bundle

Version: ${version}

These TOML files configure sdkwork-api-cloud-gateway for ${appId} cloud topology.
Build and deploy the gateway binary from the sdkwork-api-cloud-gateway repository.

Included configuration:
${configFiles.map((name) => `- etc/${name}`).join('\n')}
`;
    await writeFile(path.join(stageRoot, stageName, 'README.md'), readme, 'utf8');
    await mkdir(path.dirname(archivePath), { recursive: true });

    const tarResult = spawnSync('tar', ['-czf', archivePath, '-C', stageRoot, stageName], {
      stdio: 'inherit',
    });
    if (tarResult.status !== 0) {
      throw new Error(`Failed to create archive: ${archivePath}`);
    }

    const archiveBytes = await readFile(archivePath);
    const digest = createHash('sha256').update(archiveBytes).digest('hex');
    await writeFile(`${archivePath}.sha256`, `${digest}  ${path.basename(archivePath)}\n`, 'utf8');
    console.log(`[gateway-cloud-bundle] wrote ${archivePath}`);
    console.log(`[gateway-cloud-bundle] sha256 ${digest}`);
    return;
  }

  if (command === 'validate') {
    for (const configName of configFiles) {
      const source = path.join(repoRoot, 'etc', configName);
      if (!existsSync(source)) {
        throw new Error(`Missing cloud gateway config: ${source}`);
      }
    }
    if (!existsSync(archivePath)) {
      console.log(`[gateway-cloud-bundle] validated ${configFiles.length} cloud gateway config file(s)`);
      return;
    }
    const digestPath = `${archivePath}.sha256`;
    if (!existsSync(digestPath)) {
      throw new Error(`Checksum file not found: ${digestPath}`);
    }
    const archiveBytes = await readFile(archivePath);
    const digest = createHash('sha256').update(archiveBytes).digest('hex');
    const recorded = (await readFile(digestPath, 'utf8')).trim().split(/\s+/u)[0];
    if (digest !== recorded) {
      throw new Error(`Checksum mismatch for ${archivePath}`);
    }
    for (const configName of configFiles) {
      const source = path.join(repoRoot, 'etc', configName);
      if (!existsSync(source)) {
        throw new Error(`Missing cloud gateway config: ${source}`);
      }
    }
    console.log(`[gateway-cloud-bundle] validated configuration and ${archivePath}`);
    return;
  }

  throw new Error(`Unsupported command: ${command}`);
}

main().catch((error) => {
  console.error(`[gateway-cloud-bundle] ${error.message}`);
  process.exit(1);
});
