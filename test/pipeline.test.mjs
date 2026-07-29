import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScanPipeline } from '../lib/pipeline.mjs';
import { fingerprintSourceSignature } from '../lib/fingerprint.mjs';
import { video } from './fixtures.mjs';

const generatedAt = '2026-01-02T03:04:05.000Z';

test('offline integration writes every required stable artifact without keeping audio', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-pipeline-'));
  const dataDir = join(root, 'data');
  const cacheDir = join(root, 'cache');
  const enriched = [];
  const result = await runScanPipeline({
    dataDir,
    cacheDir,
    generatedAt,
    initialJobs: [{ sourceId: 'fixture', sourceType: 'fixture', locator: 'fixture', phase: 1 }],
    secondPass: false,
    queryBudget: 1,
    fingerprintMode: 'candidates',
    fingerprintRunner: async (record) => ({
      fingerprint: record.title.includes('Copy') ? 'same-fp' : `fp-${record.id}`,
      duration: record.duration,
      algorithm: 'fixture',
    }),
    discoveryRunner: async () => [
      video('one', 'Rogal DDL - Song'),
      video('two', 'Rogal DDL - Song Copy', {
        title: 'Rogal DDL - Song (Official Audio)',
        uploader: 'Label',
        uploader_id: '@label',
        channel_id: 'label',
      }),
      video('long', 'Rogal DDL - Full Concert', { duration: 4000 }),
    ],
    enrichmentLimit: 2,
    enrichmentRunner: async (record) => {
      enriched.push(record.id);
      return video(record.id, record.title, {
        duration: record.duration,
        chapters: [{ title: 'Missing Concert Track', start_time: 0, end_time: 180 }],
      });
    },
  });
  for (const name of [
    'playlist.m3u8',
    'catalog.json',
    'duplicates.json',
    'review.json',
    'long-form.json',
    'rejected.json',
    'fingerprints.json',
    'summary.json',
    'raw.json',
  ]) {
    assert.ok(result.files.includes(name), name);
  }
  const playlist = await readFile(join(dataDir, 'playlist.m3u8'), 'utf8');
  assert.match(playlist, /^#EXTM3U/m);
  assert.doesNotMatch(playlist, /Full Concert/);
  assert.equal(result.summary.failedQueries, 0);
  assert.equal(result.artifacts.fingerprints.capability.source, 'injected-runner');
  assert.deepEqual(enriched, ['long']);
  assert.equal(result.artifacts.longForm.records[0].chapters.length, 1);
  assert.deepEqual(result.temporaryAudioFiles, []);
});

test('an unsuccessful scan leaves the previous output untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-failed-scan-'));
  const dataDir = join(root, 'data');
  const cacheDir = join(root, 'cache');
  const options = {
    dataDir,
    cacheDir,
    generatedAt,
    initialJobs: [{ sourceId: 'fixture', sourceType: 'fixture', locator: 'fixture', phase: 1 }],
    secondPass: false,
    queryBudget: 1,
  };
  await runScanPipeline({ ...options, discoveryRunner: async () => [video('old', 'Rogal DDL - Old')] });
  const before = await readFile(join(dataDir, 'catalog.json'), 'utf8');
  await assert.rejects(
    runScanPipeline({ ...options, discoveryRunner: async () => { throw new Error('all discovery failed'); } }),
    /no usable discovery results/i,
  );
  const after = await readFile(join(dataDir, 'catalog.json'), 'utf8');
  assert.equal(after, before);
});

test('abort at the publication boundary preserves the previous generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-abort-publish-'));
  const dataDir = join(root, 'data');
  const cacheDir = join(root, 'cache');
  const base = {
    dataDir,
    cacheDir,
    generatedAt,
    initialJobs: [{ sourceId: 'fixture', sourceType: 'fixture', locator: 'fixture', phase: 1 }],
    queryBudget: 1,
    secondPass: false,
    fingerprintMode: 'metadata-only',
  };
  await runScanPipeline({ ...base, discoveryRunner: async () => [video('old-published', 'Rogal DDL - Old')] });
  const previous = await readFile(join(dataDir, 'catalog.json'), 'utf8');
  const controller = new AbortController();
  await assert.rejects(
    runScanPipeline({
      ...base,
      signal: controller.signal,
      discoveryRunner: async () => [video('must-not-publish', 'Rogal DDL - New')],
      beforeSwap: async () => controller.abort(),
    }),
    (error) => error.code === 'PROCESS_ABORTED',
  );
  assert.equal(await readFile(join(dataDir, 'catalog.json'), 'utf8'), previous);
});

