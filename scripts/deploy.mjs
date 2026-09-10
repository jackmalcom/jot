import { spawnSync } from 'node:child_process';
const origin = process.env.JOT_DEPLOY_ORIGIN;
if (!origin || new URL(origin).protocol !== 'https:') {
  console.error(
    'Set JOT_DEPLOY_ORIGIN to the HTTPS origin of your Worker or custom domain. See README.md.',
  );
  process.exit(1);
}
const result = spawnSync(
  'npm',
  [
    '--prefix',
    'apps/cloudflare',
    'run',
    'deploy',
    '--',
    '--var',
    `APP_ORIGIN:${new URL(origin).origin}`,
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
