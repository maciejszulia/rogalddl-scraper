import { createHash } from 'node:crypto';
import { discoveryJobKey } from './cache.mjs';
import { canonicalText, classifyRecord, normalizeRecord } from './classify.mjs';
import { safeError, sanitizeMetadata } from './security.mjs';

const OFFICIAL_CHANNEL = 'https://www.youtube.com/channel/UCp2d6_I25e30nk7Eb4ri2Ng/videos';
const TOPIC_CHANNEL = 'https://www.youtube.com/channel/UCXu4ORG2S5VTmppGmKbzntw';
const VARIANT_QUERIES = [
  'remix',
  'bootleg',
  'mashup',
  'edit',
  'rework',
  'instrumental',
  'acapella',
  'live',
  'freestyle',
  'slowed',
  'sped up',
  'feat',
  'ft',
  'prod',
];

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function searchLocator(query, resultLimit) {
  return `ytsearch${boundedInteger(resultLimit, 25, 1, 500)}:${query}`;
}

function jobId(prefix, locator) {
  return `${prefix}:${createHash('sha256').update(locator).digest('hex').slice(0, 16)}`;
}

export function buildInitialJobs(options = {}) {
  const resultLimit = boundedInteger(options.resultLimit, 25, 1, 500);
  const jobs = [
    { sourceId: 'channel:official', sourceType: 'channel', locator: OFFICIAL_CHANNEL, resultLimit, phase: 1 },
    { sourceId: 'channel:topic', sourceType: 'channel', locator: TOPIC_CHANNEL, resultLimit, phase: 1 },
    { sourceId: 'search:exact', sourceType: 'search', locator: searchLocator('"Rogal DDL"', resultLimit), resultLimit, phase: 1 },
  ];
  for (const variant of VARIANT_QUERIES) {
    jobs.push({
      sourceId: `search:${variant.replace(/\s+/g, '-')}`,
      sourceType: 'search',
      locator: searchLocator(`"Rogal DDL" ${variant}`, resultLimit),
      resultLimit,
      phase: 1,
    });
  }
  return jobs;
}

function titleParts(title) {
  const text = String(title ?? '').replace(/[\r\n]+/g, ' ');
  const split = text.split(/\s+(?:-|–|—|\|)\s+/, 2);
  const track = (split.length === 2 ? split[1] : text)
    .replace(/\((?:official (?:audio|video)|lyrics?|visuali[sz]er)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const people = [];
  for (const pattern of [
    /\b(?:feat(?:uring)?\.?|ft\.?)\s+([^()|,-]+)/gi,
    /\bprod(?:uced)?\.?\s+(?:by\s+)?([^()|,-]+)/gi,
  ]) {
    for (const match of text.matchAll(pattern)) {
      const person = match[1].trim().replace(/\s+/g, ' ');
      if (person && !/rogal\s*ddl/i.test(person)) people.push(person);
    }
  }
  return { track, people };
}

export function buildSecondPassJobs(records, options = {}) {
  const resultLimit = boundedInteger(options.resultLimit, 15, 1, 500);
  const limit = boundedInteger(options.limit, 30, 0, 1000);
  const queries = new Map();
  const add = (query) => {
    const normalized = canonicalText(query);
    if (!normalized || queries.has(normalized)) return;
    const locator = searchLocator(query, resultLimit);
    queries.set(normalized, {
      sourceId: jobId('search:phase2', locator),
      sourceType: 'search',
      locator,
      resultLimit,
      phase: 2,
    });
  };
  const ordered = [...(Array.isArray(records) ? records : [])]
    .sort((left, right) => String(left.id ?? '').localeCompare(String(right.id ?? '')));
  for (const record of ordered) {
    try {
      const classification = classifyRecord(normalizeRecord(record));
      if (!['track', 'alternate-version'].includes(classification.category)) continue;
    } catch {
      continue;
    }
    const { track, people } = titleParts(record.title);
    if (track && canonicalText(track) !== 'rogal ddl') add(`"Rogal DDL" "${track.replaceAll('"', '')}"`);
    for (const person of people) add(`"Rogal DDL" "${person.replaceAll('"', '')}"`);
    if (queries.size >= limit) break;
  }
  return [...queries.values()].slice(0, limit);
}

async function cacheGet(cache, key) {
  if (!cache?.get) return null;
  return await cache.get(key) ?? null;
}

async function cacheSet(cache, key, value) {
  if (cache?.set) await cache.set(key, value);
}

function attachProvenance(records, job, cached, fetchedAt) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => record && typeof record === 'object')
    .map((record, index) => ({
      ...sanitizeMetadata(record),
      provenance: [
        ...(Array.isArray(record.provenance) ? sanitizeMetadata(record.provenance) : []),
        {
          sourceId: job.sourceId,
          sourceType: job.sourceType,
          locator: job.locator,
          phase: job.phase,
          fetchedAt,
          cached,
          position: index + 1,
        },
      ],
    }));
}

function stableRecordSort(left, right) {
  return String(left.id ?? '').localeCompare(String(right.id ?? ''))
    || String(left.title ?? '').localeCompare(String(right.title ?? ''))
    || JSON.stringify(left.provenance ?? []).localeCompare(JSON.stringify(right.provenance ?? []));
}

