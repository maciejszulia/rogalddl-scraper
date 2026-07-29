import { sanitizeMetadata } from './security.mjs';

const OFFICIAL_CHANNEL_IDS = new Set([
  'UCp2d6_I25e30nk7Eb4ri2Ng',
  'UCXu4ORG2S5VTmppGmKbzntw',
]);
const VARIANT_PATTERNS = [
  ['acapella', /\b(?:a\s*capella|acapella)\b/i],
  ['instrumental', /\binstrumental(?:s|ny)?\b/i],
  ['mashup', /\bmash[ -]?up\b/i],
  ['bootleg', /\bbootleg\b/i],
  ['remix', /\b(?:remix|rmx)\b/i],
  ['rework', /\brework\b/i],
  ['edit', /\b(?:radio |club |extended )?edit\b/i],
  ['acoustic', /\b(?:acoustic|akustyczn(?:y|a|e))\b/i],
  ['demo', /\bdemo\b/i],
  ['remaster', /\bremaster(?:ed)?\b/i],
  ['cover', /\bcover\b/i],
  ['karaoke', /\bkaraoke\b/i],
  ['extended', /\bextended(?:\s+(?:mix|version))?\b/i],
  ['reverb', /\breverb\b/i],
  ['live', /\b(?:live|koncert|concert)\b/i],
  ['freestyle', /\bfreestyle\b/i],
  ['slowed', /\b(?:slowed|slowed\s*\+?\s*reverb)\b/i],
  ['sped-up', /\b(?:sped[ -]?up|speed[ -]?up|nightcore)\b/i],
];
const PRESENTATION_NOISE = /\b(?:official(?:\s+music)?\s+(?:video|audio)|official video|official audio|music video|visuali[sz]er|lyric(?:s| video)?|audio|hd|4k)\b/gi;
const VARIANT_NOISE = /\b(?:a\s*capella|acapella|instrumental(?:s|ny)?|mash[ -]?up|bootleg|remix|rmx|rework|(?:radio |club |extended )?edit|acoustic|akustyczn(?:y|a|e)|demo|remaster(?:ed)?|cover|karaoke|extended(?:\s+(?:mix|version))?|reverb|live|koncert|concert|freestyle|slowed(?:\s*\+?\s*reverb)?|sped[ -]?up|speed[ -]?up|nightcore)\b/gi;
const SPOKEN = /\b(?:podcast|wywiad|interview|rozmowa|reakcja|reaction|recenzja|review|documentary|dokument|vlog)\b/i;
const TEASER = /\b(?:teaser|trailer|zapowied[zź]|snippet|preview)\b/i;
const LONG_FORM = /\b(?:full\s+(?:album|concert|koncert|mixtape|mix|set)|pe[lł]ny\s+(?:album|koncert)|album|mixtape|compilation|sk[lł]adanka|dj\s+mix|live\s+set)\b/i;

export function canonicalText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[łŁ]/g, 'l')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function detectVariants(title) {
  const tags = [];
  for (const [tag, pattern] of VARIANT_PATTERNS) {
    if (pattern.test(title)) tags.push(tag);
  }
  return [...new Set(tags)].sort();
}

function splitArtistAndTrack(title, uploader) {
  const parts = String(title).split(/\s+(?:-|–|—|\|)\s+/, 2);
  if (parts.length === 2 && /\brogal\s*ddl\b/i.test(parts[0])) {
    return { artist: parts[0].trim(), track: parts[1].trim() };
  }
  return { artist: uploader || 'Rogal DDL', track: String(title).trim() };
}

function cleanTrackTitle(title) {
  return canonicalText(
    String(title)
      .replace(/[()[\]{}]/g, ' ')
      .replace(PRESENTATION_NOISE, ' ')
      .replace(VARIANT_NOISE, ' ')
      .replace(/\b(?:feat(?:uring)?|ft)\.?\s+[^|,;]+$/gi, ' ')
      .replace(/\b(?:prod(?:uced)?\.?\s+by|prod\.?)\s+[^|,-]+/gi, ' '),
  );
}

