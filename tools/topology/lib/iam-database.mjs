import { ensurePostgresDevEnvFile, loadEnvFile, normalizeText } from './env-file.mjs';
import { isTcpPortReachable } from './postgres.mjs';
import {
  resolveCloudDatabaseEnv,
  resolveCloudDatabaseUrlFromEnv,
} from './cloud-database.mjs';

export function createIamDatabaseHelpers(spec) {
  function resolveIamDatabaseEnv(env) {
    return resolveCloudDatabaseEnv({ ...env });
  }

  function describeIamDatabaseTarget(env) {
    const url = normalizeText(env.SDKWORK_DATABASE_URL);
    if (url) {
      try {
        const parsed = new URL(url);
        const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
        return `${parsed.hostname}:${parsed.port || '5432'}/${database}`;
      } catch {
        return url;
      }
    }

    const host = normalizeText(env.SDKWORK_DATABASE_HOST);
    const port = normalizeText(env.SDKWORK_DATABASE_PORT) || '5432';
    const database = normalizeText(env.SDKWORK_DATABASE_NAME);
    if (host && database) {
      return `${host}:${port}/${database}`;
    }
    return 'unknown';
  }

  function applicationBootstrapEnvAliases(repoRoot, env = {}) {
    if (!repoRoot) {
      return {};
    }

    const resolvedAppRoot = normalizeText(env.SDKWORK_APP_ROOT) || repoRoot;
    const aliases = {
      SDKWORK_APP_ROOT: resolvedAppRoot,
      SDKWORK_IAM_APP_ROOT: normalizeText(env.SDKWORK_IAM_APP_ROOT) || resolvedAppRoot,
    };

    const appId = normalizeText(spec.appId);
    if (appId) {
      const slug = appId.startsWith('sdkwork-') ? appId.slice('sdkwork-'.length) : appId;
      const aliasKey = `SDKWORK_${slug.replace(/-/g, '_').toUpperCase()}_APP_ROOT`;
      if (!normalizeText(env[aliasKey])) {
        aliases[aliasKey] = resolvedAppRoot;
      }
    }

    return aliases;
  }

  async function assertPostgresReachableForIam(env, options = {}) {
    const url = normalizeText(env.SDKWORK_DATABASE_URL)
      || resolveCloudDatabaseUrlFromEnv(env);
    if (!url) {
      throw new Error(
        options.missingDatabaseMessage
          ?? 'IAM requires PostgreSQL for dev login. Configure config/host/postgres.env with SDKWORK_DATABASE_* and start PostgreSQL.',
      );
    }

    let host = '127.0.0.1';
    let port = 5432;
    try {
      const parsed = new URL(url);
      host = parsed.hostname || host;
      port = Number(parsed.port || '5432');
    } catch {
      // keep defaults
    }

    if (!(await isTcpPortReachable(port, host))) {
      throw new Error(
        options.unreachableDatabaseMessage
          ?? `PostgreSQL is not reachable at ${host}:${port} (IAM database).`,
      );
    }
  }

  function resolveIamDevEnv(env = process.env, repoRoot, options = {}) {
    const postgresFile = options.postgresEnvFile ?? 'config/host/postgres.env';
    if (options.ensurePostgresEnvFile !== false) {
      ensurePostgresDevEnvFile(repoRoot, {
        envFile: postgresFile,
        stdout: options.stdout,
      });
    }
    const postgresEnv = loadEnvFile(postgresFile, repoRoot);

    const runtimeWithoutDatabase = { ...env };
    for (const key of Object.keys(runtimeWithoutDatabase)) {
      if (/^SDKWORK_(?!DATABASE_)[A-Z0-9_]+_DATABASE_/u.test(key)) {
        throw new Error(`${key} is retired; use SDKWORK_DATABASE_*`);
      }
      const processDatabaseControl = key.startsWith('SDKWORK_DATABASE_TEMPORARY_');
      if (
        !processDatabaseControl
        && key.startsWith('SDKWORK_DATABASE_')
      ) {
        delete runtimeWithoutDatabase[key];
      }
    }

    return resolveIamDatabaseEnv({
      ...postgresEnv,
      ...applicationBootstrapEnvAliases(repoRoot, env),
      ...runtimeWithoutDatabase,
    });
  }

  return {
    resolveIamDatabaseEnv,
    describeIamDatabaseTarget,
    assertPostgresReachableForIam,
    resolveIamDevEnv,
  };
}
