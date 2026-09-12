import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageBucket } from '../packages/core/src/images.ts';

const settings = {
  S3_ENDPOINT: 'https://storage.example.com',
  S3_BUCKET: 'jot-images',
  S3_REGION: 'auto',
  S3_ACCESS_KEY_ID: 'test-access',
  S3_SECRET_ACCESS_KEY: 'test-secret',
};
test('S3 configuration is optional but rejects partial or malformed settings', () => {
  assert.equal(imageBucket({}), undefined);
  assert.throws(() => imageBucket({ S3_BUCKET: 'images' }), /S3_ENDPOINT/);
  assert.throws(
    () => imageBucket({ ...settings, S3_FORCE_PATH_STYLE: 'yes' }),
    /true or false/,
  );
  assert.throws(
    () =>
      imageBucket({ ...settings, S3_ENDPOINT: 'https://example.com/bucket' }),
    /origin/,
  );
});
test('S3 signs requests and supports virtual and path URL styles', async (t) => {
  const requests: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    requests.push(request);
    return new Response(new Uint8Array([1, 2, 3]));
  });
  for (const path of [false, true]) {
    const bucket = imageBucket({
      ...settings,
      S3_FORCE_PATH_STYLE: String(path),
    })!;
    await bucket.put('images/test', new Uint8Array([1, 2, 3]), 'image/png');
    const request = requests.at(-1)!;
    assert.equal(
      request.url,
      path
        ? 'https://storage.example.com/jot-images/images/test'
        : 'https://jot-images.storage.example.com/images/test',
    );
    assert.match(
      request.headers.get('authorization')!,
      /AWS4-HMAC-SHA256 Credential=test-access\/.*\/auto\/s3\/aws4_request/,
    );
    assert.equal(request.headers.get('content-type'), 'image/png');
    assert.deepEqual(
      new Uint8Array(await request.arrayBuffer()),
      new Uint8Array([1, 2, 3]),
    );
    assert.deepEqual(
      new Uint8Array(
        await new Response(await bucket.get('images/test')).arrayBuffer(),
      ),
      new Uint8Array([1, 2, 3]),
    );
  }
});
test('S3 distinguishes missing objects from provider failures', async (t) => {
  let status = 404;
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status }));
  const bucket = imageBucket(settings)!;
  assert.equal(await bucket.get('images/missing'), null);
  status = 403;
  await assert.rejects(bucket.get('images/private'), /403/);
  await assert.rejects(
    bucket.put('images/private', new Uint8Array([1]), 'image/png'),
    /403/,
  );
});
test('local S3 round trip', { skip: !process.env.JOT_TEST_S3 }, async () => {
  const bucket = imageBucket({
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'jot-images',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'jot-local',
    S3_SECRET_ACCESS_KEY: 'jot-local-secret',
    S3_FORCE_PATH_STYLE: 'true',
  })!;
  const bytes = new Uint8Array(600_000).fill(42);
  const key = 'images/test-' + crypto.randomUUID();
  await bucket.put(key, bytes, 'image/png');
  assert.deepEqual(
    new Uint8Array(await new Response(await bucket.get(key)).arrayBuffer()),
    bytes,
  );
  assert.equal(await bucket.get('images/missing-' + crypto.randomUUID()), null);
});
