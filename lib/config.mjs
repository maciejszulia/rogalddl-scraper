import { join, resolve } from 'node:path';
import { ensurePrivateFile, readJson } from './io.mjs';
import { normalizeOverrides } from './dedupe.mjs';

export const DEFAULT_SETTINGS = Object.freeze({
  queryBudget: 60,
  resultLimit: 25,
  secondPass: true,
  secondPassLimit: 30,
  secondPassResultLimit: 15,
  enrichmentLimit: 20,
  concurrency: 2,
  timeoutMs: 120000,
  fingerprintTimeoutMs: 300000,
  fingerprintMaxBytes: 64 * 1024 * 1024,
  retries: 2,
  fingerprintMode: 'candidates',
  useCache: true,
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
  refreshFingerprints: false,
  ytDlpBinary: 'yt-dlp',
  mpvBinary: 'mpv',
  fpcalcBinary: 'fpcalc',
  ffmpegBinary: 'ffmpeg',
  audioOnly: true,
  loop: true,
  shuffle: false,
});

const INTEGER_LIMITS = {
  queryBudget: [1, 10000],
  resultLimit: [1, 500],
  secondPassLimit: [0, 1000],
  secondPassResultLimit: [1, 500],
  enrichmentLimit: [0, 100],
  concurrency: [1, 16],
  timeoutMs: [1000, 30 * 60 * 1000],
  fingerprintTimeoutMs: [1000, 60 * 60 * 1000],
  fingerprintMaxBytes: [1024 * 1024, 1024 * 1024 * 1024],
  retries: [0, 10],
  cacheTtlMs: [0, 365 * 24 * 60 * 60 * 1000],
};
const BOOLEAN_FIELDS = ['secondPass', 'useCache', 'refreshFingerprints', 'audioOnly', 'loop', 'shuffle'];
const BINARY_FIELDS = ['ytDlpBinary', 'mpvBinary', 'fpcalcBinary', 'ffmpegBinary'];
const FINGERPRINT_MODES = new Set(['metadata-only', 'candidates', 'fingerprint-all', 'segments']);

export function getPaths(env = process.env) {
  const home = env.HOME;
  const dataHome = env.XDG_DATA_HOME || (home ? join(home, '.local', 'share') : null);
  const configHome = env.XDG_CONFIG_HOME || (home ? join(home, '.config') : null);
  const cacheHome = env.XDG_CACHE_HOME || (home ? join(home, '.cache') : null);
  if (!dataHome || !configHome || !cacheHome) {
    throw new Error('HOME is required only when XDG_DATA_HOME, XDG_CONFIG_HOME, or XDG_CACHE_HOME is unset');
  }
  const dataDir = resolve(dataHome, 'rogalddl');
  const configDir = resolve(configHome, 'rogalddl');
  const cacheDir = resolve(cacheHome, 'rogalddl');
  return {
    dataDir,
    configDir,
    cacheDir,
    configFile: join(configDir, 'config.json'),
    overridesFile: join(configDir, 'overrides.json'),
  };
}

function validateSettings(settings) {
  for (const [field, [minimum, maximum]] of Object.entries(INTEGER_LIMITS)) {
    const value = settings[field];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new TypeError(`${field} must be an integer from ${minimum} to ${maximum}`);
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof settings[field] !== 'boolean') throw new TypeError(`${field} must be boolean`);
  }
  for (const field of BINARY_FIELDS) {
    if (typeof settings[field] !== 'string' || !settings[field].trim() || /[\r\n\0]/.test(settings[field])) {
      throw new TypeError(`${field} must be a non-empty executable name or path`);
    }
  }
  if (!FINGERPRINT_MODES.has(settings.fingerprintMode)) {
    throw new TypeError(`unsupported fingerprint mode: ${settings.fingerprintMode}`);
  }
  return settings;
}

export function mergeSettings(fileSettings = {}, cliSettings = {}) {
  if (!fileSettings || typeof fileSettings !== 'object' || Array.isArray(fileSettings)) throw new TypeError('config must be a JSON object');
  if (!cliSettings || typeof cliSettings !== 'object' || Array.isArray(cliSettings)) throw new TypeError('CLI settings must be an object');
  const knownSettings = new Set(Object.keys(DEFAULT_SETTINGS));
  const unknownConfig = Object.keys(fileSettings).filter((key) => !knownSettings.has(key));
  if (unknownConfig.length) throw new TypeError(`unknown config setting: ${unknownConfig.sort().join(', ')}`);
  const unknownCli = Object.keys(cliSettings).filter((key) => !knownSettings.has(key));
  if (unknownCli.length) throw new TypeError(`unknown CLI setting: ${unknownCli.sort().join(', ')}`);
  const settings = { ...DEFAULT_SETTINGS, ...fileSettings, ...cliSettings };
  return validateSettings(settings);
}

export async function loadConfiguration(paths, cliSettings = {}) {
  await ensurePrivateFile(paths.configFile, { allowMissing: true });
  await ensurePrivateFile(paths.overridesFile, { allowMissing: true });
  const fileSettings = await readJson(paths.configFile, {});
  const overrides = await readJson(paths.overridesFile, {
    schemaVersion: 1,
    keep: [],
    merge: [],
    reject: [],
  });
  if (!overrides || typeof overrides !== 'object' || overrides.schemaVersion !== 1) {
    throw new TypeError('overrides.json must be an object with schemaVersion 1');
  }
  const allowedOverrideKeys = new Set(['schemaVersion', 'keep', 'merge', 'reject']);
  const unknownOverrideKeys = Object.keys(overrides).filter((key) => !allowedOverrideKeys.has(key));
  if (unknownOverrideKeys.length) throw new TypeError(`unknown overrides.json setting: ${unknownOverrideKeys.sort().join(', ')}`);
  for (const field of ['keep', 'merge', 'reject']) {
    if (!Array.isArray(overrides[field])) throw new TypeError(`${field} overrides must be an array`);
  }
  return { settings: mergeSettings(fileSettings, cliSettings), overrides: normalizeOverrides(overrides) };
}
