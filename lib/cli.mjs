import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { buildArtifacts, renderPlaylist } from './catalog.mjs';
import { DEFAULT_SETTINGS, getPaths, loadConfiguration } from './config.mjs';
import { atomicWriteFile, atomicWriteJson, ensurePrivateDirectory, pathExists, readJson } from './io.mjs';
import { runScanPipeline } from './pipeline.mjs';
import { playPlaylist, sendMpvCommand } from './player.mjs';
import { runProcess } from './process.mjs';
import { redactSensitive, safeProcessEnv } from './security.mjs';
import { runYtDlpJob, runYtDlpMetadata } from './ytdlp.mjs';

const COMMANDS = new Set(['scan', 'update', 'play', 'update-play', 'reload', 'doctor', 'help', 'version']);
const NUMBER_OPTIONS = {
  '--query-budget': ['queryBudget', 1, 10000],
  '--result-limit': ['resultLimit', 1, 500],
  '--second-pass-limit': ['secondPassLimit', 0, 1000],
  '--second-pass-results': ['secondPassResultLimit', 1, 500],
  '--enrichment-limit': ['enrichmentLimit', 0, 100],
  '--concurrency': ['concurrency', 1, 16],
  '--timeout-ms': ['timeoutMs', 1000, 30 * 60 * 1000],
  '--fingerprint-timeout-ms': ['fingerprintTimeoutMs', 1000, 60 * 60 * 1000],
  '--fingerprint-max-bytes': ['fingerprintMaxBytes', 1024 * 1024, 1024 * 1024 * 1024],
  '--retries': ['retries', 0, 10],
};
const STRING_OPTIONS = {
  '--data-dir': 'dataDir',
  '--config-dir': 'configDir',
  '--cache-dir': 'cacheDir',
  '--yt-dlp': 'ytDlpBinary',
  '--mpv': 'mpvBinary',
  '--fpcalc': 'fpcalcBinary',
  '--ffmpeg': 'ffmpegBinary',
  '--ipc-socket': 'ipcSocket',
  '--variant': 'variant',
};
const FINGERPRINT_MODES = new Set(['metadata-only', 'candidates', 'fingerprint-all', 'segments']);

function optionValue(argv, index, inline, name) {
  if (inline !== undefined) return { value: inline, next: index };
  if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new TypeError(`${name} requires a value`);
  return { value: argv[index + 1], next: index + 1 };
}

export function parseCliArgs(argv) {
  const args = [...argv];
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) return { command: 'version', options: {} };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { command: 'help', options: {} };
  let command = args[0] && !args[0].startsWith('-') ? args.shift() : 'help';
  if (command === '--help' || command === '-h') command = 'help';
  if (command === '--version' || command === '-V') command = 'version';
  if (!COMMANDS.has(command)) throw new TypeError(`unknown command: ${command}`);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '-h' || token === '--help') return { command: 'help', options };
    const separator = token.indexOf('=');
    const name = separator === -1 ? token : token.slice(0, separator);
    const inline = separator === -1 ? undefined : token.slice(separator + 1);
    if (NUMBER_OPTIONS[name]) {
      const [field, minimum, maximum] = NUMBER_OPTIONS[name];
      const result = optionValue(args, index, inline, name);
      index = result.next;
      const number = Number(result.value);
      if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        throw new TypeError(`${name.slice(2)} must be an integer from ${minimum} to ${maximum}`);
      }
      options[field] = number;
      continue;
    }
    if (STRING_OPTIONS[name]) {
      const result = optionValue(args, index, inline, name);
      index = result.next;
      if (!result.value || /[\r\n\0]/.test(result.value)) throw new TypeError(`${name} requires a safe non-empty value`);
      const field = STRING_OPTIONS[name];
      options[field] = field === 'variant'
        ? result.value.split(',').map((value) => value.trim()).filter(Boolean)
        : result.value;
      continue;
    }
    if (name === '--fingerprint-mode') {
      const result = optionValue(args, index, inline, name);
      index = result.next;
      const mode = result.value === 'all' ? 'fingerprint-all' : result.value;
      if (!FINGERPRINT_MODES.has(mode)) throw new TypeError(`unsupported fingerprint mode: ${result.value}`);
      options.fingerprintMode = mode;
      continue;
    }
    const booleans = {
      '--shuffle': ['shuffle', true],
      '--no-shuffle': ['shuffle', false],
      '--no-loop': ['loop', false],
      '--loop': ['loop', true],
      '--audio-only': ['audioOnly', true],
      '--video': ['audioOnly', false],
      '--no-second-pass': ['secondPass', false],
      '--second-pass': ['secondPass', true],
      '--no-cache': ['useCache', false],
      '--cache': ['useCache', true],
      '--refresh-fingerprints': ['refreshFingerprints', true],
      '--pick': ['pick', true],
      '--json': ['json', true],
    };
    if (booleans[name] && inline === undefined) {
      const [field, value] = booleans[name];
      options[field] = value;
      continue;
    }
    throw new TypeError(`unknown option: ${token}`);
  }
  return { command, options };
}

