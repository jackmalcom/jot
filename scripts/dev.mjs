import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const env = {
  ...process.env,
  APP_ORIGIN: process.env.APP_ORIGIN || 'http://localhost:5173',
  BETTER_AUTH_SECRET:
    process.env.BETTER_AUTH_SECRET || randomBytes(32).toString('hex'),
};
if (!process.env.BETTER_AUTH_SECRET)
  console.log(
    'Using an ephemeral development auth secret. Set .env to keep sessions across restarts.',
  );
const children = [
  spawn(
    process.execPath,
    ['--import', 'tsx', '--watch', 'apps/node/src/index.ts'],
    { stdio: 'inherit', env },
  ),
  spawn('npm', ['run', 'dev', '-w', '@jot/web'], { stdio: 'inherit', env }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach((child) => child.kill('SIGTERM'));
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
children.forEach((child) => child.on('exit', (code) => stop(code || 0)));
