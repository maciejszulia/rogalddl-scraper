import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArtifacts } from '../lib/catalog.mjs';
import { fixtureRecords, video, provenance } from './fixtures.mjs';

const generatedAt = '2026-01-02T03:04:05.000Z';

test('the same YouTube ID from multiple sources occurs once and keeps provenance', () => {
  const artifacts = buildArtifacts(fixtureRecords().slice(0, 2), { generatedAt });
  assert.equal(artifacts.catalog.records.length, 1);
  assert.deepEqual(
    artifacts.catalog.records[0].provenance.map((item) => item.sourceId),
    ['channel:official', 'search:exact'],
  );
  assert.equal(artifacts.duplicates.decisions.length, 1);
  assert.equal(artifacts.duplicates.decisions[0].method, 'exact-youtube-id');
});

test('two uploads of the same master are merged by fingerprint with an auditable decision', () => {
  const records = fixtureRecords().slice(2, 4);
  const fingerprints = {
    'master-official': { fingerprint: 'fp-identical', duration: 201 },
    'master-reupload': { fingerprint: 'fp-identical', duration: 201.4 },
  };
  const artifacts = buildArtifacts(records, { fingerprints, generatedAt });
  assert.deepEqual(artifacts.catalog.records.map((record) => record.id), ['master-official']);
  assert.equal(artifacts.duplicates.decisions.length, 1);
  const [decision] = artifacts.duplicates.decisions;
  assert.equal(decision.winner.id, 'master-official');
  assert.deepEqual(decision.copies.map((record) => record.id), ['master-reupload']);
  assert.equal(decision.method, 'chromaprint');
  assert.equal(decision.score, 1);
  assert.equal(decision.threshold, 0.98);
  assert.ok(decision.features.fingerprint);
  assert.ok(decision.provenance.winner.length > 0);
  assert.ok(decision.provenance.copies['master-reupload'].length > 0);
});

test('two matching Chromaprint segments can prove a shared master with a short intro difference', () => {
  const records = [
    video('segment-a', 'Rogal DDL - Segment Song', { duration: 190 }),
    video('segment-b', 'Rogal DDL - Segment Song (Official Audio)', { duration: 198, uploader: 'Label' }),
  ];
  const fingerprints = {
    'segment-a': { fingerprint: 'full-a', segments: [{ fingerprint: 's1' }, { fingerprint: 's2' }, { fingerprint: 's3' }] },
    'segment-b': { fingerprint: 'full-b', segments: [{ fingerprint: 'x1' }, { fingerprint: 's2' }, { fingerprint: 's3' }] },
  };
  const artifacts = buildArtifacts(records, { fingerprints, generatedAt });
  assert.equal(artifacts.catalog.records.length, 1);
  assert.equal(artifacts.duplicates.decisions[0].method, 'chromaprint-segments');
  assert.equal(artifacts.duplicates.decisions[0].features.matchingSegments, 2);
});

test('original and explicit alternate versions remain separate even with matching fingerprints', () => {
  const records = [
    ...fixtureRecords().slice(2, 9),
    video('acoustic', 'Rogal DDL - Światła Acoustic'),
    video('demo', 'Rogal DDL - Światła Demo'),
    video('remaster', 'Rogal DDL - Światła Remastered 2025'),
    video('cover', 'Rogal DDL - Światła Cover'),
  ];
  const sameFingerprint = Object.fromEntries(
    records.map((record) => [record.id, { fingerprint: 'same-on-purpose', duration: record.duration }]),
  );
  const artifacts = buildArtifacts(records, { fingerprints: sameFingerprint, generatedAt });
  assert.deepEqual(
    artifacts.catalog.records.map((record) => record.id).sort(),
    ['acoustic', 'cover', 'demo', 'instrumental', 'live', 'master-official', 'remaster', 'remix', 'slowed', 'sped'].sort(),
  );
});

test('an uncertain metadata-only duplicate stays in catalog and goes to review', () => {
  const records = fixtureRecords().slice(9, 11);
  const artifacts = buildArtifacts(records, { generatedAt });
  assert.equal(artifacts.catalog.records.length, 2);
  assert.equal(artifacts.review.cases.length, 1);
  assert.deepEqual(artifacts.review.cases[0].recordIds, ['uncertain-a', 'uncertain-b']);
  assert.equal(artifacts.review.cases[0].reason, 'possible-duplicate-needs-audio-evidence');
});

test('long-form and rejected records are preserved but excluded from the main playlist', () => {
  const records = fixtureRecords().slice(11);
  const artifacts = buildArtifacts(records, { generatedAt });
  assert.equal(artifacts.catalog.records.length, 0);
  assert.deepEqual(artifacts.longForm.records.map((record) => record.id), ['album']);
  assert.equal(artifacts.longForm.records[0].chapterStatus, 'missing');
  assert.deepEqual(artifacts.longForm.unsegmented.map((record) => record.id), ['album']);
  assert.equal(artifacts.summary.unsegmentedLongForm, 1);
  assert.deepEqual(artifacts.rejected.records.map((record) => record.id).sort(), ['podcast', 'wrong']);
  assert.match(artifacts.rejected.records.find((record) => record.id === 'podcast').rejection.reason, /spoken-content/);
});

