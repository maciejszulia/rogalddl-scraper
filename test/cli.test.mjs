import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { getPaths, loadConfiguration, mergeSettings } from '../lib/config.mjs';
import { filterCatalog, parseCliArgs, runCli } from '../lib/cli.mjs';

test('XDG paths are used without systemd assumptions', () => {
  const paths = getPaths({
    XDG_DATA_HOME: '/xdg/data',
    XDG_CONFIG_HOME: '/xdg/config',
    XDG_CACHE_HOME: '/xdg/cache',
  });
  assert.equal(paths.dataDir, '/xdg/data/rogalddl');
  assert.equal(paths.configDir, '/xdg/config/rogalddl');
  assert.equal(paths.cacheDir, '/xdg/cache/rogalddl');
});

test('CLI parses scan limits and conservative fingerprint modes', () => {
  assert.equal(parseCliArgs(['--version']).command, 'version');
  const parsed = parseCliArgs([
    'scan', '--query-budget', '3', '--result-limit=4', '--enrichment-limit', '0', '--concurrency', '2',
    '--fingerprint-mode', 'metadata-only', '--no-second-pass', '--no-cache',
  ]);
  assert.equal(parsed.command, 'scan');
  assert.equal(parsed.options.queryBudget, 3);
  assert.equal(parsed.options.resultLimit, 4);
  assert.equal(parsed.options.enrichmentLimit, 0);
  assert.equal(parsed.options.concurrency, 2);
  assert.equal(parsed.options.fingerprintMode, 'metadata-only');
  assert.equal(parsed.options.secondPass, false);
  assert.equal(parsed.options.useCache, false);
});

test('CLI rejects unknown options, unsupported fingerprint modes and unsafe numbers', () => {
  assert.throws(() => parseCliArgs(['scan', '--wat']), /unknown option/i);
  assert.throws(() => parseCliArgs(['scan', '--fingerprint-mode', 'magic']), /fingerprint mode/i);
  assert.throws(() => parseCliArgs(['scan', '--query-budget', '0']), /query-budget/i);
});

test('configuration merge applies CLI last and validates binary names and limits', () => {
  const settings = mergeSettings(
    { queryBudget: 20, resultLimit: 15, ytDlpBinary: 'yt-dlp' },
    { queryBudget: 2, fingerprintMode: 'candidates' },
  );
  assert.equal(settings.queryBudget, 2);
  assert.equal(settings.resultLimit, 15);
  assert.equal(settings.fingerprintMode, 'candidates');
  assert.throws(() => mergeSettings({}, { mpvBinary: '' }), /mpvBinary/);
  assert.throws(() => mergeSettings({}, { concurrency: 99 }), /concurrency/);
});

test('configuration rejects unknown keys instead of silently accepting typos', () => {
  assert.throws(() => mergeSettings({ queryBudegt: 1 }), /unknown config.*queryBudegt/i);
  assert.throws(() => mergeSettings({}, { resultLimti: 2 }), /unknown CLI setting.*resultLimti/i);
});

test('catalog filtering preserves explicit musical variants', () => {
  const records = [
    { id: 'a', variantKey: 'original', title: 'Original' },
    { id: 'b', variantKey: 'remix', title: 'Remix' },
    { id: 'c', variantKey: 'live', title: 'Live' },
  ];
  assert.deepEqual(filterCatalog(records, ['remix']).map((record) => record.id), ['b']);
  assert.deepEqual(filterCatalog(records, ['original', 'live']).map((record) => record.id), ['a', 'c']);
  assert.deepEqual(filterCatalog(records, []).map((record) => record.id), ['a', 'b', 'c']);
});

test('malformed configuration is rejected instead of silently replaced by defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-config-'));
  const configFile = join(root, 'config.json');
  await writeFile(configFile, '{bad json');
  await assert.rejects(
    loadConfiguration({ configFile, overridesFile: join(root, 'overrides.json') }),
    /invalid JSON.*config\.json/i,
  );
});