test('a partially failed discovery publishes usable results with an explicit partial status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-partial-'));
  const dataDir = join(root, 'data');
  const cacheDir = join(root, 'cache');
  await runScanPipeline({
    dataDir,
    cacheDir,
    generatedAt,
    initialJobs: [{ sourceId: 'seed', sourceType: 'fixture', locator: 'seed', phase: 1 }],
    discoveryRunner: async () => [video('older-partial', 'Rogal DDL - Older Partial')],
    queryBudget: 1,
    secondPass: false,
    fingerprintMode: 'metadata-only',
  });
  const result = await runScanPipeline({
    dataDir,
    cacheDir,
    generatedAt,
    initialJobs: [
      { sourceId: 'search:ok', sourceType: 'search', locator: 'fixture:ok', phase: 1 },
      { sourceId: 'search:fail', sourceType: 'search', locator: 'fixture:fail', phase: 1 },
    ],
    discoveryRunner: async (job) => {
      if (job.sourceId === 'search:fail') throw new Error('fixture failure');
      return [video('partial-ok', 'Rogal DDL - Partial Result')];
    },
    queryBudget: 2,
    secondPass: false,
    fingerprintMode: 'metadata-only',
    now: () => generatedAt,
  });
  assert.equal(result.summary.status, 'partial');
  assert.equal(result.summary.failedQueries, 1);
  assert.equal(result.summary.queryBudget.consumed, 2);
  assert.deepEqual(result.artifacts.catalog.records.map((record) => record.id), ['older-partial', 'partial-ok']);
  assert.equal(result.summary.carriedForwardRecords, 1);
  const raw = JSON.parse(await readFile(join(dataDir, 'raw.json'), 'utf8'));
  assert.equal(raw.failures.length, 1);
});

test('incremental update retains richer metadata for IDs still present without growing raw snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-update-rich-'));
  const options = {
    dataDir: join(root, 'data'),
    cacheDir: join(root, 'cache'),
    generatedAt,
    initialJobs: [{ sourceId: 'fixture', sourceType: 'fixture', locator: 'fixture', phase: 1 }],
    queryBudget: 1,
    secondPass: false,
    fingerprintMode: 'metadata-only',
  };
  await runScanPipeline({
    ...options,
    discoveryRunner: async () => [video('current-track', 'Rogal DDL - Current', {
      chapters: [{ title: 'Current', start_time: 0, end_time: 180 }],
    })],
  });
  const update = () => runScanPipeline({
    ...options,
    preservePrevious: true,
    discoveryRunner: async () => [video('current-track', 'Rogal DDL - Current', { chapters: [] })],
  });
  const second = await update();
  const third = await update();
  assert.equal(second.artifacts.catalog.records[0].chapters.length, 1);
  assert.equal(third.artifacts.catalog.records[0].chapters.length, 1);
  assert.equal(third.artifacts.raw.records.length, 2);
  assert.equal(third.summary.carriedForwardRecords, 0);
});

test('missing fpcalc is reported once at pipeline capability level before any audio download', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-pipeline-no-fpcalc-'));
  const result = await runScanPipeline({
    dataDir: join(root, 'data'),
    cacheDir: join(root, 'cache'),
    generatedAt,
    initialJobs: [{ sourceId: 'fixture', sourceType: 'fixture', locator: 'fixture', phase: 1 }],
    secondPass: false,
    queryBudget: 1,
    fingerprintMode: 'candidates',
    fpcalcBinary: join(root, 'definitely-missing-fpcalc'),
    ytDlpBinary: join(root, 'must-not-run-yt-dlp'),
    discoveryRunner: async () => [
      video('candidate-a', 'Rogal DDL - Candidate Song'),
      video('candidate-b', 'Rogal DDL - Candidate Song (Official Audio)', {
        uploader: 'Independent Reupload',
        uploader_id: '@independent',
        channel_id: 'independent-channel',
      }),
    ],
  });

  assert.equal(result.artifacts.fingerprints.capability.available, false);
  assert.equal(result.artifacts.fingerprints.capability.reason, 'FPCALC_MISSING');
  assert.deepEqual(result.fingerprintFailures.map((failure) => failure.id), ['capability']);
  assert.equal(result.artifacts.fingerprints.records.length, 0);
  assert.equal(result.summary.status, 'partial');
});

