import { canonicalText, metadataCompleteness } from './classify.mjs';

const OFFICIAL_TOPIC_ID = 'UCXu4ORG2S5VTmppGmKbzntw';
const FINGERPRINT_THRESHOLD = 0.98;
const REVIEW_THRESHOLD = 0.82;

function pairKey(left, right) {
  return [String(left), String(right)].sort().join('\u0000');
}

function tokens(value) {
  return new Set(canonicalText(value).split(' ').filter(Boolean));
}

function jaccard(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size && !b.size) return 1;
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function durationFeatures(left, right) {
  if (!Number.isFinite(left.duration) || !Number.isFinite(right.duration)) {
    return { differenceSeconds: null, similarity: 0.5, compatible: true };
  }
  const differenceSeconds = Math.abs(left.duration - right.duration);
  const tolerance = Math.max(3, Math.min(left.duration, right.duration) * 0.03);
  return {
    differenceSeconds,
    toleranceSeconds: tolerance,
    similarity: Math.max(0, 1 - differenceSeconds / Math.max(tolerance, 1)),
    compatible: differenceSeconds <= tolerance,
  };
}

function metadataFeatures(left, right) {
  const duration = durationFeatures(left, right);
  const titleSimilarity = jaccard(left.normalizedTitle, right.normalizedTitle);
  const artistSimilarity = jaccard(left.normalizedArtist, right.normalizedArtist);
  const score = Number((titleSimilarity * 0.65 + duration.similarity * 0.2 + artistSimilarity * 0.15).toFixed(4));
  return {
    titleSimilarity,
    artistSimilarity,
    durationDifferenceSeconds: duration.differenceSeconds,
    durationToleranceSeconds: duration.toleranceSeconds ?? null,
    durationCompatible: duration.compatible,
    score,
  };
}

function matchingSegmentFeatures(left, right, fingerprints) {
  const leftSegments = Array.isArray(fingerprints[left.id]?.segments) ? fingerprints[left.id].segments : [];
  const rightSegments = Array.isArray(fingerprints[right.id]?.segments) ? fingerprints[right.id].segments : [];
  const comparedSegments = Math.min(leftSegments.length, rightSegments.length);
  let matchingSegments = 0;
  for (let index = 0; index < comparedSegments; index += 1) {
    const leftFingerprint = leftSegments[index]?.fingerprint;
    const rightFingerprint = rightSegments[index]?.fingerprint;
    if (leftFingerprint && rightFingerprint && leftFingerprint === rightFingerprint) matchingSegments += 1;
  }
  const durationDifferenceSeconds = Number.isFinite(left.duration) && Number.isFinite(right.duration)
    ? Math.abs(left.duration - right.duration)
    : null;
  const durationToleranceSeconds = Number.isFinite(left.duration) && Number.isFinite(right.duration)
    ? Math.max(20, Math.min(left.duration, right.duration) * 0.1)
    : 20;
  const metadata = metadataFeatures(left, right);
  return {
    matchingSegments,
    comparedSegments,
    segmentAgreement: comparedSegments ? Number((matchingSegments / comparedSegments).toFixed(4)) : 0,
    durationDifferenceSeconds,
    durationToleranceSeconds,
    titleSimilarity: metadata.titleSimilarity,
    artistSimilarity: metadata.artistSimilarity,
    compatible: comparedSegments >= 2
      && matchingSegments >= 2
      && metadata.titleSimilarity >= 0.95
      && metadata.artistSimilarity >= 0.9
      && (durationDifferenceSeconds === null || durationDifferenceSeconds <= durationToleranceSeconds),
  };
}

function officialRank(record) {
  if (record.provenance.some((item) => item.sourceId === 'channel:official') || /^@?rogalddl$/i.test(record.uploaderId)) return 5;
  if (record.provenance.some((item) => item.sourceId === 'channel:topic') || record.channelId === OFFICIAL_TOPIC_ID) return 4;
  if (/\b(?:records|label|music|official|prod(?:ucer)?)\b/i.test(`${record.uploader} ${record.uploaderId}`)) return 3;
  return 1;
}

function audioQuality(record) {
  return Number(record.bestAudioFormat?.abr ?? record.bestAudioFormat?.tbr ?? 0);
}

function availabilityRank(record) {
  return /^(?:public|unlisted|unknown)$/i.test(record.availability) ? 1 : 0;
}

export function comparePreferredUploads(left, right) {
  return (
    officialRank(right) - officialRank(left) ||
    metadataCompleteness(right) - metadataCompleteness(left) ||
    audioQuality(right) - audioQuality(left) ||
    availabilityRank(right) - availabilityRank(left) ||
    Math.log10((right.viewCount ?? 0) + 1) - Math.log10((left.viewCount ?? 0) + 1) ||
    left.id.localeCompare(right.id)
  );
}

