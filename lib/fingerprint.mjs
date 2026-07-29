import { createHash } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, withRetry } from './process.mjs';
import { safeProcessEnv, sanitizeMetadata } from './security.mjs';

function safeFingerprintArgs(args) {
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) throw new TypeError('fingerprint tool args must be strings');
  return args;
}

async function downloadedFile(directory) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.part'))
    .map((entry) => join(directory, entry.name))
    .sort();
  if (!entries.length) throw new Error('yt-dlp produced no temporary audio sample');
  return entries[0];
}

async function fpcalc(file, options) {
  let result;
  try {
    result = await runProcess(options.fpcalcBinary ?? 'fpcalc', ['-json', '-length', String(options.length ?? 120), file], {
      timeoutMs: options.timeoutMs ?? 180000,
      signal: options.signal,
      env: options.env ?? safeProcessEnv(),
    });
  } catch (error) {
    if (error.code === 'PROCESS_SPAWN_ERROR') error.code = 'FPCALC_MISSING';
    throw error;
  }
  const payload = JSON.parse(result.stdout);
  if (!payload.fingerprint) throw new Error('fpcalc returned no fingerprint');
  return {
    fingerprint: String(payload.fingerprint),
    duration: Number(payload.duration),
    algorithm: 'chromaprint',
  };
}

export async function checkFingerprintCapability(options = {}) {
  try {
    await runProcess(options.fpcalcBinary ?? 'fpcalc', ['-version'], {
      timeoutMs: Math.min(options.timeoutMs ?? 10000, 10000),
      signal: options.signal,
      env: options.env ?? safeProcessEnv(),
    });
  } catch (error) {
    if (error.code === 'PROCESS_ABORTED' || error.name === 'AbortError') throw error;
    error.code = error.code === 'PROCESS_SPAWN_ERROR' ? 'FPCALC_MISSING' : 'FPCALC_UNAVAILABLE';
    throw error;
  }
  return { available: true };
}

export function buildFingerprintDownloadArgs(record, template, options = {}) {
  const maximumBytes = Number(options.fingerprintMaxBytes ?? 64 * 1024 * 1024);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1024 * 1024 || maximumBytes > 1024 * 1024 * 1024) {
    throw new TypeError('fingerprintMaxBytes must be an integer from 1048576 to 1073741824');
  }
  return [
    '--ignore-config',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--retries', '0',
    '--fragment-retries', '0',
    '--max-filesize', String(maximumBytes),
    '--format', 'bestaudio/best',
    '--output', template,
    '--', String(record.url),
  ];
}

export function fingerprintSourceSignature(record) {
  if (!record?.id || !record?.url) throw new TypeError('fingerprint source signature requires record ID and URL');
  return createHash('sha256').update(`${record.id}\u0000${record.url}\u0000${record.duration ?? ''}`).digest('hex');
}

async function segmentFingerprints(inputFile, duration, directory, options) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const starts = [...new Set([0, Math.max(0, duration / 2 - 30), Math.max(0, duration - 60)].map((value) => Math.round(value * 10) / 10))];
  const segments = [];
  for (const [index, start] of starts.entries()) {
    const output = join(directory, `segment-${index}.wav`);
    await runProcess(options.ffmpegBinary ?? 'ffmpeg', safeFingerprintArgs([
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(start), '-t', '60', '-i', inputFile,
      '-vn', '-ac', '1', '-ar', '11025', '-c:a', 'pcm_s16le', '-y', output,
    ]), {
      timeoutMs: options.timeoutMs ?? 180000,
      signal: options.signal,
      env: options.env ?? safeProcessEnv(),
    });
    const calculated = await fpcalc(output, { ...options, length: 60 });
    segments.push({ start, ...calculated });
  }
  return segments;
}

export async function fingerprintRecord(record, options = {}) {
  if (!record?.url) throw new TypeError('fingerprintRecord requires a record URL');
  if (!options.capabilityChecked) await checkFingerprintCapability(options);
  const directory = await mkdtemp(join(tmpdir(), 'rogalddl-fingerprint-'));
  try {
    const template = join(directory, 'sample.%(ext)s');
    const args = buildFingerprintDownloadArgs(record, template, options);
    await withRetry(() => runProcess(options.ytDlpBinary ?? 'yt-dlp', args, {
      timeoutMs: options.timeoutMs ?? 300000,
      signal: options.signal,
      env: options.env ?? safeProcessEnv(process.env, { network: true }),
    }), {
      retries: options.retries ?? 1,
      baseDelayMs: options.baseDelayMs ?? 750,
      signal: options.signal,
      shouldRetry: (error) => ['PROCESS_TIMEOUT', 'PROCESS_EXIT_ERROR'].includes(error.code),
      onRetry: options.onRetry,
    });
    const input = await downloadedFile(directory);
    const maximumBytes = Number(options.fingerprintMaxBytes ?? 64 * 1024 * 1024);
    if ((await stat(input)).size > maximumBytes) {
      throw Object.assign(new Error(`temporary audio exceeds fingerprint size limit of ${maximumBytes} bytes`), {
        code: 'FINGERPRINT_FILE_TOO_LARGE',
      });
    }
    const full = await fpcalc(input, options);
    const result = {
      ...full,
      videoId: record.id,
      sourceSignature: fingerprintSourceSignature(record),
    };
    if (options.segmented) result.segments = await segmentFingerprints(input, full.duration || record.duration, directory, options);
    return sanitizeMetadata(result);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
