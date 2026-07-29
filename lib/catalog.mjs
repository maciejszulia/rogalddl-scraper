import { classifyRecord, mergeSameId, normalizeRecord, canonicalText } from './classify.mjs';
import { deduplicateRecords, rejectedOverrideIds } from './dedupe.mjs';
import { sanitizeMetadata } from './security.mjs';

export const SCHEMA_VERSION = 1;

function envelope(generatedAt, fields) {
  return { schemaVersion: SCHEMA_VERSION, generatedAt, ...fields };
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sortRaw(records) {
  return records
    .map((record) => sanitizeMetadata(record))
    .sort((left, right) => (
      String(left.id ?? '').localeCompare(String(right.id ?? '')) ||
      stableJson(left).localeCompare(stableJson(right))
    ));
}

function groupById(rawRecords) {
  const groups = new Map();
  const invalid = [];
  for (const raw of rawRecords) {
    try {
      const record = normalizeRecord(raw);
      const group = groups.get(record.id) ?? [];
      group.push(record);
      groups.set(record.id, group);
    } catch (error) {
      invalid.push({
        raw: sanitizeMetadata(raw),
        rejection: { category: 'invalid-record', reason: String(error.message || error) },
      });
    }
  }
  const records = [];
  const decisions = [];
  for (const group of [...groups.values()].sort((a, b) => a[0].id.localeCompare(b[0].id))) {
    const winner = mergeSameId(group);
    records.push(winner);
    if (group.length > 1) {
      const observations = [...group].sort((a, b) => (
        stableJson(a.provenance).localeCompare(stableJson(b.provenance))
        || stableJson(a).localeCompare(stableJson(b))
      ));
      decisions.push({
        winner: structuredClone(winner),
        copies: structuredClone(observations.slice(1)),
        method: 'exact-youtube-id',
        score: 1,
        threshold: 1,
        features: {
          youtubeId: winner.id,
          observationCount: observations.length,
          sourceIds: [...new Set(winner.provenance.map((item) => item.sourceId))].sort(),
        },
        provenance: {
          winner: structuredClone(winner.provenance),
          copies: Object.fromEntries(observations.slice(1).map((record, index) => [
            `observation-${index + 2}`,
            structuredClone(record.provenance),
          ])),
        },
      });
    }
  }
  return { records, decisions, invalid };
}

function recordSort(left, right) {
  return (
    left.normalizedArtist.localeCompare(right.normalizedArtist) ||
    left.normalizedTitle.localeCompare(right.normalizedTitle) ||
    left.variantKey.localeCompare(right.variantKey) ||
    left.id.localeCompare(right.id)
  );
}

function playlistLabel(record) {
  const variant = record.variantKey === 'original' ? '' : ` [${record.variantKey}]`;
  return `${record.artist} - ${record.trackTitle}${variant}`.replace(/[\u0000-\u001f\u007f-\u009f,]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function toSegmentEdl(url, start, end) {
  const source = `ytdl://${url}`;
  const length = Math.max(0, end - start);
  return `edl://%${Buffer.byteLength(source)}%${source},${start},${length}`;
}

export function renderPlaylist(records, segmentRecords = []) {
  const lines = ['#EXTM3U'];
  for (const record of [...records].sort(recordSort)) {
    const duration = Number.isFinite(record.duration) ? Math.round(record.duration) : -1;
    lines.push(`#EXTINF:${duration},${playlistLabel(record)}`);
    lines.push(record.url);
  }
  for (const segment of [...segmentRecords].sort((a, b) => a.title.localeCompare(b.title) || a.start - b.start)) {
    lines.push(`#EXTINF:${Math.round(segment.end - segment.start)},${segment.title.replace(/[\u0000-\u001f\u007f-\u009f,]+/g, ' ')}`);
    lines.push(toSegmentEdl(segment.url, segment.start, segment.end));
  }
  return `${lines.join('\n')}\n`;
}

function tokenSimilarity(left, right) {
  const a = new Set(canonicalText(left).replace(/\brogal ddl\b/g, '').split(' ').filter(Boolean));
  const b = new Set(canonicalText(right).replace(/\brogal ddl\b/g, '').split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}

function mapLongFormChapters(longFormRecords, catalogRecords) {
  const missingSegments = [];
  const unsegmented = [];
  const records = longFormRecords.map((record) => {
    if (!record.chapters.length) {
      unsegmented.push({
        id: record.id,
        title: record.title,
        url: record.url,
        duration: record.duration,
        reason: 'chapters-unavailable',
        provenance: record.provenance,
      });
      return { ...record, chapterStatus: 'missing' };
    }
    const chapters = record.chapters.map((chapter) => {
      const matches = catalogRecords
        .map((candidate) => ({ candidate, score: tokenSimilarity(chapter.title, candidate.trackTitle) }))
        .filter((item) => item.score >= 0.8)
        .sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
      if (matches.length) {
        return { ...chapter, mappedRecordId: matches[0].candidate.id, mappingScore: matches[0].score };
      }
      const segment = {
        id: `${record.id}:${chapter.start}-${chapter.end}`,
        parentId: record.id,
        title: chapter.title,
        url: record.url,
        start: chapter.start,
        end: chapter.end,
        provenance: record.provenance,
      };
      missingSegments.push(segment);
      return { ...chapter, segmentId: segment.id };
    });
    return { ...record, chapters, chapterStatus: 'available' };
  });
  return {
    records: records.sort(recordSort),
    missingSegments: missingSegments.sort((a, b) => a.id.localeCompare(b.id)),
    unsegmented: unsegmented.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function fingerprintEntries(fingerprints, activeIds) {
  return Object.entries(fingerprints ?? {})
    .filter(([id]) => activeIds.has(id))
    .map(([id, value]) => ({ id, ...sanitizeMetadata(value) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function buildArtifacts(rawRecords, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const overrides = options.overrides ?? { schemaVersion: 1, keep: [], merge: [], reject: [] };
  const { records: uniqueRecords, decisions: exactIdDecisions, invalid } = groupById(Array.isArray(rawRecords) ? rawRecords : []);
  const manualRejects = rejectedOverrideIds(overrides);
  const music = [];
  const longForm = [];
  const rejected = [...invalid];
  const classificationReview = [];

  for (const record of uniqueRecords) {
    if (manualRejects.has(record.id)) {
      rejected.push({
        ...record,
        rejection: { category: 'manual-reject', reason: manualRejects.get(record.id) },
      });
      continue;
    }
    const classification = classifyRecord(record);
    if (classification.category === 'track' || classification.category === 'alternate-version') {
      music.push({ ...record, classification });
    } else if (classification.category === 'long-form') {
      longForm.push({ ...record, classification });
    } else if (classification.category === 'review') {
      classificationReview.push({
        recordIds: [record.id],
        reason: classification.reason,
        method: 'classification',
        score: null,
        threshold: null,
        features: { title: record.title },
        provenance: { [record.id]: record.provenance },
      });
    } else {
      rejected.push({ ...record, rejection: classification });
    }
  }

  const deduplicated = deduplicateRecords(music, {
    fingerprints: options.fingerprints ?? {},
    overrides,
  });
  const catalogRecords = deduplicated.records.sort(recordSort);
  const chapterMapping = mapLongFormChapters(longForm, catalogRecords);
  const rejectedRecords = rejected.sort((left, right) => String(left.id ?? '').localeCompare(String(right.id ?? '')));
  const reviewCases = [...classificationReview, ...deduplicated.review]
    .sort((left, right) => left.recordIds.join().localeCompare(right.recordIds.join()));
  const activeIds = new Set(uniqueRecords.map((record) => record.id));
  const fingerprintRecords = fingerprintEntries(options.fingerprints, activeIds);
  const failures = Array.isArray(options.failures) ? sanitizeMetadata(options.failures) : [];
  const queryBudget = options.queryBudget ? sanitizeMetadata(options.queryBudget) : null;
  const cacheHits = Number(options.cacheHits ?? 0);

  const catalog = envelope(generatedAt, { records: catalogRecords });
  const duplicateDecisions = [...exactIdDecisions, ...deduplicated.decisions]
    .sort((left, right) => left.winner.id.localeCompare(right.winner.id) || left.method.localeCompare(right.method));
  const duplicates = envelope(generatedAt, { decisions: duplicateDecisions });
  const review = envelope(generatedAt, { cases: reviewCases });
  const longFormArtifact = envelope(generatedAt, {
    records: chapterMapping.records,
    missingSegments: chapterMapping.missingSegments,
    unsegmented: chapterMapping.unsegmented,
  });
  const rejectedArtifact = envelope(generatedAt, { records: rejectedRecords });
  const fingerprintCapability = sanitizeMetadata(options.fingerprintCapability ?? {
    available: null,
    reason: 'not-reported',
  });
  const fingerprintArtifact = envelope(generatedAt, { capability: fingerprintCapability, records: fingerprintRecords });
  const raw = envelope(generatedAt, {
    records: sortRaw(Array.isArray(rawRecords) ? rawRecords : []),
    failures,
    queryBudget,
  });
  const summary = envelope(generatedAt, {
    status: failures.length ? 'partial' : 'complete',
    rawRecords: raw.records.length,
    uniqueVideoIds: uniqueRecords.length,
    catalogRecords: catalogRecords.length,
    duplicateGroups: duplicateDecisions.length,
    reviewCases: reviewCases.length,
    longFormRecords: chapterMapping.records.length,
    chapterSegments: chapterMapping.missingSegments.length,
    unsegmentedLongForm: chapterMapping.unsegmented.length,
    carriedForwardRecords: new Set(options.carriedForwardIds ?? []).size,
    rejectedRecords: rejectedRecords.length,
    fingerprintRecords: fingerprintRecords.length,
    fingerprintCapability,
    failedQueries: failures.length,
    cacheHits: Number.isFinite(cacheHits) ? cacheHits : 0,
    queryBudget,
    failures,
  });

  return {
    catalog,
    duplicates,
    review,
    longForm: longFormArtifact,
    rejected: rejectedArtifact,
    fingerprints: fingerprintArtifact,
    summary,
    raw,
    playlist: renderPlaylist(catalogRecords, chapterMapping.missingSegments),
  };
}
