// Runs inside the official Node image. Fetch a private release and verify it
// before extracting or executing any code. Only Node built-ins are required.
const { createHash, createHmac } = require('node:crypto');
const { createWriteStream, mkdirSync, rmSync } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
async function main() {
  const env = process.env;
  for (const name of [
    'S3_ENDPOINT',
    'S3_BUCKET',
    'S3_REGION',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'JOT_RELEASE_KEY',
    'JOT_RELEASE_SHA256',
  ])
    if (!env[name]) throw new Error(`${name} is required.`);
  if (!/^[a-f0-9]{64}$/.test(env.JOT_RELEASE_SHA256))
    throw new Error('Invalid release checksum.');
  const url = new URL(env.S3_ENDPOINT);
  if (env.S3_FORCE_PATH_STYLE !== 'true')
    url.hostname = `${env.S3_BUCKET}.${url.hostname}`;
  url.pathname =
    (env.S3_FORCE_PATH_STYLE === 'true' ? `/${env.S3_BUCKET}` : '') +
    '/' +
    env.JOT_RELEASE_KEY.split('/').map(encodeURIComponent).join('/');
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8);
  const payload = sha('');
  const names = 'host;x-amz-content-sha256;x-amz-date';
  const headers = `host:${url.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${date}\n`;
  const canonical = ['GET', url.pathname, '', headers, names, payload].join(
    '\n',
  );
  const scope = `${day}/${env.S3_REGION}/s3/aws4_request`;
  const key = hmac(
    hmac(
      hmac(hmac('AWS4' + env.S3_SECRET_ACCESS_KEY, day), env.S3_REGION),
      's3',
    ),
    'aws4_request',
  );
  const signature = hmac(
    key,
    `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`,
  ).toString('hex');
  const response = await fetch(url, {
    headers: {
      'x-amz-date': date,
      'x-amz-content-sha256': payload,
      authorization: `AWS4-HMAC-SHA256 Credential=${env.S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names}, Signature=${signature}`,
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Release download failed (${response.status}).`);
  const hash = createHash('sha256');
  const archive = '/tmp/jot-release.tar.gz';
  await pipeline(
    response.body,
    new Transform({
      transform(chunk, encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(archive, { mode: 0o600 }),
  );
  if (hash.digest('hex') !== env.JOT_RELEASE_SHA256) {
    rmSync(archive);
    throw new Error('Release checksum mismatch.');
  }
  mkdirSync('/app', { recursive: true });
  const extracted = spawnSync(
    'tar',
    ['-xzf', archive, '--no-same-owner', '-C', '/app'],
    { stdio: 'inherit' },
  );
  rmSync(archive);
  if (extracted.status !== 0) throw new Error('Release extraction failed.');
  console.log('Verified release loaded. Starting jot.');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/node/src/index.ts'],
    { cwd: '/app', stdio: 'inherit' },
  );
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => child.kill(signal));
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 0;
  });
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
