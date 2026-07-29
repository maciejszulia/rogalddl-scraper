import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { redactSensitive, safeProcessEnv } from './security.mjs';

export class ProcessExecutionError extends Error {
  constructor(message, details = {}) {
    super(redactSensitive(message));
    this.name = 'ProcessExecutionError';
    Object.assign(this, details);
  }
}

export function runProcess(command, args = [], options = {}) {
  if (typeof command !== 'string' || !command) throw new TypeError('command must be a non-empty string');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new TypeError('args must be an array of strings');
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(1, Number(options.timeoutMs)) : 120000;
  const maxBuffer = Number.isFinite(Number(options.maxBuffer)) ? Math.max(1024, Number(options.maxBuffer)) : 16 * 1024 * 1024;
  const spawnImpl = options.spawnImpl ?? spawn;
  const useProcessGroup = process.platform !== 'win32' && options.killProcessGroup !== false && spawnImpl === spawn;
  const killGraceMs = Number.isFinite(Number(options.killGraceMs)) ? Math.max(10, Number(options.killGraceMs)) : 1000;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let aborted = false;
    let terminating = false;
    let forceTimer = null;
    let timer;
    const child = spawnImpl(command, args, {
      cwd: options.cwd,
      env: options.env ?? safeProcessEnv(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: useProcessGroup,
    });
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', abort);
      callback();
    };
    const signalChild = (signal) => {
      if (useProcessGroup && Number.isSafeInteger(child.pid) && child.pid > 0) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {}
      }
      try { child.kill(signal); } catch {}
    };
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      signalChild('SIGTERM');
      forceTimer = setTimeout(() => signalChild('SIGKILL'), killGraceMs);
      forceTimer.unref?.();
    };
    const abort = () => {
      if (settled || aborted) return;
      aborted = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      terminate();
    };
    const append = (current, chunk) => {
      const next = current + String(chunk);
      if (Buffer.byteLength(next) > maxBuffer) {
        overflowed = true;
        terminate();
        return next.slice(-maxBuffer);
      }
      return next;
    };
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on?.('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => finish(() => reject(aborted
      ? new ProcessExecutionError('process aborted', { code: 'PROCESS_ABORTED', command })
      : new ProcessExecutionError(
        `cannot start ${command}: ${error.message}`,
        { code: 'PROCESS_SPAWN_ERROR', command, cause: error },
      ))));
    child.once('close', (code, signal) => finish(() => {
      const safeStdout = redactSensitive(stdout);
      const safeStderr = redactSensitive(stderr);
      if (aborted) {
        reject(new ProcessExecutionError('process aborted', { code: 'PROCESS_ABORTED', command, signal }));
      } else if (timedOut) {
        reject(new ProcessExecutionError(
          `process timed out after ${timeoutMs} ms: ${safeStderr}`,
          { code: 'PROCESS_TIMEOUT', command, signal, stdout: safeStdout, stderr: safeStderr },
        ));
      } else if (overflowed) {
        reject(new ProcessExecutionError('process output exceeded safe buffer', {
          code: 'PROCESS_OUTPUT_LIMIT', command, signal,
        }));
      } else if (code !== 0 && !options.allowNonZero) {
        reject(new ProcessExecutionError(
          `process exited with code ${code}: ${safeStderr}`,
          { code: 'PROCESS_EXIT_ERROR', command, exitCode: code, signal, stdout: safeStdout, stderr: safeStderr },
        ));
      } else {
        resolve({ code, signal, stdout, stderr });
      }
    }));
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref?.();
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }
  });
}

export async function withRetry(operation, options = {}) {
  const retries = Number.isSafeInteger(Number(options.retries)) ? Math.max(0, Number(options.retries)) : 2;
  const baseDelayMs = Number.isFinite(Number(options.baseDelayMs)) ? Math.max(0, Number(options.baseDelayMs)) : 500;
  const maxDelayMs = Number.isFinite(Number(options.maxDelayMs)) ? Math.max(baseDelayMs, Number(options.maxDelayMs)) : 10000;
  const random = typeof options.random === 'function' ? options.random : Math.random;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (options.signal?.aborted) throw new ProcessExecutionError('operation aborted', { code: 'PROCESS_ABORTED' });
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || options.shouldRetry?.(error, attempt) === false) throw error;
      const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
      const delay = Math.round(exponential * (0.75 + random() * 0.5));
      await options.onRetry?.({ attempt: attempt + 1, delay, error: redactSensitive(error?.message ?? error) });
      await sleep(delay, undefined, { signal: options.signal });
    }
  }
  throw lastError;
}
