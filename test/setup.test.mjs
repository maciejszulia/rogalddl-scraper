import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('syntax check works from a source directory containing spaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rogalddl source '));
  try {
    await mkdir(join(root, 'scripts'));
    const checker = join(root, 'scripts', 'check-syntax.mjs');
    await copyFile(new URL('../scripts/check-syntax.mjs', import.meta.url), checker);
    await writeFile(join(root, 'example.mjs'), 'export const value = 1;\n');
    await writeFile(join(root, 'config.json'), '{"example":true}\n');
    const result = spawnSync(process.execPath, [checker], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /syntax\/json OK/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