test('abort after a completed job preserves the catalog and leaves a resumable checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-pipeline-abort-'));
  const dataDir = join(root, 'data');
  const cacheDir = join(root, 'cache');
  await mkdir(dataDir, { recursive: true });
  const oldCatalog = '{"old":true}\n';
  await writeFile(join(dataDir, 'catalog.json'), oldCatalog);
  const controller = new AbortController();
  let secondStarted;
  const waitingForSecond = new Promise((resolve) => { secondStarted = resolve; });
  const running = runScanPipeline({
    dataDir,
    cacheDir,
    generatedAt,
    initialJobs: [
      { sourceId: 'fixture:first', sourceType: 'fixture', locator: 'first', phase: 1 },
      { sourceId: 'fixture:second', sourceType: 'fixture', locator: 'second', phase: 1 },
    ],
    queryBudget: 2,
    concurrency: 1,
    secondPass: false,
    resume: true,
    signal: controller.signal,
    fingerprintMode: 'metadata-only',
    discoveryRunner: async (job) => {
      if (job.sourceId === 'fixture:first') return [video('abort-first', 'Rogal DDL - First')];
      secondStarted();
      return new Promise((resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted fixture'), { code: 'PROCESS_ABORTED' })), { once: true });
      });
    },
  });

  await waitingForSecond;
  controller.abort();
  await assert.rejects(running, (error) => error.code === 'PROCESS_ABORTED');
  assert.equal(await readFile(join(dataDir, 'catalog.json'), 'utf8'), oldCatalog);
  const state = JSON.parse(await readFile(join(cacheDir, 'scan-state.json'), 'utf8'));
  assert.deepEqual(state.completed.map((item) => item.sourceId), ['fixture:first']);

  const resumedCalls = [];
  const resumed = await runScanPipeline({
    dataDir,
    cacheDir,
    generatedAt,
    initialJobs: [
      { sourceId: 'fixture:first', sourceType: 'fixture', locator: 'first', phase: 1 },
      { sourceId: 'fixture:second', sourceType: 'fixture', locator: 'second', phase: 1 },
    ],
    queryBudget: 2,
    concurrency: 1,
    secondPass: false,
    resume: true,
    fingerprintMode: 'metadata-only',
    discoveryRunner: async (job) => {
      resumedCalls.push(job.sourceId);
      return [video('resume-second', 'Rogal DDL - Second')];
    },
  });
  assert.deepEqual(resumedCalls, ['fixture:second']);
  assert.equal(resumed.summary.catalogRecords, 2);
  const cleared = JSON.parse(await readFile(join(cacheDir, 'scan-state.json'), 'utf8'));
  assert.equal(cleared.schemaVersion, 3);
  assert.deepEqual(cleared.completed, []);
});

test('a scan lock rejects overlapping writers and is released after completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-pipeline-lock-'));
  const dataDir = join(root, 'data');
  const cacheDir = join(root, 'cache');
  let started;
  let unblock;
  const didStart = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { unblock = resolve; });
  const base = {
    dataDir,
    cacheDir,
    generatedAt,
    initialJobs: [{ sourceId: 'fixture', sourceType: 'fixture', locator: 'fixture', phase: 1 }],
    queryBudget: 1,
    secondPass: false,
    fingerprintMode: 'metadata-only',
  };
  const first = runScanPipeline({
    ...base,
    discoveryRunner: async () => {
      started();
      await gate;
      return [video('locked-first', 'Rogal DDL - Locked')];
    },
  });
  await didStart;
  await assert.rejects(
    runScanPipeline({ ...base, discoveryRunner: async () => [video('overlap', 'Rogal DDL - Overlap')] }),
    (error) => error.code === 'SCAN_LOCKED',
  );
  unblock();
  await first;
  await assert.rejects(access(join(root, '.data.scan.lock')), (error) => error.code === 'ENOENT');
});

