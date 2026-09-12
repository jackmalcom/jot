import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  openSync,
  closeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AwsClient } from 'aws4fetch';

// Build using Docker locally, then deploy the verified release from a private
// bucket using a public Node runtime. No private registry plan is required.
for (const key of [
  'RAILWAY_SERVICE_ID',
  'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_PROJECT_ID',
])
  if (!process.env[key]) throw new Error(`${key} is required.`);
const cli = ['--yes', '@railway/cli@5.54.0'];
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
const serviceId = process.env.RAILWAY_SERVICE_ID;
const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
const env = JSON.parse(
  run('npx', [
    ...cli,
    'variable',
    'list',
    '--service',
    serviceId,
    '--environment',
    environmentId,
    '--json',
  ]),
);
for (const key of [
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
])
  if (!env[key])
    throw new Error(`${key} must be configured on the Railway service.`);
const directory = mkdtempSync(join(tmpdir(), 'jot-release-'));
try {
  const image = `jot-release:${revision}`;
  run('docker', ['build', '--platform', 'linux/amd64', '-t', image, '.'], {
    stdio: 'inherit',
  });
  const archive = join(directory, 'release.tar.gz');
  const fd = openSync(archive, 'w', 0o600);
  try {
    run(
      'docker',
      [
        'run',
        '--rm',
        '--entrypoint',
        'tar',
        image,
        '-czf',
        '-',
        '-C',
        '/app',
        '.',
      ],
      { stdio: ['ignore', fd, 'inherit'] },
    );
  } finally {
    closeSync(fd);
  }
  const bytes = readFileSync(archive);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const releaseKey = `deployments/${revision}/${checksum}.tar.gz`;
  const url = new URL(env.S3_ENDPOINT);
  if (env.S3_FORCE_PATH_STYLE !== 'true')
    url.hostname = `${env.S3_BUCKET}.${url.hostname}`;
  url.pathname =
    (env.S3_FORCE_PATH_STYLE === 'true' ? `/${env.S3_BUCKET}` : '') +
    '/' +
    releaseKey;
  const aws = new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    region: env.S3_REGION,
    service: 's3',
    retries: 2,
  });
  const uploaded = await aws.fetch(url.toString(), {
    method: 'PUT',
    body: bytes,
    headers: { 'content-type': 'application/gzip' },
    signal: AbortSignal.timeout(120_000),
  });
  await uploaded.body?.cancel();
  if (!uploaded.ok)
    throw new Error(`Release upload failed (${uploaded.status}).`);
  const variables = {
    JOT_RELEASE_KEY: releaseKey,
    JOT_RELEASE_SHA256: checksum,
    JOT_BOOTSTRAP_BASE64: readFileSync(
      'scripts/railway-bootstrap.cjs',
    ).toString('base64'),
  };
  run(
    'npx',
    [
      ...cli,
      'api',
      'mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}',
      '--variables',
      '@-',
    ],
    {
      input: JSON.stringify({
        input: {
          projectId: process.env.RAILWAY_PROJECT_ID,
          serviceId,
          environmentId,
          skipDeploys: true,
          variables,
        },
      }),
    },
  );
  // Keep this runtime in sync with the Dockerfile base image / OS / Node major.
  run(
    'npx',
    [
      ...cli,
      'api',
      'mutation($serviceId:String!,$environmentId:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$serviceId,environmentId:$environmentId,input:$input)}',
      '--variables',
      '@-',
    ],
    {
      input: JSON.stringify({
        serviceId,
        environmentId,
        input: {
          source: { image: 'node:24-bookworm-slim', repo: null },
          startCommand: `node -e 'eval(Buffer.from(process.env.JOT_BOOTSTRAP_BASE64,"base64").toString())'`,
          healthcheckPath: '/api/health',
          healthcheckTimeout: 180,
        },
      }),
    },
  );
  run(
    'npx',
    [
      ...cli,
      'api',
      'mutation($serviceId:String!,$environmentId:String!){serviceInstanceDeploy(serviceId:$serviceId,environmentId:$environmentId)}',
      '--variables',
      '@-',
    ],
    { input: JSON.stringify({ serviceId, environmentId }) },
  );
  console.log(
    `Deployment started for ${revision}. Release checksum: ${checksum}. Check Railway for healthcheck completion.`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