function pathsFromOptions(options, env) {
  const defaults = getPaths(env);
  const configDir = options.configDir ? resolve(options.configDir) : defaults.configDir;
  return {
    dataDir: options.dataDir ? resolve(options.dataDir) : defaults.dataDir,
    cacheDir: options.cacheDir ? resolve(options.cacheDir) : defaults.cacheDir,
    configDir,
    configFile: join(configDir, 'config.json'),
    overridesFile: join(configDir, 'overrides.json'),
  };
}

function settingsFromOptions(options) {
  const pathOnly = new Set(['dataDir', 'cacheDir', 'configDir', 'ipcSocket', 'variant', 'pick', 'json']);
  return Object.fromEntries(Object.entries(options).filter(([key]) => !pathOnly.has(key)));
}

async function ensureConfig(paths) {
  await ensurePrivateDirectory(paths.configDir);
  if (!(await pathExists(paths.configFile))) await atomicWriteJson(paths.configFile, DEFAULT_SETTINGS);
  if (!(await pathExists(paths.overridesFile))) {
    await atomicWriteJson(paths.overridesFile, { schemaVersion: 1, keep: [], merge: [], reject: [] });
  }
}

export function filterCatalog(records, variants = []) {
  const wanted = new Set((Array.isArray(variants) ? variants : []).map(String));
  if (!wanted.size || wanted.has('all')) return [...records];
  return records.filter((record) => wanted.has(record.variantKey));
}

async function pickRecord(records) {
  if (!input.isTTY || !output.isTTY) throw new Error('--pick requires an interactive terminal');
  const readline = createInterface({ input, output });
  try {
    const query = (await readline.question('Szukaj tytułu, wykonawcy lub wariantu: ')).trim().toLowerCase();
    const matches = records.filter((record) => `${record.artist} ${record.trackTitle} ${record.variantKey}`.toLowerCase().includes(query)).slice(0, 50);
    if (!matches.length) throw new Error('no matching catalog records');
    matches.forEach((record, index) => output.write(`${index + 1}. ${record.artist} - ${record.trackTitle} [${record.variantKey}]\n`));
    const selected = Number(await readline.question('Numer: '));
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > matches.length) throw new Error('invalid selection');
    return matches[selected - 1];
  } finally {
    readline.close();
  }
}

async function playlistForSelection(paths, options) {
  const catalog = await readJson(join(paths.dataDir, 'catalog.json'));
  let records = filterCatalog(catalog.records ?? [], options.variant ?? []);
  if (options.pick) records = [await pickRecord(records)];
  if (!options.pick && !(options.variant?.length)) return join(paths.dataDir, 'playlist.m3u8');
  if (!records.length) throw new Error('selected variant filter produced an empty playlist');
  await ensurePrivateDirectory(paths.cacheDir);
  const path = join(paths.cacheDir, 'selection.m3u8');
  await atomicWriteFile(path, renderPlaylist(records));
  return path;
}

async function runScan(command, paths, settings, overrides, options, signal) {
  const result = await runScanPipeline({
    ...settings,
    dataDir: paths.dataDir,
    cacheDir: paths.cacheDir,
    overrides,
    resume: command === 'update' || command === 'update-play',
    preservePrevious: command === 'update' || command === 'update-play',
    signal,
    discoveryRunner: (job) => runYtDlpJob(job, {
      ytDlpBinary: settings.ytDlpBinary,
      timeoutMs: settings.timeoutMs,
      retries: settings.retries,
      signal,
    }),
    enrichmentRunner: (record) => runYtDlpMetadata(record.url, {
      ytDlpBinary: settings.ytDlpBinary,
      timeoutMs: settings.timeoutMs,
      retries: settings.retries,
      signal,
    }),
  });
  if (options.json) output.write(`${JSON.stringify(result.summary, null, 2)}\n`);
  else output.write(`catalog=${result.summary.catalogRecords} duplicates=${result.summary.duplicateGroups} review=${result.summary.reviewCases} rejected=${result.summary.rejectedRecords} failures=${result.summary.failedQueries}\n`);
  return result;
}

async function runPlayer(paths, settings, options, signal) {
  const playlist = await playlistForSelection(paths, options);
  await access(playlist);
  return playPlaylist(playlist, {
    mpvBinary: settings.mpvBinary,
    shuffle: settings.shuffle,
    loop: settings.loop,
    audioOnly: settings.audioOnly,
    ipcSocket: options.ipcSocket,
    signal,
  });
}

