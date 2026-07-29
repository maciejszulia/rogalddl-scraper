import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInitialJobs,
  buildSecondPassJobs,
  discover,
} from '../lib/discovery.mjs';
import { discoveryJobKey, JsonDirectoryCache } from '../lib/cache.mjs';
import { video } from './fixtures.mjs';

test('initial discovery contains mandatory channels and supported search variants', () => {
  const jobs = buildInitialJobs({ resultLimit: 7 });
  const locators = jobs.map((job) => job.locator);
  assert.ok(locators.includes('https://www.youtube.com/channel/UCp2d6_I25e30nk7Eb4ri2Ng/videos'));
  assert.ok(locators.includes('https://www.youtube.com/channel/UCXu4ORG2S5VTmppGmKbzntw'));
  assert.ok(jobs.filter((job) => job.sourceType === 'channel').every((job) => job.resultLimit === 7));
  assert.ok(locators.some((locator) => locator === 'ytsearch7:"Rogal DDL"'));
  for (const term of ['remix', 'bootleg', 'mashup', 'edit', 'rework', 'instrumental', 'acapella', 'live', 'freestyle', 'slowed', 'sped up', 'feat', 'ft', 'prod']) {
    assert.ok(locators.some((locator) => locator.toLowerCase().includes(term)), term);
  }
  assert.ok(locators.every((locator) => !locator.includes('ytsearchdate')));
});

test('one failed query does not stop discovery and a checkpoint follows every job', async () => {
  const checkpoints = [];
  const jobs = [
    { sourceId: 'search:fail', sourceType: 'search', locator: 'ytsearch2:fail', phase: 1 },
    { sourceId: 'search:ok', sourceType: 'search', locator: 'ytsearch2:ok', phase: 1 },
  ];
  const result = await discover({
    initialJobs: jobs,
    queryBudget: 2,
    secondPass: false,
    runJob: async (job) => {
      if (job.sourceId === 'search:fail') throw new Error('temporary YouTube failure');
      return [video('found', 'Rogal DDL - Found')];
    },
    checkpoint: async (state) => checkpoints.push(structuredClone(state)),
  });
  assert.deepEqual(result.records.map((record) => record.id), ['found']);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].sourceId, 'search:fail');
  assert.equal(checkpoints.length, 2);
});

test('partial adapter output preserves valid records and marks the generation partial', async () => {
  const result = await discover({
    initialJobs: [{ sourceId: 'search:partial', sourceType: 'search', locator: 'ytsearch2:partial', phase: 1 }],
    queryBudget: 1,
    secondPass: false,
    runJob: async () => ({
      records: [video('partial-record', 'Rogal DDL - Partial Record')],
      warnings: [{ code: 'YTDLP_PARTIAL_OUTPUT', error: 'one malformed row was ignored' }],
    }),
  });
  assert.deepEqual(result.records.map((record) => record.id), ['partial-record']);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].warning, true);
  assert.equal(result.completed[0].recordCount, 1);
});

test('second pass is generated from discovered track and collaborator names without duplicate queries', () => {
  const records = [
    video('one', 'Rogal DDL feat. Test MC - Zielone Światło (prod. Beat Man)'),
    video('two', 'Rogal DDL feat. Test MC - Zielone Światło (Official Audio)'),
    video('noise', 'Completely Different Artist - Unrelated Song', {
      uploader: 'Someone Else',
      uploader_id: '@someoneelse',
      channel_id: 'other-channel',
      provenance: [{ sourceId: 'search:noise', sourceType: 'search', locator: 'fixture', phase: 1 }],
    }),
  ];
  const jobs = buildSecondPassJobs(records, { resultLimit: 5, limit: 10 });
  assert.ok(jobs.some((job) => job.locator.includes('Zielone Światło')));
  assert.ok(jobs.some((job) => /Test MC|Beat Man/.test(job.locator)));
  assert.equal(new Set(jobs.map((job) => job.locator)).size, jobs.length);
  assert.ok(jobs.every((job) => job.phase === 2));
  assert.ok(jobs.every((job) => !job.locator.includes('Unrelated Song')));
});

