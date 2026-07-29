export const provenance = (sourceId, phase = 1, extra = {}) => ({
  sourceId,
  sourceType: sourceId.startsWith('channel:') ? 'channel' : 'search',
  locator: sourceId,
  phase,
  fetchedAt: '2026-01-02T03:04:05.000Z',
  cached: false,
  position: 1,
  ...extra,
});

export const video = (id, title, extra = {}) => ({
  id,
  title,
  uploader: 'Rogal DDL',
  uploader_id: '@rogalddl',
  channel_id: 'official-channel',
  duration: 180,
  webpage_url: `https://www.youtube.com/watch?v=${id}`,
  availability: 'public',
  view_count: 1000,
  formats: [{ acodec: 'opus', abr: 128 }],
  provenance: [provenance('channel:official')],
  ...extra,
});

export const fixtureRecords = () => [
  video('same-id', 'Rogal DDL - Noc', {
    provenance: [provenance('channel:official')],
  }),
  video('same-id', 'Rogal DDL - Noc', {
    provenance: [provenance('search:exact')],
  }),
  video('master-official', 'Rogal DDL - Światła', {
    duration: 201,
    view_count: 500,
  }),
  video('master-reupload', 'Rogal DDL - Światła (Official Audio)', {
    uploader: 'Fan Archive',
    uploader_id: '@fanarchive',
    channel_id: 'fan-channel',
    duration: 201.4,
    view_count: 999999,
    provenance: [provenance('search:exact')],
  }),
  video('remix', 'Rogal DDL - Światła (DJ Test Remix)', {
    uploader: 'DJ Test',
    uploader_id: '@djtest',
    channel_id: 'dj-channel',
    duration: 204,
    provenance: [provenance('search:remix')],
  }),
  video('live', 'Rogal DDL - Światła (Live)', { duration: 220 }),
  video('instrumental', 'Rogal DDL - Światła Instrumental', { duration: 201 }),
  video('slowed', 'Rogal DDL - Światła Slowed + Reverb', { duration: 235 }),
  video('sped', 'Rogal DDL - Światła Sped Up', { duration: 170 }),
  video('uncertain-a', 'Rogal DDL - Mgła', { duration: 190 }),
  video('uncertain-b', 'Rogal DDL - Mgła (Official Audio)', {
    uploader: 'External Label',
    uploader_id: '@label',
    channel_id: 'label-channel',
    duration: 192,
    provenance: [provenance('search:exact')],
  }),
  video('album', 'Rogal DDL - Pełny Album 2024', { duration: 3600 }),
  video('podcast', 'Podcast: rozmowa z Rogal DDL', { duration: 2400 }),
  video('wrong', 'Jak zrobić rogala - przepis', {
    uploader: 'Kuchnia',
    uploader_id: '@kuchnia',
    channel_id: 'kitchen',
    duration: 400,
    provenance: [provenance('search:exact')],
  }),
];