function cleanProvenance(items) {
  const unique = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const clean = sanitizeMetadata({
      sourceId: String(item.sourceId ?? 'unknown'),
      sourceType: String(item.sourceType ?? 'unknown'),
      locator: String(item.locator ?? item.query ?? item.url ?? ''),
      phase: Number.isFinite(Number(item.phase)) ? Number(item.phase) : 1,
      fetchedAt: item.fetchedAt ? String(item.fetchedAt) : null,
      cached: Boolean(item.cached),
      position: Number.isFinite(Number(item.position)) ? Number(item.position) : null,
      stale: Boolean(item.stale),
    });
    const key = JSON.stringify(clean);
    unique.set(key, clean);
  }
  return [...unique.values()].sort((a, b) => (
    a.sourceId.localeCompare(b.sourceId) ||
    a.locator.localeCompare(b.locator) ||
    a.phase - b.phase ||
    String(a.fetchedAt).localeCompare(String(b.fetchedAt)) ||
    Number(a.position ?? 0) - Number(b.position ?? 0)
  ));
}

function bestAudioFormat(formats) {
  let best = null;
  for (const format of Array.isArray(formats) ? formats : []) {
    if (!format || format.acodec === 'none') continue;
    const candidate = {
      formatId: format.format_id ? String(format.format_id) : null,
      acodec: format.acodec ? String(format.acodec) : null,
      abr: Number.isFinite(Number(format.abr)) ? Number(format.abr) : null,
      tbr: Number.isFinite(Number(format.tbr)) ? Number(format.tbr) : null,
      ext: format.ext ? String(format.ext) : null,
    };
    const quality = candidate.abr ?? candidate.tbr ?? 0;
    const bestQuality = best?.abr ?? best?.tbr ?? -1;
    if (quality > bestQuality) best = candidate;
  }
  return best;
}

export function normalizeRecord(input) {
  const raw = sanitizeMetadata(input ?? {});
  const id = String(raw.id ?? raw.display_id ?? '').trim();
  const title = String(raw.title ?? '').trim().replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ');
  if (!id || !title) throw new TypeError('record requires non-empty id and title');
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(id)) throw new TypeError('record requires a safe YouTube video id');
  const uploader = String(raw.uploader ?? raw.channel ?? '').trim();
  const { artist, track } = splitArtistAndTrack(title, uploader);
  const variants = detectVariants(title);
  const duration = Number(raw.duration);
  const urlCandidate = String(raw.webpage_url ?? raw.original_url ?? raw.url ?? '');
  const isShort = /(?:youtube\.com\/shorts\/|youtu\.be\/shorts\/)/i.test(urlCandidate) || Boolean(raw.is_short);
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  const chapters = Array.isArray(raw.chapters)
    ? raw.chapters
      .map((chapter) => ({
        title: String(chapter?.title ?? '').trim().replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' '),
        start: Number(chapter?.start_time ?? chapter?.start),
        end: Number(chapter?.end_time ?? chapter?.end),
      }))
      .filter((chapter) => chapter.title && Number.isFinite(chapter.start) && Number.isFinite(chapter.end) && chapter.end > chapter.start)
      .sort((a, b) => a.start - b.start || a.title.localeCompare(b.title))
    : [];
  return {
    id,
    url,
    title,
    artist: artist || 'Rogal DDL',
    trackTitle: track || title,
    normalizedArtist: canonicalText(artist || uploader || 'Rogal DDL')
      .replace(/\b(?:feat(?:uring)?|ft)\b.*$/g, '')
      .trim(),
    normalizedTitle: cleanTrackTitle(track || title),
    variants,
    variantKey: variants.length ? variants.join('+') : 'original',
    uploader,
    uploaderId: String(raw.uploader_id ?? raw.uploaderId ?? raw.channel_id ?? raw.channelId ?? '').trim(),
    channelId: String(raw.channel_id ?? raw.channelId ?? '').trim(),
    duration: Number.isFinite(duration) && duration >= 0 ? duration : null,
    uploadDate: raw.upload_date || raw.uploadDate ? String(raw.upload_date ?? raw.uploadDate) : null,
    availability: String(raw.availability ?? 'unknown'),
    liveStatus: raw.live_status || raw.liveStatus ? String(raw.live_status ?? raw.liveStatus) : null,
    isShort: isShort || Boolean(raw.isShort),
    viewCount: Number.isFinite(Number(raw.view_count ?? raw.viewCount)) ? Number(raw.view_count ?? raw.viewCount) : null,
    bestAudioFormat: bestAudioFormat(raw.formats) ?? sanitizeMetadata(raw.bestAudioFormat ?? null),
    chapters,
    provenance: cleanProvenance(raw.provenance),
  };
}

