import { stdin, stdout } from 'node:process';
import { database } from '../apps/node/src/database.ts';
import { Jot } from '../packages/core/src/index.ts';
import { randomBytes } from 'node:crypto';
const args = process.argv.slice(2);
const action = args[0];
const get = (key: string) => {
  const i = args.indexOf('--' + key);
  return i < 0 ? undefined : args[i + 1];
};
if (!['create', 'reset-password'].includes(action)) {
  console.error(
    'Usage: npm run operator -- create|reset-password --email EMAIL [--name NAME] [--url ORIGIN]\nPassword is read from a hidden prompt or JOT_ACCOUNT_PASSWORD. Remote commands read JOT_OPERATOR_SECRET.',
  );
  process.exit(1);
}
async function passwordPrompt() {
  if (process.env.JOT_ACCOUNT_PASSWORD) return process.env.JOT_ACCOUNT_PASSWORD;
  if (!stdin.isTTY)
    throw new Error(
      'Set JOT_ACCOUNT_PASSWORD for non-interactive provisioning.',
    );
  stdout.write('Password: ');
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve) => {
    let value = '';
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') process.exit(130);
        if (char === '\r' || char === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u007f') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}
let handle: ReturnType<typeof database> | undefined;
try {
  const input = {
    action,
    email: get('email'),
    name: get('name'),
    password: await passwordPrompt(),
  };
  const url = get('url');
  if (url) {
    if (!process.env.JOT_OPERATOR_SECRET)
      throw new Error('Set JOT_OPERATOR_SECRET.');
    const target = new URL(url);
    if (
      target.protocol !== 'https:' &&
      !['localhost', '127.0.0.1'].includes(target.hostname)
    )
      throw new Error('Remote provisioning requires HTTPS.');
    const response = await fetch(new URL('/api/operator', target), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.JOT_OPERATOR_SECRET}`,
      },
      body: JSON.stringify(input),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(
        ((await response.json()) as any).message || 'Provisioning failed',
      );
  } else {
    handle = database(process.env.DATABASE_PATH || './data/jot.sqlite');
    const app = new Jot(
      handle.store,
      handle.db,
      {
        origin: process.env.APP_ORIGIN || 'http://localhost:3000',
        secret:
          process.env.BETTER_AUTH_SECRET || randomBytes(32).toString('hex'),
      },
      () => [],
    );
    await app.provision(input);
  }
  console.log(
    action === 'create'
      ? 'Account created.'
      : 'Password reset and existing sessions revoked.',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  handle?.close();
}