export async function discover(options = {}) {
  if (typeof options.runJob !== 'function') throw new TypeError('discover requires runJob(job)');
  const initialJobs = options.initialJobs ?? buildInitialJobs(options);
  const queryBudget = boundedInteger(options.queryBudget, 60, 1, 10000);
  const concurrency = boundedInteger(options.concurrency, 2, 1, 16);
  const checkpoint = typeof options.checkpoint === 'function' ? options.checkpoint : async () => {};
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const runSignature = createHash('sha256').update(JSON.stringify({
    schemaVersion: 3,
    initialJobs: initialJobs.map(discoveryJobKey).sort(),
    explicitSecondPassJobs: Array.isArray(options.secondPassJobs)
      ? options.secondPassJobs.map(discoveryJobKey)
      : null,
    queryBudget,
    resultLimit: Number(options.resultLimit ?? 25),
    secondPass: options.secondPass !== false,
    secondPassLimit: Number(options.secondPassLimit ?? 30),
    secondPassResultLimit: Number(options.secondPassResultLimit ?? options.resultLimit ?? 25),
  })).digest('hex');
  const resume = options.resumeState?.runSignature === runSignature ? options.resumeState : {};
  const records = Array.isArray(resume.records) ? sanitizeMetadata(resume.records) : [];
  const failures = Array.isArray(resume.failures) ? sanitizeMetadata(resume.failures) : [];
  const completed = Array.isArray(resume.completed) ? sanitizeMetadata(resume.completed) : [];
  let plannedSecondPassJobs = Array.isArray(resume.secondPassJobs)
    ? sanitizeMetadata(resume.secondPassJobs)
    : null;
  const completedKeys = new Set(completed.map((item) => item.jobKey).filter(Boolean));
  let consumed = completed.length;
  let hadUnscheduledJobs = false;

  const state = () => ({
    schemaVersion: 3,
    runSignature,
    records: [...records].sort(stableRecordSort),
    failures: [...failures].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    completed: [...completed].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    secondPassJobs: plannedSecondPassJobs,
    budget: { limit: queryBudget, consumed, remaining: Math.max(0, queryBudget - consumed) },
  });

  const executeJobs = async (jobs) => {
    const pending = [];
    const seen = new Set();
    for (const job of jobs) {
      const jobKey = discoveryJobKey(job);
      if (!job?.sourceId || !job?.locator || completedKeys.has(jobKey) || seen.has(jobKey)) continue;
      seen.add(jobKey);
      if (consumed + pending.length >= queryBudget) {
        hadUnscheduledJobs = true;
        continue;
      }
      pending.push(job);
    }
    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const index = cursor;
        cursor += 1;
        const job = pending[index];
        const fetchedAt = now();
        consumed += 1;
        let cached = false;
        try {
          const cacheKey = options.cache?.keyFor ? options.cache.keyFor(job) : discoveryJobKey(job);
          let payload = await cacheGet(options.cache, cacheKey);
          if (payload) {
            cached = true;
          } else {
            const outcome = await options.runJob(job);
            payload = Array.isArray(outcome)
              ? { records: outcome, warnings: [] }
              : { records: outcome?.records ?? [], warnings: outcome?.warnings ?? [] };
            await cacheSet(options.cache, cacheKey, sanitizeMetadata(payload));
          }
          const discovered = attachProvenance(payload.records, job, cached, fetchedAt);
          records.push(...discovered);
          const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
          for (const warning of warnings) {
            failures.push({
              sourceId: job.sourceId,
              sourceType: job.sourceType,
              locator: job.locator,
              phase: job.phase,
              warning: true,
              code: String(warning?.code ?? 'SOURCE_PARTIAL_OUTPUT'),
              error: safeError(warning?.error ?? warning),
            });
          }
          completed.push({
            sourceId: job.sourceId,
            jobKey: discoveryJobKey(job),
            phase: job.phase,
            cached,
            recordCount: discovered.length,
            warningCount: warnings.length,
          });
        } catch (error) {
          if (options.signal?.aborted || error?.code === 'PROCESS_ABORTED' || error?.name === 'AbortError') throw error;
          failures.push({
            sourceId: job.sourceId,
            sourceType: job.sourceType,
            locator: job.locator,
            phase: job.phase,
            error: safeError(error),
          });
          completed.push({ sourceId: job.sourceId, jobKey: discoveryJobKey(job), phase: job.phase, cached: false, recordCount: 0, failed: true });
        }
        completedKeys.add(discoveryJobKey(job));
        await checkpoint(state());
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length || 1) }, worker));
  };

  await executeJobs(initialJobs);
  if (options.secondPass !== false && consumed < queryBudget) {
    if (plannedSecondPassJobs === null) {
      const phaseOneRecords = records.filter((record) => Array.isArray(record?.provenance)
        && record.provenance.some((entry) => Number(entry?.phase) === 1));
      plannedSecondPassJobs = options.secondPassJobs
        ?? buildSecondPassJobs(phaseOneRecords, {
        resultLimit: options.secondPassResultLimit ?? options.resultLimit,
        limit: options.secondPassLimit,
      });
      await checkpoint(state());
    }
    await executeJobs(plannedSecondPassJobs);
  } else if (options.secondPass !== false && consumed >= queryBudget) {
    hadUnscheduledJobs = true;
  }

  const result = state();
  result.budget.exhausted = hadUnscheduledJobs || consumed >= queryBudget;
  return result;
}
