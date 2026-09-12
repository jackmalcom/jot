import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Deploy a locally built image when Railway's remote builder is unavailable.
const required = [
  'REGISTRY_HOST',
  'REGISTRY_USERNAME',
  'REGISTRY_PASSWORD',
  'RAILWAY_SERVICE_ID',
  'RAILWAY_ENVIRONMENT_ID',
];
for (const key of required)
  if (!process.env[key]) throw new Error(`${key} is required.`);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed (${result.status}). ${options.input ? 'Check credentials and service configuration.' : result.stderr || ''}`,
    );
  return result.stdout?.trim();
}
if (run('git', ['status', '--porcelain']))
  throw new Error('Commit all changes before deploying.');
const revision = run('git', ['rev-parse', 'HEAD']);
const image = `${process.env.REGISTRY_HOST}/jot:${revision}`;
const authDirectory = mkdtempSync(join(tmpdir(), 'jot-registry-'));
const env = { ...process.env, DOCKER_CONFIG: authDirectory };
try {
  run('docker', ['build', '--platform', 'linux/amd64', '-t', image, '.'], {
    stdio: 'inherit',
    env,
  });
  run(
    'docker',
    [
      'login',
      process.env.REGISTRY_HOST,
      '--username',
      process.env.REGISTRY_USERNAME,
      '--password-stdin',
    ],
    { input: process.env.REGISTRY_PASSWORD, env },
  );
  run('docker', ['push', image], { stdio: 'inherit', env });
  const digest = run(
    'docker',
    ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image],
    { env },
  );
  if (!digest?.startsWith(`${process.env.REGISTRY_HOST}/jot@sha256:`))
    throw new Error('Cannot determine published image digest.');
  const cli = ['--yes', '@railway/cli@5.54.0', 'api'];
  const serviceId = process.env.RAILWAY_SERVICE_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  run(
    'npx',
    [
      ...cli,
      'mutation($serviceId:String!,$environmentId:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$serviceId,environmentId:$environmentId,input:$input)}',
      '--variables',
      '@-',
    ],
    {
      input: JSON.stringify({
        serviceId,
        environmentId,
        input: {
          source: { image: digest, repo: null },
          registryCredentials: {
            username: process.env.REGISTRY_USERNAME,
            password: process.env.REGISTRY_PASSWORD,
          },
          healthcheckPath: '/api/health',
          healthcheckTimeout: 120,
        },
      }),
    },
  );
  run(
    'npx',
    [
      ...cli,
      'mutation($serviceId:String!,$environmentId:String!){serviceInstanceDeploy(serviceId:$serviceId,environmentId:$environmentId)}',
      '--variables',
      '@-',
    ],
    {
      input: JSON.stringify({ serviceId, environmentId }),
    },
  );
  console.log(
    `Deployment started for ${revision} (${digest}). Check Railway for healthcheck completion.`,
  );
} finally {
  rmSync(authDirectory, { recursive: true, force: true });
}