test('long-form chapters map to singles and missing tracks become bounded MPV segments', () => {
  const single = video('single-track', 'Rogal DDL - Existing Track', { duration: 180 });
  const album = video('chapter-album', 'Rogal DDL - Full Album', {
    duration: 1200,
    chapters: [
      { title: 'Existing Track', start_time: 0, end_time: 180 },
      { title: 'Missing Track', start_time: 180, end_time: 360 },
    ],
  });
  const artifacts = buildArtifacts([album, single], { generatedAt });
  assert.equal(artifacts.longForm.records[0].chapterStatus, 'available');
  assert.equal(artifacts.longForm.unsegmented.length, 0);
  assert.equal(artifacts.longForm.records[0].chapters[0].mappedRecordId, 'single-track');
  assert.equal(artifacts.longForm.missingSegments.length, 1);
  assert.match(artifacts.playlist, /edl:\/\/%/);
  assert.doesNotMatch(artifacts.playlist, /Full Album/);
});

test('untrusted source URLs cannot inject an MPV target and Shorts remain classified', () => {
  const hostile = video('safe-video-id', 'Rogal DDL - Safe Song', {
    webpage_url: 'https://127.0.0.1/private\n#EXTM3U',
  });
  const short = video('short-video-id', 'Rogal DDL - Short Song', {
    webpage_url: 'https://www.youtube.com/shorts/short-video-id',
  });
  const artifacts = buildArtifacts([hostile, short], { generatedAt });
  assert.match(artifacts.playlist, /https:\/\/www\.youtube\.com\/watch\?v=safe-video-id/);
  assert.doesNotMatch(artifacts.playlist, /127\.0\.0\.1|#EXTM3U\n#EXTM3U/);
  assert.equal(artifacts.rejected.records.find((record) => record.id === 'short-video-id').rejection.reason, 'short-form-video');
});

test('manual keep, merge and reject overrides are honored and audited', () => {
  const a = video('override-a', 'Rogal DDL - Override');
  const b = video('override-b', 'Rogal DDL - Override (Official Audio)', {
    uploader: 'Label',
    uploader_id: '@label',
    channel_id: 'label',
    provenance: [provenance('search:exact')],
  });
  const c = video('override-c', 'Rogal DDL - Remove Me');
  const keep = buildArtifacts([a, b], {
    fingerprints: {
      'override-a': { fingerprint: 'same', duration: 180 },
      'override-b': { fingerprint: 'same', duration: 180 },
    },
    overrides: { schemaVersion: 1, keep: [['override-a', 'override-b']], merge: [], reject: [] },
    generatedAt,
  });
  assert.equal(keep.catalog.records.length, 2);

  const merged = buildArtifacts([a, b, c], {
    overrides: {
      schemaVersion: 1,
      keep: [],
      merge: [{ winner: 'override-b', copies: ['override-a'], reason: 'owner verified master' }],
      reject: [{ id: 'override-c', reason: 'owner verified false match' }],
    },
    generatedAt,
  });
  assert.deepEqual(merged.catalog.records.map((record) => record.id), ['override-b']);
  assert.equal(merged.duplicates.decisions[0].method, 'manual-override');
  assert.deepEqual(merged.rejected.records.map((record) => record.id), ['override-c']);

  assert.throws(() => buildArtifacts([a, b], {
    overrides: {
      schemaVersion: 1,
      keep: [['override-a', 'override-b']],
      merge: [{ winner: 'override-a', copies: ['override-b'], reason: 'conflict' }],
      reject: [],
    },
    generatedAt,
  }), /override conflict/i);

  assert.throws(() => buildArtifacts([a, b, c], {
    overrides: {
      schemaVersion: 1,
      keep: [],
      merge: [
        { winner: 'override-a', copies: ['override-b'] },
        { winner: 'override-b', copies: ['override-c'] },
      ],
      reject: [],
    },
    generatedAt,
  }), /both merge winner and copy/i);
});

test('artifacts are deterministic, sorted and schema-versioned', () => {
  const records = fixtureRecords().toReversed();
  const options = { generatedAt, fingerprints: {
    'master-official': { fingerprint: 'fp-identical', duration: 201 },
    'master-reupload': { fingerprint: 'fp-identical', duration: 201.4 },
  } };
  const first = buildArtifacts(records, options);
  const second = buildArtifacts(records.toReversed(), options);
  assert.deepEqual(first, second);
  for (const artifact of [first.catalog, first.duplicates, first.review, first.longForm, first.rejected, first.fingerprints, first.summary, first.raw]) {
    assert.equal(artifact.schemaVersion, 1);
  }
});

test('exact-ID enrichment and featuring normalization are input-order independent', () => {
  const left = video('same-order-id', 'Rogal DDL feat. Test MC - Zielone Światło', {
    uploader: 'Uploader B',
    duration: 222,
  });
  const right = video('same-order-id', 'Rogal DDL - Zielone Światło feat. Test MC', {
    uploader: 'Uploader A',
    duration: 111,
  });
  const first = buildArtifacts([left, right], { generatedAt });
  const reversed = buildArtifacts([right, left], { generatedAt });
  assert.deepEqual(first, reversed);
  assert.equal(first.catalog.records[0].normalizedTitle, 'zielone swiatlo');
  assert.equal(first.catalog.records[0].normalizedArtist, 'rogal ddl');
});

test('fingerprint artifacts exclude cache entries absent from this generation', () => {
  const artifacts = buildArtifacts([video('active-fp-id', 'Rogal DDL - Active')], {
    generatedAt,
    fingerprints: {
      'active-fp-id': { fingerprint: 'active' },
      'stale-fp-id': { fingerprint: 'stale' },
    },
  });
  assert.deepEqual(artifacts.fingerprints.records.map((record) => record.id), ['active-fp-id']);
  assert.equal(artifacts.summary.fingerprintRecords, 1);
});
