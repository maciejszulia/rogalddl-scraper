#!/usr/bin/env node
import { runCli } from './lib/cli.mjs';
import { redactSensitive } from './lib/security.mjs';

const controller = new AbortController();
let interruptedSignal = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interruptedSignal = signal;
    controller.abort(signal);
  });
}
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

try {
  const result = await runCli(process.argv.slice(2), { signal: controller.signal });
  if (interruptedSignal) process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143;
  else if (Number.isSafeInteger(result?.exitCode)) process.exitCode = result.exitCode;
} catch (error) {
  const interrupted = controller.signal.aborted || error?.code === 'PROCESS_ABORTED';
  process.stderr.write(`${interrupted ? 'operation interrupted; previously published catalog preserved' : redactSensitive(error?.message ?? error)}\n`);
  process.exitCode = interruptedSignal === 'SIGTERM' ? 143 : interrupted ? 130 : 1;
}
