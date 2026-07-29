#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const ignored = new Set(['.git', 'node_modules', 'coverage']);
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else files.push(path);
  }
}
await walk(root);
let failures = 0;
for (const file of files.filter((path) => extname(path) === '.mjs').sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', shell: false });
  if (result.status !== 0) {
    failures += 1;
    process.stderr.write(`${relative(root, file)}\n${result.stderr}`);
  }
}
for (const file of files.filter((path) => extname(path) === '.json').sort()) {
  try { JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    failures += 1;
    process.stderr.write(`${relative(root, file)}: ${error.message}\n`);
  }
}
if (failures) process.exit(1);
process.stdout.write(`syntax/json OK (${files.filter((path) => ['.mjs', '.json'].includes(extname(path))).length} files)\n`);
