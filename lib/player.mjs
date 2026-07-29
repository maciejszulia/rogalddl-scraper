import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { Buffer } from 'node:buffer';
import { isAbsolute } from 'node:path';
import { redactSensitive, safeProcessEnv } from './security.mjs';

function pipeRedactedLines(stream, target, maximumLineBytes = 64 * 1024) {
  if (!stream?.on || !target?.write) return () => {};
  let buffered = '';
  let discardingOversizedLine = false;
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk) => {
    buffered += String(chunk);
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline + 1);
      buffered = buffered.slice(newline + 1);
      if (discardingOversizedLine) discardingOversizedLine = false;
      else target.write(redactSensitive(line));
    }
    if (!discardingOversizedLine && Buffer.byteLength(buffered) > maximumLineBytes) {
      target.write('[REDACTED_OVERSIZED_MPV_OUTPUT]\n');
      buffered = '';
      discardingOversizedLine = true;
    }
  });
  return () => {
    if (!discardingOversizedLine && buffered) target.write(redactSensitive(buffered));
    buffered = '';
  };
}

export function toMpvEntryUrl(record) {
  if (!record?.segment) return String(record?.url ?? '');
  const start = Number(record.segment.start);
  const end = Number(record.segment.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new TypeError('segment requires finite 0 <= start < end');
  }
  const source = `ytdl://${record.url}`;
  return `edl://%${Buffer.byteLength(source)}%${source},${start},${end - start}`;
}

export function buildMpvArgs(playlistPath, options = {}) {
  if (typeof playlistPath !== 'string' || !isAbsolute(playlistPath) || /[\r\n\0]/.test(playlistPath)) {
    throw new TypeError('playlist path must be a safe absolute path');
  }
  const args = [
    '--no-config',
    '--load-scripts=no',
    '--idle=no',
    '--ytdl=yes',
    '--ytdl-format=bestaudio/best',
    options.audioOnly === false ? '--video=yes' : '--no-video',
    options.loop === false ? '--loop-playlist=no' : '--loop-playlist=inf',
  ];
  if (options.shuffle) args.push('--shuffle');
  if (options.ipcSocket) {
    const socket = String(options.ipcSocket);
    if (!isAbsolute(socket) || /[\r\n\0]/.test(socket)) throw new TypeError('MPV IPC socket must be a safe absolute path');
    args.push(`--input-ipc-server=${socket}`);
  }
  const start = options.start === undefined ? null : Number(options.start);
  const end = options.end === undefined ? null : Number(options.end);
  if (start !== null && (!Number.isFinite(start) || start < 0)) throw new TypeError('MPV start must be a finite non-negative number');
  if (end !== null && (!Number.isFinite(end) || end < 0 || (start !== null && end <= start))) {
    throw new TypeError('MPV end must be finite, non-negative and greater than start');
  }
  if (start !== null) args.push(`--start=${start}`);
  if (end !== null) args.push(`--end=${end}`);
  args.push(`--playlist=${playlistPath}`);
  return args;
}

export function playPlaylist(playlistPath, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const command = options.mpvBinary ?? 'mpv';
  const args = buildMpvArgs(playlistPath, options);
  const useProcessGroup = process.platform !== 'win32' && options.killProcessGroup !== false && spawnImpl === spawn;
  const killGraceMs = Number.isFinite(Number(options.killGraceMs)) ? Math.max(10, Number(options.killGraceMs)) : 1000;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      shell: false,
      stdio: options.stdio === 'ignore' ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: options.env ?? safeProcessEnv(process.env, { media: true, network: true }),
      detached: useProcessGroup,
    });
    let aborted = false;
    let forceTimer = null;
    const flushStdout = pipeRedactedLines(child.stdout, options.stdout ?? process.stdout);
    const flushStderr = pipeRedactedLines(child.stderr, options.stderr ?? process.stderr);
    const signalChild = (signal) => {
      if (useProcessGroup && Number.isSafeInteger(child.pid) && child.pid > 0) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {}
      }
      try { child.kill?.(signal); } catch {}
    };
    const abort = () => {
      aborted = true;
      signalChild('SIGTERM');
      forceTimer = setTimeout(() => signalChild('SIGKILL'), killGraceMs);
      forceTimer.unref?.();
    };
    const cleanup = () => {
      clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', abort);
      flushStdout();
      flushStderr();
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      if (aborted) {
        reject(Object.assign(new Error('mpv playback aborted'), { code: 'MPV_ABORTED', exitCode: code, signal }));
        return;
      }
      if (code === 0) resolve({ code, signal });
      else reject(Object.assign(new Error(`mpv exited with code ${code ?? 'null'} (${signal ?? 'no signal'})`), {
        code: 'MPV_EXIT_ERROR',
        exitCode: code,
        signal,
      }));
    });
  });
}

export function sendMpvCommand(socketPath, command, options = {}) {
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath) || /[\r\n\0]/.test(socketPath)) {
    throw new TypeError('MPV IPC socket must be a safe absolute path');
  }
  if (!Array.isArray(command)) throw new TypeError('MPV IPC command must be an array');
  const [name, ...args] = command;
  const safeLoadList = name === 'loadlist'
    && args.length === 2
    && typeof args[0] === 'string'
    && isAbsolute(args[0])
    && !/[\r\n\0]/.test(args[0])
    && ['replace', 'append'].includes(args[1]);
  const safeGet = name === 'get_property'
    && args.length === 1
    && ['pause', 'playlist-count', 'media-title', 'time-pos'].includes(args[0]);
  const safePause = name === 'set_property' && args.length === 2 && args[0] === 'pause' && typeof args[1] === 'boolean';
  if (!safeLoadList && !safeGet && !safePause) throw new TypeError(`MPV IPC command is not allowed: ${String(name)}`);
  const timeoutMs = Number(options.timeoutMs ?? 3000);
  const maxBuffer = Number(options.maxBuffer ?? 64 * 1024);
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`MPV IPC timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ command })}\n`));
    socket.on('data', (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response) > maxBuffer) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error('MPV IPC response exceeded safe buffer'));
        return;
      }
      const newline = response.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timer);
      socket.end();
      try { resolve(JSON.parse(response.slice(0, newline))); } catch (error) { reject(error); }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
