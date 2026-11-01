/**
 * Reader for the user-private bootstrap credential bundle.
 *
 * `IAM_APPLICATION_BOOTSTRAP_SPEC.md` section 5.4.1 stores the reusable
 * bootstrap token outside every checkout:
 *
 * ```text
 * ~/.sdkwork/<application-code>/credentials/<profile-id>.json
 * ```
 *
 * `ENVIRONMENT_SPEC.md` section 5.1.7 retires every composed env-file overlay,
 * so a repository file never carries a credential. This module is the
 * dependency-free read path the launcher uses when the sibling
 * `@sdkwork/iam-credential-entry/node-bootstrap` module cannot be resolved.
 *
 * @module
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Store directory under the home directory. */
export const CREDENTIAL_STORE_DIRECTORY = '.sdkwork';

/** Sub-directory of the store that holds the bundles. */
export const CREDENTIAL_BUNDLE_DIRECTORY = 'credentials';

/**
 * Normalize an application code for use as a directory name: the manifest
 * `app.key` carries a vendor prefix, the store path uses the bare code.
 * @param {string} value manifest `app.key` or any operator-supplied code.
 * @returns {string} a lower-case, path-safe application code.
 */
export function normalizeApplicationCode(value) {
  const trimmed = String(value ?? '').trim().toLowerCase().replace(/^sdkwork[-_]/u, '');
  const sanitized = trimmed.replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return sanitized === '' ? 'application' : sanitized;
}

/**
 * Resolve the application code of a repository: the manifest `app.key`, or the
 * bare directory name for a checkout without a manifest.
 * @param {string} repoRoot repository root.
 * @returns {string} the normalized application code.
 */
export function resolveApplicationCode(repoRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'agent.app.config.json'), 'utf8'));
    const key = typeof manifest?.app?.key === 'string' ? manifest.app.key : '';
    if (key.trim() !== '') return normalizeApplicationCode(key);
  } catch {
    // A harness without a manifest still resolves a stable directory name.
  }
  return normalizeApplicationCode(path.basename(path.resolve(repoRoot)));
}

/**
 * The credential bundle path of one profile id.
 * @param {object} options home directory, application code, and exact profile id.
 * @param {string} options.applicationCode normalized application code.
 * @param {string} options.profileId exact two-segment profile id.
 * @param {string} [options.homeDir] home directory; defaults to the current user's.
 * @returns {string} the absolute bundle path.
 */
export function credentialBundlePath({ applicationCode, profileId, homeDir = os.homedir() }) {
  return path.resolve(
    homeDir,
    CREDENTIAL_STORE_DIRECTORY,
    normalizeApplicationCode(applicationCode),
    CREDENTIAL_BUNDLE_DIRECTORY,
    `${profileId}.json`,
  );
}

/**
 * Read the `accessToken` of a bundle.
 * @param {string} bundlePath absolute bundle path.
 * @returns {string|undefined} the token, or `undefined` when the file is absent,
 * unreadable, or carries no token.
 */
export function readCredentialBundleToken(bundlePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const token = typeof parsed.accessToken === 'string' ? parsed.accessToken.trim() : '';
  return token === '' ? undefined : token;
}