test('incremental update carries forward older records omitted by a bounded source snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-pipeline-update-'));
  const dataDir = join(root, 'data');
  const cacheDir = join(root, 'cache');
  const base = {
    dataDir,
    cacheDir,
    generatedAt,
    initialJobs: [{ sourceId: 'fixture', sourceType: 'fixture', locator: 'fixture', phase: 1 }],
    queryBudget: 1,
    secondPass: false,
    fingerprintMode: 'metadata-only',
  };
  await runScanPipeline({
    ...base,
    discoveryRunner: async () => [
      video('current-song', 'Rogal DDL - Current'),
      video('older-song', 'Rogal DDL - Older'),
    ],
  });
  const updated = await runScanPipeline({
    ...base,
    preservePrevious: true,
    discoveryRunner: async () => [video('current-song', 'Rogal DDL - Current')],
  });
  assert.deepEqual(updated.artifacts.catalog.records.map((record) => record.id), ['current-song', 'older-song']);
  assert.equal(updated.summary.carriedForwardRecords, 1);
  assert.ok(updated.artifacts.catalog.records.find((record) => record.id === 'older-song').provenance.some((item) => item.stale));
});

test('a technically valid false positive cannot replace a useful catalog with empty music output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-pipeline-useful-'));
  const dataDir = join(root, 'data');
  const cacheDir = join(root, 'cache');
  const base = {
    dataDir,
    cacheDir,
    generatedAt,
    initialJobs: [{ sourceId: 'fixture', sourceType: 'fixture', locator: 'fixture', phase: 1 }],
    queryBudget: 1,
    secondPass: false,
    fingerprintMode: 'metadata-only',
  };
  await runScanPipeline({ ...base, discoveryRunner: async () => [video('useful-song', 'Rogal DDL - Useful')] });
  const before = await readFile(join(dataDir, 'catalog.json'), 'utf8');
  await assert.rejects(
    runScanPipeline({ ...base, discoveryRunner: async () => [video('false-only', 'Rogal DDL - Reaction Podcast')] }),
    /No usable music records/,
  );
  assert.equal(await readFile(join(dataDir, 'catalog.json'), 'utf8'), before);
});

test('segments mode upgrades a cached full fingerprint that has no segment evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-pipeline-segments-'));
  const dataDir = join(root, 'data');
  const cacheDir = join(root, 'cache');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, 'fingerprints.json'), `${JSON.stringify({ 'segment-song': { fingerprint: 'full-only', duration: 180 } })}\n`);
  let calls = 0;
  const result = await runScanPipeline({
    dataDir,
    cacheDir,
    generatedAt,
    initialJobs: [{ sourceId: 'fixture', sourceType: 'fixture', locator: 'fixture', phase: 1 }],
    queryBudget: 1,
    secondPass: false,
    fingerprintMode: 'segments',
    discoveryRunner: async () => [video('segment-song', 'Rogal DDL - Segment Song', { duration: 180 })],
    fingerprintRunner: async () => {
      calls += 1;
      return {
        fingerprint: 'full-upgraded',
        duration: 180,
        segments: [{ start: 0, fingerprint: 'a' }, { start: 60, fingerprint: 'b' }],
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.artifacts.fingerprints.records[0].segments.length, 2);
});

test('segments refresh includes tracks carried forward from the previous generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-carried-segments-'));
  const base = {
    dataDir: join(root, 'data'),
    cacheDir: join(root, 'cache'),
    generatedAt,
    initialJobs: [{ sourceId: 'fixture', sourceType: 'fixture', locator: 'fixture', phase: 1 }],
    queryBudget: 1,
    secondPass: false,
  };
  await runScanPipeline({
    ...base,
    fingerprintMode: 'fingerprint-all',
    discoveryRunner: async () => [
      video('current-segment', 'Rogal DDL - Current Segment'),
      video('carried-segment', 'Rogal DDL - Carried Segment'),
    ],
    fingerprintRunner: async (record) => ({ fingerprint: `full-${record.id}`, duration: record.duration }),
  });
  const calls = [];
  const result = await runScanPipeline({
    ...base,
    preservePrevious: true,
    fingerprintMode: 'segments',
    refreshFingerprints: true,
    discoveryRunner: async () => [video('current-segment', 'Rogal DDL - Current Segment')],
    fingerprintRunner: async (record) => {
      calls.push(record.id);
      return {
        fingerprint: `segmented-${record.id}`,
        duration: record.duration,
        segments: [{ start: 0, fingerprint: 'a' }, { start: 60, fingerprint: 'b' }],
      };
    },
  });
  assert.deepEqual(calls.sort(), ['carried-segment', 'current-segment']);
  assert.ok(result.artifacts.fingerprints.records.every((entry) => entry.segments.length === 2));
});