function provenanceMap(winner, copies) {
  return {
    winner: structuredClone(winner.provenance),
    copies: Object.fromEntries(copies.map((record) => [record.id, structuredClone(record.provenance)])),
  };
}

function decision(winner, copies, method, score, threshold, features) {
  const sortedCopies = [...copies].sort((a, b) => a.id.localeCompare(b.id));
  return {
    winner: structuredClone(winner),
    copies: structuredClone(sortedCopies),
    method,
    score,
    threshold,
    features,
    provenance: provenanceMap(winner, sortedCopies),
  };
}

export function normalizeOverrides(overrides = {}) {
  if (overrides.schemaVersion !== undefined && overrides.schemaVersion !== 1) {
    throw new TypeError(`unsupported overrides schemaVersion: ${overrides.schemaVersion}`);
  }
  for (const field of ['keep', 'merge', 'reject']) {
    if (overrides[field] !== undefined && !Array.isArray(overrides[field])) {
      throw new TypeError(`${field} overrides must be an array`);
    }
  }
  const identifier = (value, label) => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
    return value.trim();
  };
  const reason = (value, fallback, label) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
    return value.trim();
  };
  const keep = (Array.isArray(overrides.keep) ? overrides.keep : []).map((item, index) => {
    if (!Array.isArray(item) || item.length !== 2) {
      throw new TypeError(`invalid keep override at index ${index}`);
    }
    const left = identifier(item[0], `keep override ${index} left identifier`);
    const right = identifier(item[1], `keep override ${index} right identifier`);
    if (left === right) throw new TypeError(`invalid keep override at index ${index}`);
    return [left, right];
  });
  const merge = (Array.isArray(overrides.merge) ? overrides.merge : []).map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !Array.isArray(item.copies) || !item.copies.length) {
      throw new TypeError(`invalid merge override at index ${index}`);
    }
    const winner = identifier(item.winner, `merge override ${index} winner`);
    const copies = [...new Set(item.copies.map((copy, copyIndex) => identifier(copy, `merge override ${index} copy ${copyIndex}`)))];
    if (copies.some((copy) => copy === winner)) throw new TypeError(`invalid merge override at index ${index}`);
    return { winner, copies, reason: reason(item.reason, 'manual merge', `merge override ${index} reason`) };
  });
  const reject = (Array.isArray(overrides.reject) ? overrides.reject : []).map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError(`invalid reject override at index ${index}`);
    return {
      id: identifier(item.id, `reject override ${index} identifier`),
      reason: reason(item.reason, 'manual reject', `reject override ${index} reason`),
    };
  });
  const keepPairs = new Set(keep.map(([left, right]) => pairKey(left, right)));
  const rejected = new Set(reject.map((item) => item.id));
  const mergeWinners = new Set(merge.map((item) => item.winner));
  const mergedCopies = new Map();
  for (const item of merge) {
    if (rejected.has(item.winner)) throw new TypeError(`override conflict: ${item.winner} is both merge winner and rejected`);
    for (const copy of item.copies) {
      if (mergeWinners.has(copy)) throw new TypeError(`override conflict: ${copy} is both merge winner and copy`);
      if (keepPairs.has(pairKey(item.winner, copy))) throw new TypeError(`override conflict: ${item.winner} and ${copy} are both kept and merged`);
      if (rejected.has(copy)) throw new TypeError(`override conflict: ${copy} is both merged and rejected`);
      if (mergedCopies.has(copy) && mergedCopies.get(copy) !== item.winner) throw new TypeError(`override conflict: ${copy} has multiple winners`);
      mergedCopies.set(copy, item.winner);
    }
  }
  return { schemaVersion: 1, keep, merge, reject };
}

export function rejectedOverrideIds(overrides = {}) {
  return new Map(normalizeOverrides(overrides).reject
    .filter((item) => item && item.id)
    .map((item) => [String(item.id), String(item.reason || 'manual reject')]));
}

export function findFingerprintCandidates(records) {
  const ordered = [...records].sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set();
  const pairs = [];
  for (let index = 0; index < ordered.length; index += 1) {
    for (let other = index + 1; other < ordered.length; other += 1) {
      const left = ordered[index];
      const right = ordered[other];
      if (left.variantKey !== right.variantKey) continue;
      if (!Number.isFinite(left.duration) || left.duration <= 0 || !Number.isFinite(right.duration) || right.duration <= 0) continue;
      const features = metadataFeatures(left, right);
      if (features.titleSimilarity < 0.55 || !features.durationCompatible) continue;
      ids.add(left.id);
      ids.add(right.id);
      pairs.push({ recordIds: [left.id, right.id], features });
    }
  }
  return { ids: [...ids].sort(), pairs };
}

