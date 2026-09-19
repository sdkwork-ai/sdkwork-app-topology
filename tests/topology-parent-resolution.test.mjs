import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEPLOYMENT_CONFIG_RELATIVE_PATH,
  TOPOLOGY_SPEC_RELATIVE_PATH,
  resolveTopologyLocation,
} from '../tools/topology/lib/topology-location.mjs';

const SDKWORK_APP = path.resolve('scripts', 'sdkwork-app.mjs');
const EXAMPLE_ROOT = path.resolve('examples', 'sdkwork-drive');

function temporaryRepo(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeApplicationTopology(repoRoot) {
  const topology = JSON.parse(
    fs.readFileSync(path.join(EXAMPLE_ROOT, 'topology.spec.json'), 'utf8'),
  );
  topology.profileRoot = 'etc/topology';
  for (const profileId of Object.keys(topology.profileFiles)) {
    topology.profileFiles[profileId] = `etc/topology/${profileId}.env`;
  }
  fs.mkdirSync(path.join(repoRoot, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'etc', 'topology'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, TOPOLOGY_SPEC_RELATIVE_PATH),
    JSON.stringify(topology, null, 2),
  );
  for (const profileId of Object.keys(topology.profileFiles)) {
    fs.copyFileSync(
      path.join(EXAMPLE_ROOT, 'etc', 'topology', `${profileId}.env`),
      path.join(repoRoot, 'etc', 'topology', `${profileId}.env`),
    );
  }
}

function writeClientRoot(repoRoot, { parentTopologySpec } = {}) {
  const appRoot = path.join(repoRoot, 'apps', 'sdkwork-drive-h5');
  fs.mkdirSync(path.join(appRoot, 'etc'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'drive-h5' }, null, 2));
  const config = {};
  if (parentTopologySpec !== undefined) config.parentTopologySpec = parentTopologySpec;
  fs.writeFileSync(
    path.join(appRoot, DEPLOYMENT_CONFIG_RELATIVE_PATH),
    JSON.stringify(config, null, 2),
  );
  return appRoot;
}

test('a component root that owns a topology keeps it local', () => {
  const repoRoot = temporaryRepo('sdkwork-topology-local-');
  writeApplicationTopology(repoRoot);

  const location = resolveTopologyLocation(repoRoot);

  assert.equal(location.specPath, path.join(repoRoot, TOPOLOGY_SPEC_RELATIVE_PATH));
  assert.equal(location.topologyRoot, repoRoot);
  assert.equal(location.inherited, false);
});

test('a client root resolves the parent topology declared in its deployment config', () => {
  const repoRoot = temporaryRepo('sdkwork-topology-parent-');
  writeApplicationTopology(repoRoot);
  const appRoot = writeClientRoot(repoRoot, { parentTopologySpec: '../../../specs/topology.spec.json' });

  const location = resolveTopologyLocation(appRoot);

  assert.equal(location.specPath, path.join(repoRoot, TOPOLOGY_SPEC_RELATIVE_PATH));
  assert.equal(location.topologyRoot, repoRoot);
  assert.equal(location.inherited, true);
  assert.equal(fs.existsSync(path.join(appRoot, TOPOLOGY_SPEC_RELATIVE_PATH)), false);
});

test('an unrelated local topology still wins over a declared parent', () => {
  const repoRoot = temporaryRepo('sdkwork-topology-both-');
  writeApplicationTopology(repoRoot);
  const appRoot = writeClientRoot(repoRoot, { parentTopologySpec: '../../../specs/topology.spec.json' });
  fs.mkdirSync(path.join(appRoot, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, TOPOLOGY_SPEC_RELATIVE_PATH), '{}');

  const location = resolveTopologyLocation(appRoot);

  assert.equal(location.specPath, path.join(appRoot, TOPOLOGY_SPEC_RELATIVE_PATH));
  assert.equal(location.topologyRoot, appRoot);
  assert.equal(location.inherited, false);
});

test('a declared parent that does not exist fails loudly', () => {
  const repoRoot = temporaryRepo('sdkwork-topology-missing-parent-');
  const appRoot = writeClientRoot(repoRoot, { parentTopologySpec: '../../../specs/topology.spec.json' });

  assert.throws(
    () => resolveTopologyLocation(appRoot),
    /parent topology spec not found/,
  );
});

test('a client root without a local topology or a parent declaration fails loudly', () => {
  const repoRoot = temporaryRepo('sdkwork-topology-bare-');
  writeApplicationTopology(repoRoot);
  const appRoot = writeClientRoot(repoRoot);

  assert.throws(
    () => resolveTopologyLocation(appRoot),
    /topology spec not found/,
  );
});

test('a parent topology outside a specs directory is rejected', () => {
  const repoRoot = temporaryRepo('sdkwork-topology-shape-');
  writeApplicationTopology(repoRoot);
  fs.mkdirSync(path.join(repoRoot, 'etc', 'shared'), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, TOPOLOGY_SPEC_RELATIVE_PATH),
    path.join(repoRoot, 'etc', 'shared', 'topology.spec.json'),
  );
  const appRoot = writeClientRoot(repoRoot, { parentTopologySpec: '../../../etc/shared/topology.spec.json' });

  assert.throws(
    () => resolveTopologyLocation(appRoot),
    /must live under a specs\/ directory/,
  );
});

test('sdkwork-app validates a client root through its declared parent topology', () => {
  const repoRoot = temporaryRepo('sdkwork-topology-cli-');
  writeApplicationTopology(repoRoot);
  const appRoot = writeClientRoot(repoRoot, { parentTopologySpec: '../../../specs/topology.spec.json' });

  const result = spawnSync(
    process.execPath,
    [SDKWORK_APP, 'topology:validate', '--root', appRoot],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /topology v5 valid/u);
});