test('semantically invalid override collections are rejected instead of silently disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-overrides-shape-'));
  const overridesFile = join(root, 'overrides.json');
  await writeFile(overridesFile, `${JSON.stringify({
    schemaVersion: 1,
    keep: [],
    merge: [],
    reject: { id: 'must-be-rejected' },
  })}\n`, { mode: 0o600 });
  await assert.rejects(
    loadConfiguration({ configFile: join(root, 'config.json'), overridesFile }),
    /reject.*array/i,
  );
});

test('override identifiers must be non-empty strings and are never coerced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-overrides-elements-'));
  const overridesFile = join(root, 'overrides.json');
  const malformed = [
    { schemaVersion: 1, keep: [['valid-id', 42]], merge: [], reject: [] },
    { schemaVersion: 1, keep: [], merge: [{ winner: 'valid-id', copies: [{ typo: 'copy-id' }] }], reject: [] },
    { schemaVersion: 1, keep: [], merge: [], reject: [{ id: { typo: 'abcdefghijk' } }] },
  ];
  for (const overrides of malformed) {
    await writeFile(overridesFile, `${JSON.stringify(overrides)}\n`, { mode: 0o600 });
    await assert.rejects(
      loadConfiguration({ configFile: join(root, 'config.json'), overridesFile }),
      /non-empty string/i,
    );
  }
});

test('fingerprint failure publishes partial output with exit code 2', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-fingerprint-partial-'));
  const fakeYtDlp = join(root, 'fake-yt-dlp');
  const rows = [
    { id: 'abcdefghijk', title: 'Rogal DDL - Shared Song', duration: 180, uploader: 'Rogal DDL' },
    { id: 'lmnopqrstuv', title: 'Rogal DDL - Shared Song (Official Audio)', duration: 180, uploader: 'Archive' },
  ];
  await writeFile(fakeYtDlp, `#!/usr/bin/env node\nfor (const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row));\n`);
  await chmod(fakeYtDlp, 0o700);
  const result = await runCli([
    'scan',
    '--query-budget', '1',
    '--result-limit', '2',
    '--no-second-pass',
    '--enrichment-limit', '0',
    '--no-cache',
    '--fingerprint-mode', 'candidates',
    '--yt-dlp', fakeYtDlp,
    '--fpcalc', join(root, 'missing-fpcalc'),
    '--data-dir', join(root, 'data'),
    '--cache-dir', join(root, 'cache'),
    '--config-dir', join(root, 'config'),
  ], { env: { HOME: root } });
  assert.equal(result.summary.status, 'partial');
  assert.equal(result.fingerprintFailures.length, 1);
  assert.equal(result.exitCode, 2);
});

test('doctor returns a failing health status when required binaries are unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-doctor-'));
  const result = await runCli([
    'doctor',
    '--data-dir', join(root, 'data'),
    '--cache-dir', join(root, 'cache'),
    '--config-dir', join(root, 'config'),
    '--yt-dlp', join(root, 'missing-ytdlp'),
    '--mpv', join(root, 'missing-mpv'),
    '--fpcalc', join(root, 'missing-fpcalc'),
    '--ffmpeg', join(root, 'missing-ffmpeg'),
  ], {
    env: {
      XDG_DATA_HOME: join(root, 'xdg-data'),
      XDG_CONFIG_HOME: join(root, 'xdg-config'),
      XDG_CACHE_HOME: join(root, 'xdg-cache'),
    },
  });
  assert.equal(result.healthy, false);
  assert.equal(result.exitCode, 1);
});

test('reload rejects an MPV IPC error response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-reload-'));
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'catalog.json'), `${JSON.stringify({ schemaVersion: 1, records: [] })}\n`);
  await writeFile(join(dataDir, 'playlist.m3u8'), '#EXTM3U\n');
  const socket = join(root, 'mpv.sock');
  const server = createServer((connection) => {
    connection.once('data', () => connection.end('{"error":"failure"}\n'));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  try {
    await assert.rejects(runCli([
      'reload',
      '--ipc-socket', socket,
      '--data-dir', dataDir,
      '--cache-dir', join(root, 'cache'),
      '--config-dir', join(root, 'config'),
    ], { env: { HOME: root } }), /MPV rejected reload/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
