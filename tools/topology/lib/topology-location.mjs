import fs from 'node:fs';
import path from 'node:path';

export const TOPOLOGY_SPEC_RELATIVE_PATH = path.join('specs', 'topology.spec.json');
export const DEPLOYMENT_CONFIG_RELATIVE_PATH = path.join('etc', 'sdkwork.deployment.config.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
}

function resolveDeclaredParent(root, configPath) {
  let config;
  try {
    config = readJson(configPath);
  } catch (error) {
    throw new Error(
      `invalid deployment config ${path.relative(root, configPath) || configPath}: ${error.message}`,
    );
  }
  const declared = typeof config?.parentTopologySpec === 'string'
    ? config.parentTopologySpec.trim()
    : '';
  if (!declared) return null;

  const specPath = path.resolve(path.dirname(configPath), declared);
  if (!fs.existsSync(specPath)) {
    throw new Error(
      `parent topology spec not found: ${specPath}`
        + ` (declared by ${path.relative(root, configPath) || configPath})`,
    );
  }
  if (path.basename(path.dirname(specPath)) !== 'specs') {
    throw new Error(
      `parent topology spec must live under a specs/ directory: ${specPath}`,
    );
  }
  return specPath;
}

/**
 * Resolve which topology spec an application root must load, and which root owns
 * it. A component root owns `specs/topology.spec.json` directly; a client root
 * that declares `etc/sdkwork.deployment.config.json#parentTopologySpec` defers to
 * that parent instead of forking a second topology. Topology-relative paths
 * (`profileFiles`, `applicationRoot`) always resolve against the owning root.
 */
export function resolveTopologyLocation(root) {
  const repoRoot = path.resolve(root);
  const localSpecPath = path.join(repoRoot, TOPOLOGY_SPEC_RELATIVE_PATH);
  if (fs.existsSync(localSpecPath)) {
    return { specPath: localSpecPath, topologyRoot: repoRoot, inherited: false };
  }

  const configPath = path.join(repoRoot, DEPLOYMENT_CONFIG_RELATIVE_PATH);
  if (!fs.existsSync(configPath)) {
    throw new Error(`topology spec not found: ${localSpecPath}`);
  }
  const inheritedSpecPath = resolveDeclaredParent(repoRoot, configPath);
  if (!inheritedSpecPath) {
    throw new Error(`topology spec not found: ${localSpecPath}`);
  }
  return {
    specPath: inheritedSpecPath,
    topologyRoot: path.dirname(path.dirname(inheritedSpecPath)),
    inherited: true,
  };
}
