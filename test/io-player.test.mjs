import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { commitArtifacts, readJson } from '../lib/io.mjs';
import { buildMpvArgs, playPlaylist, sendMpvCommand, toMpvEntryUrl } from '../lib/player.mjs';
import { redactSensitive, safeProcessEnv, sanitizeMetadata } from '../lib/security.mjs';
import { runProcess } from '../lib/process.mjs';

test('failed staging does not replace the last valid catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-atomic-'));
  const target = join(root, 'catalog');
  await mkdir(target);
  await writeFile(join(target, 'catalog.json'), '{"old":true}\n');
  await assert.rejects(
    commitArtifacts(target, { 'catalog.json': { schemaVersion: 1, old: false } }, {
      beforeSwap: async () => { throw new Error('simulated interrupted scan'); },
    }),
    /simulated interrupted scan/,
  );
  assert.deepEqual(await readJson(join(target, 'catalog.json')), { old: true });
  await commitArtifacts(target, { 'catalog.json': { schemaVersion: 1, old: false } });
  assert.deepEqual(await readJson(join(target, 'catalog.json')), { schemaVersion: 1, old: false });
});

test('an interrupted directory swap is recovered before the next publication attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-recovery-'));
  const target = join(root, 'catalog');
  const previous = join(root, '.catalog.previous-crashed');
  const abandoned = join(root, '.catalog.staging-crashed');
  await mkdir(previous, { mode: 0o700 });
  await mkdir(abandoned, { mode: 0o700 });
  await writeFile(join(previous, 'catalog.json'), '{"generation":"old"}\n');
  await writeFile(join(abandoned, 'catalog.json'), '{"generation":"uncommitted"}\n');

  await assert.rejects(
    commitArtifacts(target, { 'catalog.json': { generation: 'next' } }, {
      beforeSwap: async () => { throw new Error('stop after recovery'); },
    }),
    /stop after recovery/,
  );
  assert.deepEqual(await readJson(join(target, 'catalog.json')), { generation: 'old' });
  await assert.rejects(access(previous), (error) => error.code === 'ENOENT');
  await assert.rejects(access(abandoned), (error) => error.code === 'ENOENT');
});

test('MPV receives an argument array with shell disabled', async () => {
  const suspiciousPath = '/tmp/list;touch /tmp/rogalddl-pwned.m3u8';
  const args = buildMpvArgs(suspiciousPath, {
    shuffle: true,
    loop: false,
    audioOnly: true,
    ipcSocket: '/tmp/mpv socket',
  });
  assert.ok(args.includes(`--playlist=${suspiciousPath}`));
  assert.ok(args.includes('--no-config'));
  assert.ok(args.includes('--load-scripts=no'));
  assert.ok(args.includes('--shuffle'));
  assert.ok(args.includes('--loop-playlist=no'));
  assert.ok(args.includes('--no-video'));
  let observed;
  const spawnImpl = (command, actualArgs, options) => {
    observed = { command, args: actualArgs, options };
    return { once(event, callback) { if (event === 'exit') queueMicrotask(() => callback(0, null)); } };
  };
  await playPlaylist(suspiciousPath, { spawnImpl, mpvBinary: 'fake-mpv' });
  assert.equal(observed.command, 'fake-mpv');
  assert.equal(observed.options.shell, false);
  assert.ok(observed.args.includes('--no-config'));
  assert.deepEqual(observed.args.at(-1), `--playlist=${suspiciousPath}`);
  assert.throws(() => buildMpvArgs('/tmp/list.m3u8', { start: 'NaN' }), /start/i);
});

test('MPV output is piped through secret redaction before it reaches the terminal', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  let visible = '';
  const sink = { write(chunk) { visible += String(chunk); return true; } };
  const playback = playPlaylist('/tmp/list.m3u8', {
    spawnImpl: () => child,
    stdout: sink,
    stderr: sink,
  });
  child.stdout.write('Cookie: SID=synthetic-cookie\n');
  child.stderr.write('https://x.googlevideo.com/videoplayback?sig=synthetic-signature\n');
  child.stdout.end();
  child.stderr.end();
  child.emit('exit', 0, null);
  await playback;
  assert.doesNotMatch(visible, /synthetic-cookie|synthetic-signature/);
  assert.match(visible, /\[REDACTED/);
});

test('MPV playback is terminated when the CLI abort signal fires', async () => {
  const controller = new AbortController();
  let killedWith;
  const callbacks = new Map();
  const spawnImpl = () => ({
    once(event, callback) { callbacks.set(event, callback); },
    kill(signal) {
      killedWith = signal;
      queueMicrotask(() => callbacks.get('exit')?.(null, signal));
    },
  });
  const playback = playPlaylist('/tmp/list.m3u8', { spawnImpl, signal: controller.signal });
  controller.abort();
  await assert.rejects(playback, (error) => error.code === 'MPV_ABORTED');
  assert.equal(killedWith, 'SIGTERM');
});

