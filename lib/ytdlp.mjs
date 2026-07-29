import { runProcess, withRetry } from './process.mjs';
import { redactSensitive, safeProcessEnv, sanitizeMetadata } from './security.mjs';

const SIMPLE_FIELDS = [
  'id', 'display_id', 'title', 'uploader', 'uploader_id', 'channel', 'channel_id',
  'duration', 'view_count', 'upload_date', 'availability', 'live_status', 'is_short',
];

function selectedMetadata(entry) {
  const result = {};
  for (const field of SIMPLE_FIELDS) {
    if (entry?.[field] !== undefined && entry[field] !== null) result[field] = entry[field];
  }
  if (!result.id && result.display_id) result.id = result.display_id;
  if (result.id) result.webpage_url = `https://www.youtube.com/watch?v=${encodeURIComponent(result.id)}`;
  if ([entry?.webpage_url, entry?.original_url, entry?.url].some((value) => /youtube\.com\/shorts\//i.test(String(value ?? '')))) {
    result.is_short = true;
  }
  if (Array.isArray(entry?.formats)) {
    result.formats = entry.formats.map((format) => ({
      format_id: format?.format_id ?? null,
      ext: format?.ext ?? null,
      acodec: format?.acodec ?? null,
      vcodec: format?.vcodec ?? null,
      abr: Number.isFinite(Number(format?.abr)) ? Number(format.abr) : null,
      tbr: Number.isFinite(Number(format?.tbr)) ? Number(format.tbr) : null,
      asr: Number.isFinite(Number(format?.asr)) ? Number(format.asr) : null,
      filesize: Number.isFinite(Number(format?.filesize)) ? Number(format.filesize) : null,
      filesize_approx: Number.isFinite(Number(format?.filesize_approx)) ? Number(format.filesize_approx) : null,
    }));
  }
  if (Array.isArray(entry?.chapters)) {
    result.chapters = entry.chapters.map((chapter) => ({
      title: String(chapter?.title ?? ''),
      start_time: Number(chapter?.start_time),
      end_time: Number(chapter?.end_time),
    }));
  }
  return sanitizeMetadata(result);
}

export function diagnoseYtDlpError(value) {
  const text = redactSensitive(value).toLowerCase();
  if (/po token|potoken/.test(text)) return { code: 'YTDLP_PO_TOKEN', hint: 'YouTube requested a PO token; update yt-dlp and review its official diagnostics. No bypass was attempted.' };
  if (/javascript runtime|js runtime|deno|node\.js runtime/.test(text)) return { code: 'YTDLP_JS_RUNTIME', hint: 'yt-dlp reported a JavaScript runtime problem; Node.js 22+ is required.' };
  if (/sign in|cookies|login required|confirm you.re not a bot/.test(text)) return { code: 'YTDLP_AUTH_REQUIRED', hint: 'The item is not anonymously accessible. Cookies were not copied or logged.' };
  if (/429|too many requests|rate.?limit/.test(text)) return { code: 'YTDLP_RATE_LIMIT', hint: 'YouTube rate-limited the scan; retry later with a smaller query budget.' };
  if (/unavailable|private video|removed/.test(text)) return { code: 'YTDLP_UNAVAILABLE', hint: 'The item is private, removed, unavailable, or region-restricted.' };
  if (/timed? ?out|network|connection|temporary failure/.test(text)) return { code: 'YTDLP_NETWORK', hint: 'A transient network error occurred.' };
  return { code: 'YTDLP_ERROR', hint: 'yt-dlp failed; run rogalddl doctor and inspect the sanitized diagnostic.' };
}

export function parseYtDlpPayload(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return { records: [], malformedLines: 0, invalidRows: 0 };

  let rows = [];
  let malformedLines = 0;
  try {
    rows = [JSON.parse(trimmed)];
  } catch {
    for (const line of trimmed.split('\n').filter(Boolean)) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        malformedLines += 1;
      }
    }
  }

  const entries = rows.flatMap((row) => {
    if (Array.isArray(row)) return row;
    if (row && typeof row === 'object' && Array.isArray(row.entries)) return row.entries;
    return [row];
  });
  const records = entries
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(selectedMetadata)
    .filter((record) => /^[A-Za-z0-9_-]{3,128}$/.test(record.id) && typeof record.title === 'string' && record.title.trim());
  const invalidRows = entries.length - records.length;
  if (!records.length && malformedLines) throw new SyntaxError('yt-dlp returned no valid JSON records');
  return { records, malformedLines, invalidRows };
}