test('query budget caps both passes and cached jobs are not executed again', async () => {
  const calls = [];
  const jobs = [
    { sourceId: 'search:a', sourceType: 'search', locator: 'ytsearch1:a', phase: 1 },
    { sourceId: 'search:b', sourceType: 'search', locator: 'ytsearch1:b', phase: 1 },
    { sourceId: 'search:c', sourceType: 'search', locator: 'ytsearch1:c', phase: 1 },
  ];
  const cache = new Map([[discoveryJobKey(jobs[0]), { records: [video('cached', 'Rogal DDL - Cached')] }]]);
  const result = await discover({
    initialJobs: jobs,
    queryBudget: 2,
    secondPass: true,
    cache,
    runJob: async (job) => {
      calls.push(job.sourceId);
      return [video(job.sourceId, `Rogal DDL - ${job.sourceId}`)];
    },
  });
  assert.deepEqual(calls, ['search:b']);
  assert.equal(result.completed.length, 2);
  assert.equal(result.budget.exhausted, true);
  assert.ok(result.records.some((record) => record.id === 'cached'));
});

test('generic cache adapters use full semantic job identity without keyFor', async () => {
  const cache = new Map();
  let calls = 0;
  const run = (resultLimit) => discover({
    initialJobs: [{
      sourceId: 'same-source',
      sourceType: 'channel',
      locator: 'https://example.invalid/channel',
      phase: 1,
      resultLimit,
    }],
    queryBudget: 1,
    resultLimit,
    secondPass: false,
    cache,
    runJob: async () => {
      calls += 1;
      return [video(`result-${resultLimit}`, `Rogal DDL - Result ${resultLimit}`)];
    },
  });
  const first = await run(1);
  const second = await run(2);
  assert.equal(calls, 2);
  assert.deepEqual(first.records.map((record) => record.id), ['result-1']);
  assert.deepEqual(second.records.map((record) => record.id), ['result-2']);
  assert.equal(cache.size, 2);
});

test('cache and resume identity include locator and result limit', async () => {
  const cache = new JsonDirectoryCache('/tmp/not-used');
  const base = { sourceId: 'channel:official', sourceType: 'channel', locator: 'https://example.invalid/channel', phase: 1 };
  assert.notEqual(cache.keyFor({ ...base, resultLimit: 3 }), cache.keyFor({ ...base, resultLimit: 25 }));

  let checkpoint;
  await discover({
    initialJobs: [{ ...base, resultLimit: 3 }],
    queryBudget: 1,
    resultLimit: 3,
    secondPass: false,
    runJob: async () => [video('old-cache-id', 'Rogal DDL - Old Cache')],
    checkpoint: async (state) => { checkpoint = structuredClone(state); },
  });
  const calls = [];
  const resumed = await discover({
    initialJobs: [{ ...base, resultLimit: 25 }],
    queryBudget: 1,
    resultLimit: 25,
    secondPass: false,
    resumeState: checkpoint,
    runJob: async (job) => {
      calls.push(job.resultLimit);
      return [video('fresh-cache-id', 'Rogal DDL - Fresh Cache')];
    },
  });
  assert.deepEqual(calls, [25]);
  assert.deepEqual(resumed.records.map((record) => record.id), ['fresh-cache-id']);
});

test('resume continues the original second-pass queue instead of branching from phase-two results', async () => {
  const initialJobs = [{ sourceId: 'seed', sourceType: 'fixture', locator: 'seed', phase: 1, resultLimit: 2 }];
  const controller = new AbortController();
  let checkpoint;
  const common = {
    initialJobs,
    queryBudget: 3,
    concurrency: 1,
    secondPass: true,
    secondPassLimit: 10,
    resultLimit: 2,
    signal: controller.signal,
    checkpoint: async (state) => { checkpoint = structuredClone(state); },
  };
  await assert.rejects(discover({
    ...common,
    runJob: async (job) => {
      if (job.phase === 1) return [
        video('seed-a', 'Rogal DDL - Seed A'),
        video('seed-b', 'Rogal DDL - Seed B'),
      ];
      if (job.locator.includes('Seed A')) return [video('00-new-branch', 'Rogal DDL - New Branch')];
      controller.abort();
      throw Object.assign(new Error('interrupted during Seed B'), { code: 'PROCESS_ABORTED' });
    },
  }), (error) => error.code === 'PROCESS_ABORTED');

  const resumedCalls = [];
  await discover({
    ...common,
    signal: undefined,
    resumeState: checkpoint,
    checkpoint: async () => {},
    runJob: async (job) => {
      resumedCalls.push(job.locator);
      return [video('seed-b-result', 'Rogal DDL - Seed B Result')];
    },
  });
  assert.equal(resumedCalls.length, 1);
  assert.match(resumedCalls[0], /Seed B/);
  assert.doesNotMatch(resumedCalls[0], /New Branch/);
});
