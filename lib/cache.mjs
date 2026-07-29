import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson } from './io.mjs';

export function discoveryJobKey(job) {
  const identity = {
    schemaVersion: 2,
    sourceId: String(job?.sourceId ?? ''),
    sourceType: String(job?.sourceType ?? ''),
    locator: String(job?.locator ?? ''),
    phase: Number(job?.phase ?? 1),
    resultLimit: Number(job?.resultLimit ?? 0),
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export class JsonDirectoryCache {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.ttlMs = Number(options.ttlMs ?? 7 * 24 * 60 * 60 * 1000);
  }

  keyFor(job) {
    return discoveryJobKey(job);
  }

  pathFor(key) {
    const safe = /^[a-f0-9]{64}$/i.test(key) ? key : createHash('sha256').update(String(key)).digest('hex');
    return join(this.directory, `${safe}.json`);
  }

  async get(key) {
    const path = this.pathFor(key);
    try {
      const info = await stat(path);
      if (this.ttlMs >= 0 && Date.now() - info.mtimeMs > this.ttlMs) return null;
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async set(key, value) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await atomicWriteJson(this.pathFor(key), value);
  }
}