export function buildYtDlpArgs(job, options = {}) {
  const resultLimit = Number(job.resultLimit ?? options.resultLimit ?? 25);
  if (!Number.isSafeInteger(resultLimit) || resultLimit < 1 || resultLimit > 500) {
    throw new TypeError('yt-dlp resultLimit must be an integer from 1 to 500');
  }
  return [
    '--ignore-config',
    '--dump-single-json',
    '--flat-playlist',
    '--skip-download',
    '--ignore-errors',
    '--no-warnings',
    '--no-progress',
    '--retries', '0',
    '--fragment-retries', '0',
    '--playlist-end', String(resultLimit),
    '--',
    String(job.locator),
  ];
}

export function buildYtDlpMetadataArgs(url) {
  if (typeof url !== 'string' || !/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_%=-]+$/.test(url)) {
    throw new TypeError('metadata enrichment requires a canonical YouTube watch URL');
  }
  return [
    '--ignore-config',
    '--dump-single-json',
    '--no-playlist',
    '--skip-download',
    '--no-warnings',
    '--no-progress',
    '--retries', '0',
    '--fragment-retries', '0',
    '--',
    url,
  ];
}

async function executeYtDlp(args, options) {
  try {
    const result = await withRetry(() => runProcess(options.ytDlpBinary ?? 'yt-dlp', args, {
      timeoutMs: options.timeoutMs ?? 120000,
      signal: options.signal,
      env: options.env ?? safeProcessEnv(process.env, { network: true }),
    }), {
      retries: options.retries ?? 2,
      baseDelayMs: options.baseDelayMs ?? 750,
      maxDelayMs: options.maxDelayMs ?? 8000,
      signal: options.signal,
      shouldRetry: (error) => {
        if (error.code === 'PROCESS_TIMEOUT') return true;
        if (error.code !== 'PROCESS_EXIT_ERROR') return false;
        const diagnosis = diagnoseYtDlpError(`${error.message}\n${error.stderr ?? ''}`);
        return ['YTDLP_RATE_LIMIT', 'YTDLP_NETWORK'].includes(diagnosis.code);
      },
      onRetry: options.onRetry,
    });
    const parsed = parseYtDlpPayload(result.stdout);
    const ignoredRows = parsed.malformedLines + parsed.invalidRows;
    return {
      records: parsed.records,
      warnings: ignoredRows
        ? [{ code: 'YTDLP_PARTIAL_PARSE', error: `${ignoredRows} malformed or invalid JSON row(s) ignored` }]
        : [],
    };
  } catch (error) {
    const diagnosis = diagnoseYtDlpError(`${error.message}\n${error.stderr ?? ''}`);
    if (error.stdout) {
      try {
        const parsed = parseYtDlpPayload(error.stdout);
        if (parsed.records.length) {
          return {
            records: parsed.records,
            warnings: [{ code: diagnosis.code, error: diagnosis.hint, partial: true }],
          };
        }
      } catch {}
    }
    error.ytDlpDiagnosis = diagnosis;
    error.message = `${diagnosis.code}: ${diagnosis.hint} ${redactSensitive(error.message)}`;
    throw error;
  }
}

export async function runYtDlpJob(job, options = {}) {
  return executeYtDlp(buildYtDlpArgs(job, options), options);
}

export async function runYtDlpMetadata(url, options = {}) {
  const result = await executeYtDlp(buildYtDlpMetadataArgs(url), options);
  if (!result.records.length) throw new Error('yt-dlp returned no metadata for enrichment');
  return result.records[0];
}
