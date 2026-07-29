import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('../rogalddl.mjs', import.meta.url));
const installer = fileURLToPath(new URL('../install.sh', import.meta.url));

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function runEntrypoint(args, env, timeoutMs = 5000) {
  const child = spawn(process.execPath, [entrypoint, ...args], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const result = await waitForExit(child);
  clearTimeout(timer);
  return { ...result, stdout, stderr };
}

async function runExecutable(command, args, env, timeoutMs = 5000) {
  const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const result = await waitForExit(child);
  clearTimeout(timer);
  return { ...result, stdout, stderr };
}

test('SIGTERM aborts discovery, stops its child and preserves the published catalog', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-signal-'));
  const dataDir = join(root, 'data');
  const cacheDir = join(root, 'cache');
  const configDir = join(root, 'config');
  await mkdir(dataDir, { recursive: true });
  const oldCatalog = '{"old":true}\n';
  await writeFile(join(dataDir, 'catalog.json'), oldCatalog);

  const fakeYtDlp = join(root, 'fake-yt-dlp.mjs');
  const startedMarker = join(root, 'yt-dlp-started');
  await writeFile(fakeYtDlp, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(startedMarker)}, 'started');
process.on('SIGTERM', () => process.exit(143));
setInterval(() => {}, 1000);
`);
  await chmod(fakeYtDlp, 0o755);

  const child = spawn(process.execPath, [
    entrypoint,
    'scan',
    '--query-budget', '1',
    '--result-limit', '1',
    '--no-second-pass',
    '--fingerprint-mode', 'metadata-only',
    '--yt-dlp', fakeYtDlp,
    '--data-dir', dataDir,
    '--cache-dir', cacheDir,
    '--config-dir', configDir,
  ], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: root },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(startedMarker);
      break;
    } catch {
      if (attempt === 99) throw new Error('fake yt-dlp never started');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  child.kill('SIGTERM');
  const result = await waitForExit(child);

  assert.deepEqual(result, { code: 143, signal: null });
  assert.match(stderr, /operation interrupted/i);
  assert.equal(await readFile(join(dataDir, 'catalog.json'), 'utf8'), oldCatalog);
});

test('real entrypoint completes scan, update, play and update-play with isolated tools', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-cli-e2e-'));
  const dataDir = join(root, 'data');
  const cacheDir = join(root, 'cache');
  const configDir = join(root, 'config');
  const fakeYtDlp = join(root, 'fake-yt-dlp');
  const fakeMpv = join(root, 'fake-mpv');
  const mpvMarker = join(root, 'mpv-calls');
  await writeFile(fakeYtDlp, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ id: 'abcdefghijk', title: 'Rogal DDL - E2E Song', duration: 180, uploader: 'Rogal DDL' }));\n`);
  await writeFile(fakeMpv, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(mpvMarker)}, 'play\\n');\n`);
  await chmod(fakeYtDlp, 0o700);
  await chmod(fakeMpv, 0o700);
  const env = { ...process.env, HOME: root };
  const paths = ['--data-dir', dataDir, '--cache-dir', cacheDir, '--config-dir', configDir];
  const scanOptions = [
    '--query-budget', '1', '--result-limit', '1', '--no-second-pass', '--enrichment-limit', '0',
    '--fingerprint-mode', 'metadata-only', '--no-cache', '--yt-dlp', fakeYtDlp,
  ];
  assert.equal((await runEntrypoint(['scan', ...scanOptions, ...paths], env)).code, 0);
  assert.equal((await runEntrypoint(['update', ...scanOptions, ...paths], env)).code, 0);
  assert.equal((await runEntrypoint(['play', '--no-loop', '--mpv', fakeMpv, ...paths], env)).code, 0);
  assert.equal((await runEntrypoint(['update-play', ...scanOptions, '--no-loop', '--mpv', fakeMpv, ...paths], env)).code, 0);
  assert.equal((await readFile(mpvMarker, 'utf8')).trim().split('\n').length, 2);
});

test('real entrypoint returns 2 when fingerprinting makes a published generation partial', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-cli-fingerprint-partial-'));
  const fakeYtDlp = join(root, 'fake-yt-dlp');
  const rows = [
    { id: 'abcdefghijk', title: 'Rogal DDL - Shared E2E Song', duration: 180, uploader: 'Rogal DDL' },
    { id: 'lmnopqrstuv', title: 'Rogal DDL - Shared E2E Song (Official Audio)', duration: 180, uploader: 'Archive' },
  ];
  await writeFile(fakeYtDlp, `#!/usr/bin/env node\nfor (const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row));\n`);
  await chmod(fakeYtDlp, 0o700);
  const dataDir = join(root, 'data');
  const result = await runEntrypoint([
    'scan', '--query-budget', '1', '--result-limit', '2', '--no-second-pass', '--enrichment-limit', '0', '--no-cache',
    '--fingerprint-mode', 'candidates', '--yt-dlp', fakeYtDlp, '--fpcalc', join(root, 'missing-fpcalc'),
    '--data-dir', dataDir, '--cache-dir', join(root, 'cache'), '--config-dir', join(root, 'config'),
  ], { ...process.env, HOME: root });
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'summary.json'), 'utf8')).status, 'partial');
});

test('installer creates a working launcher under a PREFIX containing spaces', { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-install-e2e-'));
  const prefix = join(root, 'prefix with spaces');
  const env = { ...process.env, PREFIX: prefix, HOME: '' };
  const installed = await runExecutable('bash', [installer], env);
  assert.equal(installed.code, 0, installed.stderr);
  const version = await runExecutable(join(prefix, 'bin', 'rogalddl'), ['--version'], env);
  assert.equal(version.code, 0, version.stderr);
  assert.match(version.stdout, /rogalddl-scraper 0\.1\.0/);
});