test('fingerprint cache entries with a mismatched source signature are recomputed before dedupe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-stale-fingerprint-'));
  const dataDir = join(root, 'data');
  const cacheDir = join(root, 'cache');
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, 'fingerprints.json'), `${JSON.stringify({
    'fresh-a': { fingerprint: 'stale-shared', duration: 180, sourceSignature: 'stale-a' },
    'fresh-b': { fingerprint: 'stale-shared', duration: 180, sourceSignature: 'stale-b' },
  })}\n`);
  const calls = [];
  const result = await runScanPipeline({
    dataDir,
    cacheDir,
    generatedAt,
    initialJobs: [{ sourceId: 'fixture', sourceType: 'fixture', locator: 'fixture', phase: 1 }],
    queryBudget: 1,
    secondPass: false,
    fingerprintMode: 'candidates',
    discoveryRunner: async () => [
      video('fresh-a', 'Rogal DDL - Shared Song'),
      video('fresh-b', 'Rogal DDL - Shared Song (Official Audio)', {
        uploader: 'Independent Archive',
        uploader_id: '@archive',
        channel_id: 'archive',
      }),
    ],
    fingerprintRunner: async (record) => {
      calls.push(record.id);
      return { fingerprint: `fresh-${record.id}`, duration: record.duration, algorithm: 'fixture' };
    },
  });
  assert.deepEqual(calls.sort(), ['fresh-a', 'fresh-b']);
  assert.equal(result.artifacts.duplicates.decisions.some((decision) => decision.method === 'chromaprint'), false);
  assert.ok(result.artifacts.fingerprints.records.every((entry) => entry.sourceSignature !== 'stale-a' && entry.sourceSignature !== 'stale-b'));
});

test('current same-ID metadata invalidates a fingerprint even when the previous record is carried forward', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-same-id-fingerprint-refresh-'));
  const base = {
    dataDir: join(root, 'data'),
    cacheDir: join(root, 'cache'),
    generatedAt,
    initialJobs: [{ sourceId: 'fixture', sourceType: 'fixture', locator: 'fixture', phase: 1 }],
    queryBudget: 1,
    secondPass: false,
    fingerprintMode: 'fingerprint-all',
  };
  await runScanPipeline({
    ...base,
    discoveryRunner: async () => [video('same-id', 'Rogal DDL - Same ID', { duration: 180 })],
    fingerprintRunner: async () => ({ fingerprint: 'baseline', duration: 180 }),
  });
  let calls = 0;
  const updated = await runScanPipeline({
    ...base,
    preservePrevious: true,
    discoveryRunner: async () => [video('same-id', 'Rogal DDL - Same ID', { duration: 240 })],
    fingerprintRunner: async (record) => {
      calls += 1;
      return { fingerprint: 'refreshed', duration: record.duration };
    },
  });
  const published = updated.artifacts.catalog.records.find((record) => record.id === 'same-id');
  const fingerprint = updated.artifacts.fingerprints.records.find((entry) => entry.videoId === 'same-id');
  assert.equal(calls, 1);
  assert.equal(published.duration, 240);
  assert.equal(fingerprint.fingerprint, 'refreshed');
  assert.equal(fingerprint.sourceSignature, fingerprintSourceSignature(published));
});