export function deduplicateRecords(records, options = {}) {
  const fingerprints = options.fingerprints ?? {};
  const overrides = normalizeOverrides(options.overrides);
  const keepPairs = new Set(overrides.keep
    .filter((item) => Array.isArray(item) && item.length === 2)
    .map(([left, right]) => pairKey(left, right)));
  const byId = new Map(records.map((record) => [record.id, record]));
  const decisions = [];

  for (const item of [...overrides.merge].sort((a, b) => String(a.winner).localeCompare(String(b.winner)))) {
    const winner = byId.get(String(item?.winner));
    if (!winner) continue;
    const copies = [...new Set(Array.isArray(item.copies) ? item.copies.map(String) : [])]
      .map((id) => byId.get(id))
      .filter((record) => record && record.id !== winner.id);
    if (!copies.length) continue;
    decisions.push(decision(winner, copies, 'manual-override', 1, 1, {
      reason: String(item.reason || 'manual merge'),
    }));
    for (const copy of copies) byId.delete(copy.id);
  }

  const fingerprintGroups = new Map();
  for (const record of byId.values()) {
    const fingerprint = fingerprints[record.id]?.fingerprint;
    if (!fingerprint) continue;
    const key = `${record.variantKey}\u0000${fingerprint}`;
    const group = fingerprintGroups.get(key) ?? [];
    group.push(record);
    fingerprintGroups.set(key, group);
  }

  for (const group of [...fingerprintGroups.values()].sort((a, b) => a[0].id.localeCompare(b[0].id))) {
    let remaining = group.filter((record) => byId.has(record.id)).sort(comparePreferredUploads);
    while (remaining.length > 1) {
      const winner = remaining[0];
      const copies = remaining.slice(1).filter((copy) => {
        if (keepPairs.has(pairKey(winner.id, copy.id))) return false;
        return durationFeatures(winner, copy).compatible;
      });
      if (!copies.length) {
        remaining = remaining.slice(1);
        continue;
      }
      const durationDifferences = copies.map((copy) => durationFeatures(winner, copy).differenceSeconds);
      decisions.push(decision(winner, copies, 'chromaprint', 1, FINGERPRINT_THRESHOLD, {
        fingerprint: String(fingerprints[winner.id].fingerprint),
        durationDifferencesSeconds: durationDifferences,
        variantKey: winner.variantKey,
      }));
      for (const copy of copies) byId.delete(copy.id);
      const removed = new Set(copies.map((copy) => copy.id));
      remaining = remaining.filter((record) => record.id !== winner.id && !removed.has(record.id));
    }
  }

  const segmentRecords = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (let index = 0; index < segmentRecords.length; index += 1) {
    const left = segmentRecords[index];
    if (!byId.has(left.id)) continue;
    for (let other = index + 1; other < segmentRecords.length; other += 1) {
      const right = segmentRecords[other];
      if (!byId.has(right.id) || left.variantKey !== right.variantKey || keepPairs.has(pairKey(left.id, right.id))) continue;
      const features = matchingSegmentFeatures(left, right, fingerprints);
      if (!features.compatible) continue;
      const [winner, copy] = [left, right].sort(comparePreferredUploads);
      decisions.push(decision(winner, [copy], 'chromaprint-segments', features.segmentAgreement, 2 / 3, {
        ...features,
        variantKey: winner.variantKey,
      }));
      byId.delete(copy.id);
      if (copy.id === left.id) break;
    }
  }

  const survivors = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const review = [];
  for (let index = 0; index < survivors.length; index += 1) {
    for (let other = index + 1; other < survivors.length; other += 1) {
      const left = survivors[index];
      const right = survivors[other];
      if (left.variantKey !== right.variantKey || keepPairs.has(pairKey(left.id, right.id))) continue;
      const features = metadataFeatures(left, right);
      if (!features.durationCompatible || features.titleSimilarity < 0.75 || features.score < REVIEW_THRESHOLD) continue;
      review.push({
        recordIds: [left.id, right.id].sort(),
        reason: 'possible-duplicate-needs-audio-evidence',
        method: 'metadata-candidate',
        score: features.score,
        threshold: FINGERPRINT_THRESHOLD,
        features,
        provenance: {
          [left.id]: structuredClone(left.provenance),
          [right.id]: structuredClone(right.provenance),
        },
      });
    }
  }

  return {
    records: [...byId.values()].sort((a, b) => (
      a.normalizedArtist.localeCompare(b.normalizedArtist) ||
      a.normalizedTitle.localeCompare(b.normalizedTitle) ||
      a.variantKey.localeCompare(b.variantKey) ||
      a.id.localeCompare(b.id)
    )),
    decisions: decisions.sort((a, b) => a.winner.id.localeCompare(b.winner.id) || a.method.localeCompare(b.method)),
    review: review.sort((a, b) => a.recordIds.join().localeCompare(b.recordIds.join())),
  };
}
