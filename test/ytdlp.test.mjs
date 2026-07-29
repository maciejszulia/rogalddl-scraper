import test from 'node:test';
import assert from 'node:assert/strict';
import { buildYtDlpArgs, buildYtDlpMetadataArgs, diagnoseYtDlpError, parseYtDlpPayload } from '../lib/ytdlp.mjs';

test('yt-dlp receives a bounded playlist and a literal locator after --', () => {
  const locator = 'ytsearch3:"Rogal DDL"; touch /tmp/nope';
  const args = buildYtDlpArgs({ locator, resultLimit: 3 }, { resultLimit: 25 });
  assert.ok(args.includes('--ignore-config'));
  assert.ok(args.includes('--playlist-end'));
  assert.equal(args[args.indexOf('--retries') + 1], '0');
  assert.equal(args[args.indexOf('--fragment-retries') + 1], '0');
  assert.equal(args[args.indexOf('--playlist-end') + 1], '3');
  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), locator);
  assert.ok(!args.includes('ytsearchdate'));
});

test('yt-dlp diagnostics identify access and runtime failures without leaking cookie paths', () => {
  assert.equal(diagnoseYtDlpError('PO Token required').code, 'YTDLP_PO_TOKEN');
  assert.equal(diagnoseYtDlpError('No supported JavaScript runtime').code, 'YTDLP_JS_RUNTIME');
  const auth = diagnoseYtDlpError('Sign in; use --cookies /tmp/private-cookies.txt');
  assert.equal(auth.code, 'YTDLP_AUTH_REQUIRED');
  assert.doesNotMatch(auth.hint, /private-cookies/);
});

test('metadata enrichment disables playlist traversal without flattening chapters', () => {
  const url = 'https://www.youtube.com/watch?v=abcdefghijk';
  const args = buildYtDlpMetadataArgs(url);
  assert.ok(args.includes('--ignore-config'));
  assert.ok(args.includes('--no-playlist'));
  assert.ok(!args.includes('--flat-playlist'));
  assert.deepEqual(args.slice(-2), ['--', url]);
});

test('valid JSONL rows survive a malformed trailing or intermediate row', () => {
  const parsed = parseYtDlpPayload([
    '{"id":"abcdefghijk","title":"Rogal DDL - One"}',
    '{not-json',
    '{"id":"lmnopqrstuv","title":"Rogal DDL - Two"}',
  ].join('\n'));
  assert.deepEqual(parsed.records.map((record) => record.id), ['abcdefghijk', 'lmnopqrstuv']);
  assert.equal(parsed.malformedLines, 1);
});

test('null, primitive and metadata-free entries cannot poison later normalization', () => {
  const parsed = parseYtDlpPayload(JSON.stringify({
    entries: [null, 'text', { id: 'bad' }, { id: 'valid-id', title: 'Rogal DDL - Valid' }],
  }));
  assert.deepEqual(parsed.records.map((record) => record.id), ['valid-id']);
  assert.equal(parsed.invalidRows, 3);
});

test('parsed metadata retains useful format facts but drops signed media URLs and headers', () => {
  const parsed = parseYtDlpPayload(JSON.stringify({
    id: 'safevideoid',
    title: 'Rogal DDL - Safe',
    url: 'https://rr1---example.googlevideo.com/videoplayback?sig=private',
    http_headers: { Cookie: 'private' },
    formats: [{
      format_id: '251',
      acodec: 'opus',
      abr: 128,
      url: 'https://rr1---example.googlevideo.com/videoplayback?sig=private',
      http_headers: { Authorization: 'private' },
    }],
  }));
  assert.equal(parsed.records[0].webpage_url, 'https://www.youtube.com/watch?v=safevideoid');
  assert.deepEqual(parsed.records[0].formats[0].format_id, '251');
  assert.doesNotMatch(JSON.stringify(parsed.records[0]), /googlevideo|private|http_headers/i);
});
