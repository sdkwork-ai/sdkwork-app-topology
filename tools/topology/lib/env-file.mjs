import fs from 'node:fs';
import path from 'node:path';

export function normalizeText(value) {
  const normalized = String(value ?? '').trim();
  return normalized || undefined;
}

export function ensurePostgresDevEnvFile(repoRoot, {
  envFile = 'config/host/postgres.env',
  stdout,
} = {}) {
  const envFilePath = path.isAbsolute(envFile) ? envFile : path.resolve(repoRoot, envFile);
  if (fs.existsSync(envFilePath)) {
    return envFilePath;
  }
  const examplePath = `${envFilePath}.example`;
  if (!fs.existsSync(examplePath)) {
    return envFilePath;
  }
  fs.copyFileSync(examplePath, envFilePath);
  if (stdout) {
    stdout.write(
      `[sdkwork-postgres] created ${path.basename(envFilePath)} from ${path.basename(examplePath)}; `
      + 'edit database credentials once, then app startup and db:* commands stay aligned\n',
    );
  }
  return envFilePath;
}

export function loadEnvFile(envFile, repoRoot, options = {}) {
  if (!envFile) {
    return {};
  }
  const resolved = path.isAbsolute(envFile) ? envFile : path.resolve(repoRoot, envFile);
  if (!fs.existsSync(resolved)) {
    const example = `${resolved}.example`;
    if (!fs.existsSync(example)) {
      return {};
    }
    return loadEnvFile(example, repoRoot, options);
  }

  const values = {};
  for (const rawLine of fs.readFileSync(resolved, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function mergeRuntimeEnv(...layers) {
  return layers.reduce((merged, layer) => ({ ...merged, ...(layer ?? {}) }), {});
}

export function parseBooleanEnv(value, defaultValue) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return defaultValue;
  }
  if (['1', 'true', 'on', 'yes'].includes(normalized.toLowerCase())) {
    return true;
  }
  if (['0', 'false', 'off', 'no'].includes(normalized.toLowerCase())) {
    return false;
  }
  return defaultValue;
}

export function writeEnvFile(filePath, entries) {
  const lines = [];
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    lines.push(`${key}=${value}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}
