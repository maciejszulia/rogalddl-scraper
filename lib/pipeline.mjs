import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { buildArtifacts } from './catalog.mjs';
import { JsonDirectoryCache } from './cache.mjs';
import { classifyRecord, mergeSameId, normalizeRecord } from './classify.mjs';
import { findFingerprintCandidates } from './dedupe.mjs';
import { discover } from './discovery.mjs';
import { checkFingerprintCapability, fingerprintRecord, fingerprintSourceSignature } from './fingerprint.mjs';
import { atomicWriteJson, commitArtifacts, ensurePrivateDirectory, readJson } from './io.mjs';
import { safeError, sanitizeMetadata } from './security.mjs';

const OUTPUT_NAMES = {
  'catalog.json': 'catalog',
  'duplicates.json': 'duplicates',
  'review.json': 'review',
  'long-form.json': 'longForm',
  'rejected.json': 'rejected',
  'fingerprints.json': 'fingerprints',
  'summary.json': 'summary',
  'raw.json': 'raw',
  'playlist.m3u8': 'playlist',
};

function fingerprintTargets(rawRecords, mode) {
  if (mode === 'metadata-only' || mode === 'none' || mode === 'off') return [];
  const grouped = new Map();
  for (const raw of rawRecords) {
    try {
      const record = normalizeRecord(raw);
      const classification = classifyRecord(record);
      if (['track', 'alternate-version'].includes(classification.category)) {
        const records = grouped.get(record.id) ?? [];
        records.push(record);
        grouped.set(record.id, records);
      }
    } catch {}
  }
  const unique = [...grouped.values()].map((records) => mergeSameId(records));
  if (mode === 'all' || mode === 'fingerprint-all' || mode === 'segments') return unique.sort((a, b) => a.id.localeCompare(b.id));
  const candidateIds = new Set(findFingerprintCandidates(unique).ids);
  return unique.filter((record) => candidateIds.has(record.id)).sort((a, b) => a.id.localeCompare(b.id));
}