async function checkBinary(name, binary, args) {
  try {
    const result = await runProcess(binary, args, {
      timeoutMs: 10000,
      allowNonZero: true,
      maxBuffer: 1024 * 1024,
      env: safeProcessEnv(process.env, { media: name === 'mpv', network: ['yt-dlp', 'mpv'].includes(name) }),
    });
    const version = `${result.stdout}\n${result.stderr}`.trim().split('\n')[0] || 'version unavailable';
    return { name, binary, ok: result.code === 0, version: redactSensitive(version) };
  } catch (error) {
    return { name, binary, ok: false, error: redactSensitive(error.message) };
  }
}

async function doctor(paths, settings) {
  const checks = await Promise.all([
    Promise.resolve({ name: 'node', binary: process.execPath, ok: Number(process.versions.node.split('.')[0]) >= 22, version: process.version }),
    checkBinary('yt-dlp', settings.ytDlpBinary, ['--version']),
    checkBinary('mpv', settings.mpvBinary, ['--version']),
    checkBinary('fpcalc', settings.fpcalcBinary, ['-version']),
    checkBinary('ffmpeg', settings.ffmpegBinary, ['-version']),
  ]);
  const report = {
    schemaVersion: 1,
    paths,
    checks,
    fingerprintingAvailable: Boolean(checks.find((check) => check.name === 'fpcalc')?.ok),
    segmentedFingerprintingAvailable: Boolean(checks.find((check) => check.name === 'fpcalc')?.ok)
      && Boolean(checks.find((check) => check.name === 'ffmpeg')?.ok),
    metadataScanAvailable: checks.find((check) => check.name === 'node')?.ok && checks.find((check) => check.name === 'yt-dlp')?.ok,
    playbackAvailable: Boolean(checks.find((check) => check.name === 'mpv')?.ok),
  };
  report.healthy = Boolean(report.metadataScanAvailable && report.playbackAvailable);
  output.write(`${JSON.stringify(report, null, 2)}\n`);
  return { ...report, exitCode: report.healthy ? 0 : 1 };
}

export const HELP = `rogalddl-scraper\n\nCommands:\n  rogalddl scan [options]\n  rogalddl update [options]\n  rogalddl play [--shuffle] [--no-loop] [--variant remix,live] [--pick]\n  rogalddl update-play [options]\n  rogalddl reload --ipc-socket PATH\n  rogalddl doctor\n\nScan options:\n  --query-budget N          total channel/search jobs (default 60)\n  --result-limit N          items per source/search (default 25)\n  --enrichment-limit N      full metadata lookups for long-form items (default 20; 0 disables)\n  --no-second-pass          disable title/collaborator discovery pass\n  --fingerprint-mode MODE   metadata-only|candidates|fingerprint-all|segments\n  --fingerprint-max-bytes N hard per-download ceiling (default 67108864)\n  --concurrency N           1..16 bounded discovery workers\n  --no-cache                bypass query cache\n  --data-dir PATH           override XDG data directory\n  --cache-dir PATH          override XDG cache directory\n\nNo systemd service is installed or required.\n`;

export async function runCli(argv, context = {}) {
  const parsed = parseCliArgs(argv);
  if (parsed.command === 'help') {
    output.write(HELP);
    return { command: 'help' };
  }
  if (parsed.command === 'version') {
    output.write('rogalddl-scraper 0.1.0\n');
    return { command: 'version' };
  }
  const paths = pathsFromOptions(parsed.options, context.env ?? process.env);
  await ensureConfig(paths);
  const { settings, overrides } = await loadConfiguration(paths, settingsFromOptions(parsed.options));
  if (parsed.command === 'doctor') return doctor(paths, settings);
  let scanResult = null;
  if (['scan', 'update', 'update-play'].includes(parsed.command)) {
    scanResult = await runScan(parsed.command, paths, settings, overrides, parsed.options, context.signal);
  }
  const partialExitCode = scanResult?.summary?.status === 'partial' ? 2 : 0;
  if (parsed.command === 'play' || parsed.command === 'update-play') {
    const playback = await runPlayer(paths, settings, parsed.options, context.signal);
    return { ...playback, exitCode: partialExitCode };
  }
  if (parsed.command === 'reload') {
    if (!parsed.options.ipcSocket) throw new Error('reload requires --ipc-socket PATH');
    const playlist = await playlistForSelection(paths, parsed.options);
    const response = await sendMpvCommand(parsed.options.ipcSocket, ['loadlist', playlist, 'replace']);
    if (response?.error && response.error !== 'success') {
      throw Object.assign(new Error(`MPV rejected reload: ${response.error}`), { code: 'MPV_IPC_ERROR' });
    }
    output.write(`${JSON.stringify(response)}\n`);
    return response;
  }
  if (scanResult) return { ...scanResult, exitCode: partialExitCode };
  return { command: parsed.command };
}
