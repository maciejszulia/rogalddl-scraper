import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFingerprintDownloadArgs, fingerprintRecord } from '../lib/fingerprint.mjs';

test('missing fpcalc is detected before yt-dlp can download a temporary sample', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-fingerprint-capability-'));
  const marker = join(root, 'downloaded');
  const fakeYtDlp = join(root, 'fake-ytdlp');
  await writeFile(fakeYtDlp, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'downloaded');\n`);
  await chmod(fakeYtDlp, 0o755);
  try {
    await assert.rejects(
      fingerprintRecord({ id: 'candidate', url: 'https://www.youtube.com/watch?v=abcdefghijk' }, {
        fpcalcBinary: '/definitely/missing/fpcalc',
        ytDlpBinary: fakeYtDlp,
        timeoutMs: 5000,
      }),
      (error) => {
        assert.equal(error.code, 'FPCALC_MISSING');
        return true;
      },
    );
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fingerprint downloads have a hard size ceiling before fpcalc runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl-fingerprint-size-'));
  const fakeYtDlp = join(root, 'fake-ytdlp');
  await writeFile(fakeYtDlp, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const target = args[args.indexOf('--output') + 1].replace('%(ext)s', 'webm');
fs.writeFileSync(target, Buffer.alloc(1048577));
`);
  await chmod(fakeYtDlp, 0o755);
  const record = { id: 'candidate-size', url: 'https://www.youtube.com/watch?v=abcdefghijk' };
  const args = buildFingerprintDownloadArgs(record, '/tmp/sample.%(ext)s', { fingerprintMaxBytes: 1048576 });
  assert.equal(args[args.indexOf('--max-filesize') + 1], '1048576');
  try {
    await assert.rejects(
      fingerprintRecord(record, {
        capabilityChecked: true,
        fingerprintMaxBytes: 1048576,
        ytDlpBinary: fakeYtDlp,
        fpcalcBinary: '/must/not/run',
        retries: 0,
        timeoutMs: 5000,
      }),
      (error) => error.code === 'FINGERPRINT_FILE_TOO_LARGE',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