function hasOfficialProvenance(record) {
  return record.provenance.some((item) => ['channel:official', 'channel:topic'].includes(item.sourceId));
}

export function classifyRecord(record) {
  const text = `${record.title} ${record.artist} ${record.uploader}`;
  const canonical = canonicalText(text);
  const relevant = /\brogal ddl\b/.test(canonical)
    || /\brogalddl\b/.test(canonical)
    || hasOfficialProvenance(record)
    || /^@?rogalddl$/i.test(record.uploaderId)
    || OFFICIAL_CHANNEL_IDS.has(record.channelId);
  if (!relevant) return { category: 'rejected', reason: 'false-match-no-rogal-ddl-identity-evidence' };
  if (SPOKEN.test(text)) return { category: 'rejected', reason: 'spoken-content-interview-podcast-reaction' };
  const isShort = record.isShort || /#shorts?\b/i.test(record.title);
  if (isShort) return { category: 'rejected', reason: 'short-form-video' };
  if (TEASER.test(text)) return { category: 'rejected', reason: 'teaser-trailer-snippet' };
  if ((record.duration ?? 0) >= 20 * 60 || (LONG_FORM.test(text) && (record.duration ?? 0) >= 10 * 60)) {
    return { category: 'long-form', reason: 'album-mixtape-mix-or-full-concert' };
  }
  if (!record.normalizedTitle) return { category: 'review', reason: 'missing-normalized-track-title' };
  if (record.variants.length) return { category: 'alternate-version', reason: record.variantKey };
  return { category: 'track', reason: 'music-candidate' };
}

export function mergeSameId(records) {
  if (!records.length) throw new TypeError('cannot merge an empty record list');
  const ordered = [...records].sort((a, b) => (
    metadataCompleteness(b) - metadataCompleteness(a)
    || Number(a.provenance.some((item) => item.sourceType === 'previous-catalog'))
      - Number(b.provenance.some((item) => item.sourceType === 'previous-catalog'))
    || a.title.localeCompare(b.title)
    || JSON.stringify(a).localeCompare(JSON.stringify(b))
  ));
  const winner = structuredClone(ordered[0]);
  winner.provenance = cleanProvenance(ordered.flatMap((record) => record.provenance));
  winner.isShort = ordered.some((record) => record.isShort);
  const richestChapters = [...ordered]
    .sort((a, b) => b.chapters.length - a.chapters.length || JSON.stringify(a.chapters).localeCompare(JSON.stringify(b.chapters)))[0]
    .chapters;
  winner.chapters = structuredClone(richestChapters);
  if (!winner.bestAudioFormat) {
    winner.bestAudioFormat = structuredClone(ordered.find((record) => record.bestAudioFormat)?.bestAudioFormat ?? null);
  }
  return winner;
}

export function metadataCompleteness(record) {
  return [
    record.title,
    record.artist,
    record.uploader,
    record.duration,
    record.uploadDate,
    record.bestAudioFormat,
    record.availability,
    record.chapters?.length ? record.chapters : null,
  ]
    .filter((value) => value !== null && value !== undefined && value !== '').length;
}
