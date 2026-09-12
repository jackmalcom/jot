import { AwsClient } from 'aws4fetch';

export interface ImageBucket {
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
}
export interface S3Env {
  S3_ENDPOINT?: string;
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_FORCE_PATH_STYLE?: string;
}

export function imageBucket(env: S3Env): ImageBucket | undefined {
  if (
    ![
      'S3_ENDPOINT',
      'S3_BUCKET',
      'S3_REGION',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'S3_FORCE_PATH_STYLE',
    ].some((key) => env[key as keyof S3Env])
  )
    return;
  for (const name of [
    'S3_ENDPOINT',
    'S3_BUCKET',
    'S3_REGION',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
  ] as const)
    if (!env[name])
      throw new Error(`${name} is required for image bucket storage.`);
  if (
    env.S3_FORCE_PATH_STYLE &&
    !['true', 'false'].includes(env.S3_FORCE_PATH_STYLE)
  )
    throw new Error('S3_FORCE_PATH_STYLE must be true or false.');
  const endpoint = new URL(env.S3_ENDPOINT!);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  )
    throw new Error(
      'S3_ENDPOINT must be an HTTP(S) origin without a path or credentials.',
    );
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.S3_BUCKET!))
    throw new Error('S3_BUCKET must be a valid S3 bucket name.');
  const aws = new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    region: env.S3_REGION!,
    service: 's3',
    retries: 2,
  });
  function url(key: string) {
    const result = new URL(endpoint);
    if (env.S3_FORCE_PATH_STYLE !== 'true')
      result.hostname = `${env.S3_BUCKET}.${result.hostname}`;
    result.pathname =
      (env.S3_FORCE_PATH_STYLE === 'true' ? `/${env.S3_BUCKET}` : '') +
      '/' +
      key.split('/').map(encodeURIComponent).join('/');
    return result.toString();
  }
  return {
    async put(key, bytes, mime) {
      const response = await aws.fetch(url(key), {
        method: 'PUT',
        body: bytes.slice().buffer,
        headers: { 'Content-Type': mime },
        signal: AbortSignal.timeout(30_000),
      });
      await response.body?.cancel();
      if (!response.ok)
        throw new Error(`Image bucket upload failed (${response.status}).`);
    },
    async get(key) {
      const response = await aws.fetch(url(key), {
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok && response.body) return response.body;
      await response.body?.cancel();
      if (response.status === 404) return null;
      throw new Error(`Image bucket read failed (${response.status}).`);
    },
  };
}