test('MPV abort escalates to SIGKILL when the player ignores SIGTERM', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX signal escalation is unavailable');
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-mpv-abort-'));
  const marker = join(root, 'started');
  const fakeMpv = join(root, 'fake-mpv');
  await writeFile(fakeMpv, `#!/usr/bin/env node
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(marker)}, 'started');
setTimeout(() => {}, 10000);
`);
  await chmod(fakeMpv, 0o755);
  const controller = new AbortController();
  const playback = playPlaylist('/tmp/list.m3u8', {
    mpvBinary: fakeMpv,
    stdio: 'ignore',
    signal: controller.signal,
    killGraceMs: 100,
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await access(marker);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const started = Date.now();
  controller.abort();
  await assert.rejects(playback, (error) => error.code === 'MPV_ABORTED');
  assert.ok(Date.now() - started < 500);
});

test('chapter entries use a bounded MPV EDL URL', () => {
  const url = toMpvEntryUrl({
    url: 'https://www.youtube.com/watch?v=chapter',
    segment: { start: 65.5, end: 125.5 },
  });
  assert.match(url, /^edl:\/\//);
  assert.match(url, /,65\.5,60$/);
  assert.match(url, /ytdl:\/\/https:\/\/www\.youtube\.com/);
});

test('MPV IPC rejects process execution and arbitrary load targets before connecting', () => {
  assert.throws(() => sendMpvCommand('/tmp/mpv.sock', ['run', 'touch', '/tmp/pwned']), /not allowed/i);
  assert.throws(() => sendMpvCommand('/tmp/mpv.sock', ['loadfile', 'https://127.0.0.1/private']), /not allowed/i);
  assert.throws(() => sendMpvCommand('relative.sock', ['get_property', 'pause']), /absolute path/i);
});

test('tokens, cookies and authorization headers are removed from logs and metadata', () => {
  const text = 'Authorization: Bearer TOPSECRET cookie=SID=COOKIE api_token=TOKEN123 --cookies /tmp/cookies.txt';
  const redacted = redactSensitive(text);
  assert.doesNotMatch(redacted, /TOPSECRET|COOKIE|TOKEN123|cookies\.txt/);
  const githubCredential = `ghp_${'x'.repeat(30)}`;
  assert.equal(redactSensitive(githubCredential), '[REDACTED]');
  assert.equal(redactSensitive(`Bearer ${'y'.repeat(24)}`), 'Bearer [REDACTED]');
  assert.doesNotMatch(redactSensitive('Cookie: first=value; second=another\nkept'), /value|another/);
  assert.doesNotMatch(redactSensitive('https://cdn.example/audio?lsig=hidden&spc=private&ip=127.0.0.1'), /hidden|private|127\.0\.0\.1/);
  const sanitized = sanitizeMetadata({
    id: 'safe',
    title: 'Safe',
    cookies: 'hidden',
    token: 'hidden-token',
    http_headers: { Authorization: 'Bearer hidden' },
    nested: { apiKey: 'hidden-key', keep: 'yes' },
    formats: [{ url: 'https://cdn.example/signed?capability=hidden', acodec: 'opus', abr: 128 }],
  });
  assert.deepEqual(sanitized, {
    id: 'safe',
    title: 'Safe',
    nested: { keep: 'yes' },
    formats: [{ acodec: 'opus', abr: 128 }],
  });
});

test('proxy credentials are redacted for every forwarded proxy URI scheme', () => {
  for (const scheme of ['http', 'https', 'socks4', 'socks5', 'socks5h']) {
    const redacted = redactSensitive(`${scheme}://synthetic-user:synthetic-password@proxy.invalid:1080`);
    assert.doesNotMatch(redacted, /synthetic-user|synthetic-password/);
    assert.match(redacted, /\[REDACTED\]@proxy\.invalid/);
  }
});

test('external tools receive an allowlisted environment without credentials or loader injection', () => {
  const source = {
    PATH: '/usr/bin', HOME: '/home/test', LANG: 'C.UTF-8', DISPLAY: ':0',
    HTTPS_PROXY: 'http://proxy.invalid:8080',
    API_TOKEN: 'secret', COOKIE: 'secret', Authorization: 'secret', LD_PRELOAD: '/tmp/evil.so',
  };
  assert.deepEqual(safeProcessEnv(source), { PATH: '/usr/bin', HOME: '/home/test', LANG: 'C.UTF-8' });
  assert.equal(safeProcessEnv(source, { media: true }).DISPLAY, ':0');
  assert.equal(safeProcessEnv(source, { network: true }).HTTPS_PROXY, 'http://proxy.invalid:8080');
});

test('runProcess never invokes a shell for hostile arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-process-'));
  const marker = join(root, 'owned');
  const hostile = `;require('node:fs').writeFileSync(${JSON.stringify(marker)},'owned')`;
  const result = await runProcess(process.execPath, ['-e', 'console.log(process.argv[1])', hostile], {
    timeoutMs: 5000,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /writeFileSync/);
  await assert.rejects(access(marker));
});

test('runProcess enforces timeout and returns redacted diagnostics', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', "setTimeout(() => {}, 10000); console.error('token=SUPERSECRET')"], {
      timeoutMs: 50,
    }),
    (error) => {
      assert.equal(error.code, 'PROCESS_TIMEOUT');
      assert.doesNotMatch(error.message, /SUPERSECRET/);
      return true;
    },
  );
});

test('runProcess aborts a live child with a controlled error', async () => {
  const controller = new AbortController();
  const running = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    timeoutMs: 15000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(running, (error) => {
    assert.equal(error.code, 'PROCESS_ABORTED');
    return true;
  });
});

test('runProcess kills a timed-out POSIX process group and redacts captured error streams', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups are unavailable');
  const script = `
const { spawn } = require('node:child_process');
process.on('SIGTERM', () => {});
spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 10000)"], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
console.log('https://rr.example.googlevideo.com/videoplayback?sig=private-value');
console.error('Cookie: first=value; second=another');
setTimeout(() => {}, 10000);
`;
  const started = Date.now();
  await assert.rejects(
    runProcess(process.execPath, ['-e', script], { timeoutMs: 150, killGraceMs: 100 }),
    (error) => {
      assert.equal(error.code, 'PROCESS_TIMEOUT');
      assert.doesNotMatch(`${error.stdout}\n${error.stderr}`, /private-value|first=value|second=another/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 1000, 'timed-out process tree should not retain inherited pipes');
});
