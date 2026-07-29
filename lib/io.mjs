import { randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertOwned(info, path) {
  const ownUid = process.getuid?.();
  if (ownUid !== undefined && info.uid !== ownUid) throw new TypeError(`refusing path not owned by current user: ${path}`);
}

export async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError(`private directory must not be a symlink: ${path}`);
  assertOwned(info, path);
  if ((info.mode & 0o777) !== 0o700) await chmod(path, 0o700);
}

export async function ensurePrivateFile(path, options = {}) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (options.allowMissing && error.code === 'ENOENT') return;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new TypeError(`private file must be a regular file, not a symlink: ${path}`);
  assertOwned(info, path);
  if ((info.mode & 0o777) !== 0o600) await chmod(path, 0o600);
}

export async function readJson(path, fallback) {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (fallback !== undefined && error.code === 'ENOENT') return structuredClone(fallback);
    if (error instanceof SyntaxError) throw new SyntaxError(`invalid JSON in ${path}: ${error.message}`, { cause: error });
    throw error;
  }
}

async function durableWrite(path, content, options = {}) {
  const handle = await open(path, 'wx', options.mode ?? 0o600);
  try {
    await handle.writeFile(content, { encoding: options.encoding ?? 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

export async function atomicWriteFile(path, content, options = {}) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await durableWrite(temporary, content, options);
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function atomicWriteJson(path, value) {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function validateArtifactName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(name) || name.includes('..')) {
    throw new TypeError(`unsafe artifact filename: ${name}`);
  }
}

async function ensureNotSymlink(path) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new TypeError(`refusing to replace symlink: ${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function recoverInterruptedCommit(parent, targetDir, targetName) {
  const previousPrefix = `.${targetName}.previous-`;
  const stagingPrefix = `.${targetName}.staging-`;
  const candidates = [];
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.name.startsWith(previousPrefix) && !entry.name.startsWith(stagingPrefix)) continue;
    const path = join(parent, entry.name);
    if (!entry.isDirectory()) throw new TypeError(`unsafe interrupted-commit entry: ${path}`);
    const stat = await lstat(path);
    const ownUid = process.getuid?.();
    if (ownUid !== undefined && stat.uid !== ownUid) throw new TypeError(`refusing foreign interrupted-commit entry: ${path}`);
    candidates.push({ path, name: entry.name, mtimeMs: stat.mtimeMs });
  }
  if (!candidates.length) return;

  const previous = candidates
    .filter((item) => item.name.startsWith(previousPrefix))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  if (!(await pathExists(targetDir)) && previous.length) await rename(previous[0].path, targetDir);
  for (const item of candidates) await rm(item.path, { recursive: true, force: true });
  await syncDirectory(parent);
}

export async function commitArtifacts(targetDir, artifacts, options = {}) {
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new TypeError('artifacts must be an object keyed by safe filenames');
  }
  const parent = dirname(targetDir);
  const targetName = basename(targetDir);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await ensureNotSymlink(targetDir);
  await recoverInterruptedCommit(parent, targetDir, targetName);
  const nonce = `${process.pid}-${randomUUID()}`;
  const staging = join(parent, `.${targetName}.staging-${nonce}`);
  const backup = join(parent, `.${targetName}.previous-${nonce}`);
  const names = Object.keys(artifacts).sort();
  let backedUp = false;
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const name of names) {
      validateArtifactName(name);
      const value = artifacts[name];
      const content = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
      await durableWrite(join(staging, name), content, { encoding: 'utf8', mode: 0o600 });
    }
    await syncDirectory(staging);
    await options.beforeSwap?.(staging);
    if (options.signal?.aborted) {
      throw Object.assign(new Error('publication aborted before commit'), { code: 'PROCESS_ABORTED' });
    }
    if (await pathExists(targetDir)) {
      await rename(targetDir, backup);
      backedUp = true;
    }
    try {
      await rename(staging, targetDir);
      await syncDirectory(parent);
    } catch (error) {
      if (backedUp && !(await pathExists(targetDir))) await rename(backup, targetDir).catch(() => {});
      throw error;
    }
    if (backedUp) await rm(backup, { recursive: true, force: true }).catch(() => {});
    return names;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (backedUp && !(await pathExists(targetDir))) await rename(backup, targetDir).catch(() => {});
    throw error;
  }
}
