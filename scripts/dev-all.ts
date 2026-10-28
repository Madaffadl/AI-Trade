import { spawn, type ChildProcess } from 'node:child_process';

/**
 * `npm run dev:all`: the Next.js dev server and the worker side by side.
 *
 * A plain `worker & next dev` in the npm script is not enough: a shell started
 * without job control makes its background command ignore Ctrl+C, so the
 * worker would outlive the server. Here both are children of this process,
 * Ctrl+C reaches both, and when either one exits the other is stopped too.
 */

const children: ChildProcess[] = [
  spawn('npm', ['run', '--silent', 'worker'], { stdio: 'inherit' }),
  spawn('next', ['dev'], { stdio: 'inherit' }),
];

let stopping = false;
function stopAll(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill(signal);
}

process.on('SIGINT', () => stopAll('SIGINT'));
process.on('SIGTERM', () => stopAll('SIGTERM'));
for (const child of children) {
  child.on('exit', (code) => {
    stopAll('SIGTERM');
    if (code) process.exitCode = code;
  });
}