function enrichmentTargets(rawRecords, limit) {
  const targets = new Map();
  for (const raw of rawRecords) {
    try {
      const record = normalizeRecord(raw);
      if (classifyRecord(record).category === 'long-form' && !record.chapters.length) targets.set(record.id, record);
    } catch {}
  }
  return [...targets.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
}

function artifactFiles(artifacts) {
  return Object.fromEntries(Object.entries(OUTPUT_NAMES).map(([filename, key]) => [filename, artifacts[key]]));
}

function carryForwardRecords(previousRaw, currentRecords, generatedAt) {
  if (previousRaw === null) return { records: [], ids: [] };
  if (!previousRaw || previousRaw.schemaVersion !== 1 || !Array.isArray(previousRaw.records)) {
    throw new TypeError('previous raw.json must contain schemaVersion 1 and a records array');
  }
  const currentIds = new Set(currentRecords
    .map((record) => typeof record?.id === 'string' ? record.id.trim() : '')
    .filter(Boolean));
  const previousById = new Map();
  for (const raw of previousRaw.records) {
    let normalized;
    try {
      normalized = normalizeRecord(sanitizeMetadata(raw));
    } catch (error) {
      throw new TypeError(`previous raw.json contains an invalid record: ${error.message}`);
    }
    const group = previousById.get(normalized.id) ?? [];
    group.push(normalized);
    previousById.set(normalized.id, group);
  }
  const records = [];
  const ids = new Set();
  for (const [id, observations] of [...previousById.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const normalized = mergeSameId(observations);
    const stale = !currentIds.has(id);
    const provenanceBySource = new Map();
    for (const item of normalized.provenance.filter((entry) => entry.sourceType !== 'previous-catalog')) {
      const key = `${item.sourceId}\u0000${item.locator}\u0000${item.phase}`;
      const existing = provenanceBySource.get(key);
      if (!existing || String(item.fetchedAt).localeCompare(String(existing.fetchedAt)) > 0) provenanceBySource.set(key, item);
    }
    normalized.provenance = [
      ...provenanceBySource.values(),
      {
        sourceId: `catalog:previous:${normalized.id}`,
        sourceType: 'previous-catalog',
        locator: 'raw.json',
        phase: 0,
        fetchedAt: generatedAt,
        stale,
      },
    ];
    records.push(sanitizeMetadata(normalized));
    if (stale) ids.add(normalized.id);
  }
  return { records, ids: [...ids].sort() };
}

function fingerprintIsCurrent(entry, mode, record) {
  if (!entry?.fingerprint) return false;
  if (!record || entry.sourceSignature !== fingerprintSourceSignature(record)) return false;
  return mode !== 'segments' || (Array.isArray(entry.segments) && entry.segments.length >= 2);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function acquireScanLock(dataDir, options = {}) {
  const parent = dirname(dataDir);
  const path = join(parent, `.${basename(dataDir)}.scan.lock`);
  const token = randomUUID();
  await mkdir(parent, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const current = JSON.parse(await readFile(path, 'utf8'));
          if (current.token === token) await unlink(path);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let info;
      try {
        info = await lstat(path);
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      const ownUid = process.getuid?.();
      if (!info.isFile() || (ownUid !== undefined && info.uid !== ownUid)) {
        throw Object.assign(new Error(`unsafe scan lock at ${path}`), { code: 'SCAN_LOCK_UNSAFE' });
      }
      let current = null;
      try {
        current = JSON.parse(await readFile(path, 'utf8'));
      } catch {}
      const pid = Number(current?.pid);
      const validPid = Number.isSafeInteger(pid) && pid > 0;
      const staleByAge = Date.now() - info.mtimeMs > (options.lockStaleMs ?? 24 * 60 * 60 * 1000);
      if (validPid && processIsAlive(pid)) {
        throw Object.assign(new Error(`another scan is already running (pid ${pid})`), {
          code: 'SCAN_LOCKED',
          pid,
        });
      }
      if (!validPid && !staleByAge) {
        throw Object.assign(new Error(`unreadable active scan lock at ${path}`), { code: 'SCAN_LOCK_UNSAFE' });
      }
      await unlink(path).catch((unlinkError) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
    }
  }
  throw Object.assign(new Error('could not acquire scan lock'), { code: 'SCAN_LOCKED' });
}

async function runScanPipelineUnlocked(options = {}) {
  if (!options.dataDir || !options.cacheDir) throw new TypeError('dataDir and cacheDir are required');
  await ensurePrivateDirectory(options.cacheDir);
  const statePath = join(options.cacheDir, 'scan-state.json');
  const fingerprintPath = join(options.cacheDir, 'fingerprints.json');
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  let previousRaw = options.preservePrevious
    ? await readJson(join(options.dataDir, 'raw.json'), null)
    : null;
  const resumeState = options.resume ? await readJson(statePath, null) : null;
  const cache = options.cache ?? (options.useCache ? new JsonDirectoryCache(join(options.cacheDir, 'queries'), {
    ttlMs: options.cacheTtlMs,
  }) : null);
  const discovery = await discover({
    runJob: options.discoveryRunner,
    initialJobs: options.initialJobs,
    queryBudget: options.queryBudget,
    concurrency: options.concurrency,
    secondPass: options.secondPass,
    secondPassLimit: options.secondPassLimit,
    secondPassResultLimit: options.secondPassResultLimit,
    resultLimit: options.resultLimit,
    cache,
    resumeState,
    now: options.now,
    checkpoint: options.resume ? (state) => atomicWriteJson(statePath, state) : options.checkpoint,
  });
  if (!discovery.records.length) {
    const detail = discovery.failures.map((failure) => failure.error).filter(Boolean).join('; ');
    throw new Error(`No usable discovery results; previous catalog was preserved${detail ? `: ${detail}` : ''}`);
  }
  if (!options.preservePrevious && discovery.failures.length) {
    previousRaw = await readJson(join(options.dataDir, 'raw.json'), null);
  }

  const carriedForward = carryForwardRecords(previousRaw, discovery.records, generatedAt);
  const carriedForwardIds = new Set(carriedForward.ids);
  const workingRecords = [...discovery.records, ...carriedForward.records];
  const enrichmentFailures = [];
  const enrichmentLimit = Math.max(0, Math.min(100, Number.isSafeInteger(options.enrichmentLimit) ? options.enrichmentLimit : 20));
  if (typeof options.enrichmentRunner === 'function' && enrichmentLimit > 0) {
    for (const record of enrichmentTargets(discovery.records, enrichmentLimit)) {
      try {
        const enriched = await options.enrichmentRunner(record);
        if (!enriched || typeof enriched !== 'object') throw new TypeError('metadata enrichment returned no record');
        workingRecords.push({
          ...enriched,
          id: record.id,
          title: enriched.title || record.title,
          provenance: [
            ...record.provenance,
            {
              sourceId: `enrichment:${record.id}`,
              sourceType: 'metadata-enrichment',
              locator: record.url,
              phase: 3,
              fetchedAt: options.now?.() ?? new Date().toISOString(),
              cached: false,
              position: 1,
            },
          ],
        });
      } catch (error) {
        if (options.signal?.aborted || error?.code === 'PROCESS_ABORTED' || error?.name === 'AbortError') throw error;
        enrichmentFailures.push({ id: record.id, error: safeError(error), code: error.code ?? 'ENRICHMENT_ERROR' });
      }
    }
  }

  const fingerprints = await readJson(fingerprintPath, {});
  const fingerprintFailures = [];
  const fingerprintMode = options.fingerprintMode ?? 'candidates';
  const activeFingerprintRecords = fingerprintTargets(workingRecords, 'fingerprint-all');
  for (const record of activeFingerprintRecords) {
    if (fingerprints[record.id] && fingerprints[record.id].sourceSignature !== fingerprintSourceSignature(record)) {
      delete fingerprints[record.id];
    }
  }
  let targets = fingerprintTargets(workingRecords, fingerprintMode)
    .filter((record) => !carriedForwardIds.has(record.id)
      || options.refreshFingerprints
      || fingerprintMode === 'segments')
    .filter((record) => !fingerprintIsCurrent(fingerprints[record.id], fingerprintMode, record) || options.refreshFingerprints);
  let fingerprintCapability;
  if (['metadata-only', 'none', 'off'].includes(fingerprintMode)) {
    fingerprintCapability = { mode: fingerprintMode, available: false, reason: 'disabled-by-mode' };
  } else if (!targets.length) {
    fingerprintCapability = { mode: fingerprintMode, available: null, reason: 'no-candidates' };
  } else if (options.fingerprintRunner) {
    fingerprintCapability = { mode: fingerprintMode, available: true, source: 'injected-runner' };
  } else {
    try {
      await checkFingerprintCapability({
        fpcalcBinary: options.fpcalcBinary,
        timeoutMs: options.fingerprintTimeoutMs,
        signal: options.signal,
      });
      fingerprintCapability = { mode: fingerprintMode, available: true, source: 'fpcalc' };
    } catch (error) {
      if (options.signal?.aborted || error?.code === 'PROCESS_ABORTED' || error?.name === 'AbortError') throw error;
      fingerprintCapability = { mode: fingerprintMode, available: false, reason: error.code ?? 'FPCALC_UNAVAILABLE' };
      fingerprintFailures.push({ id: 'capability', error: safeError(error), code: error.code ?? 'FPCALC_UNAVAILABLE' });
      targets = [];
    }
  }
  const runner = options.fingerprintRunner ?? ((record) => fingerprintRecord(record, {
    capabilityChecked: true,
    segmented: fingerprintMode === 'segments',
    ytDlpBinary: options.ytDlpBinary,
    fpcalcBinary: options.fpcalcBinary,
    ffmpegBinary: options.ffmpegBinary,
    timeoutMs: options.fingerprintTimeoutMs,
    fingerprintMaxBytes: options.fingerprintMaxBytes,
    retries: options.retries,
    signal: options.signal,
    onRetry: options.onRetry,
  }));
  for (const record of targets) {
    if (fingerprintIsCurrent(fingerprints[record.id], fingerprintMode, record) && !options.refreshFingerprints) continue;
    try {
      const value = await runner(record);
      if (value?.fingerprint) {
        fingerprints[record.id] = sanitizeMetadata({
          ...value,
          videoId: record.id,
          sourceSignature: fingerprintSourceSignature(record),
        });
        await atomicWriteJson(fingerprintPath, fingerprints);
      }
    } catch (error) {
      if (options.signal?.aborted || error?.code === 'PROCESS_ABORTED' || error?.name === 'AbortError') throw error;
      fingerprintFailures.push({ id: record.id, error: safeError(error), code: error.code ?? 'FINGERPRINT_ERROR' });
      if (error.code === 'FPCALC_MISSING' || error.code === 'FPCALC_UNAVAILABLE') break;
    }
  }

  const failures = [
    ...discovery.failures,
    ...enrichmentFailures.map((failure) => ({
      sourceId: `enrichment:${failure.id}`,
      sourceType: 'metadata-enrichment',
      locator: failure.id,
      phase: 3,
      ...failure,
    })),
    ...fingerprintFailures.map((failure) => ({
      sourceId: `fingerprint:${failure.id}`,
      sourceType: 'fingerprint',
      locator: failure.id,
      phase: 4,
      ...failure,
    })),
  ];
  if (options.signal?.aborted) throw Object.assign(new Error('scan aborted before publication'), { code: 'PROCESS_ABORTED' });
  const artifacts = buildArtifacts(workingRecords, {
    fingerprints,
    overrides: options.overrides,
    generatedAt,
    failures,
    queryBudget: discovery.budget,
    cacheHits: discovery.completed.filter((item) => item.cached).length,
    fingerprintCapability,
    carriedForwardIds: carriedForward.ids,
  });
  if (!artifacts.catalog.records.length && !artifacts.longForm.records.length) {
    throw new Error('No usable music records after classification; previous catalog was preserved');
  }
  if (options.signal?.aborted) throw Object.assign(new Error('scan aborted before publication'), { code: 'PROCESS_ABORTED' });
  const files = await commitArtifacts(options.dataDir, artifactFiles(artifacts), {
    beforeSwap: options.beforeSwap,
    signal: options.signal,
  });
  if (options.resume) await atomicWriteJson(statePath, {
    schemaVersion: 3,
    runSignature: null,
    records: [],
    failures: [],
    completed: [],
    secondPassJobs: null,
  });
  return {
    files,
    summary: artifacts.summary,
    artifacts,
    discovery,
    enrichmentFailures,
    fingerprintFailures,
    temporaryAudioFiles: [],
  };
}

export async function runScanPipeline(options = {}) {
  if (!options.dataDir || !options.cacheDir) throw new TypeError('dataDir and cacheDir are required');
  const release = await acquireScanLock(options.dataDir, options);
  try {
    return await runScanPipelineUnlocked(options);
  } finally {
    await release();
  }
}
