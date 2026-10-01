import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../apps/node/src/database.ts';
import { Jot } from '../packages/core/src/index.ts';

const origin = 'https://jot.example.com';
const day = 24 * 60 * 60 * 1000;
const lifetime = 30 * day;
const start = Date.UTC(2030, 0, 1);
const sessionCookieName = '__Secure-better-auth.session_token';

async function setup(t: TestContext, rememberMe = true) {
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const handle = database(':memory:');
  t.after(() => handle.close());
  const app = new Jot(
    handle.store,
    handle.db,
    { origin, secret: 'session-test-secret-at-least-32-characters' },
    () => [],
  );
  const email = 'alice@example.com';
  const password = 'test-password-1234';
  await app.provision({ action: 'create', email, name: 'Alice', password });
  const login = await app.handle(
    new Request(origin + '/api/auth/sign-in/email', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, rememberMe }),
    }),
  );
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const session = () =>
    handle.store.all<{ id: string; expiresAt: number; updatedAt: number }>(
      'SELECT id, expiresAt, updatedAt FROM session',
    )[0];
  const request = (path = '/api/pages', init?: RequestInit) =>
    app.handle(
      new Request(origin + path, {
        ...init,
        headers: { cookie, origin, ...init?.headers },
      }),
    );
  return { app, handle, login, cookie, session, request };
}

function sessionCookie(response: Response) {
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith(sessionCookieName + '='));
}

function assertRenewed(response: Response) {
  const cookie = sessionCookie(response);
  assert.ok(cookie, 'the browser must receive the renewed session cookie');
  assert.match(cookie, /Max-Age=2592000(?:;|$)/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/i);
  assert.ok(
    !response.headers
      .getSetCookie()
      .some((value) => value.includes('session_data=')),
    'cookie caching must remain disabled',
  );
}

test('sign-in stores a 30-day session and persistent secure browser cookie', async (t) => {
  const { login, session } = await setup(t);
  assert.equal(session().expiresAt, start + lifetime);
  assert.equal(session().updatedAt, start);
  assertRenewed(login);
});

test('ordinary API activity rolls both expiries after one day, without renewing every request', async (t) => {
  const { login, session, request } = await setup(t);
  t.mock.timers.setTime(start + day - 1);
  const before = await request();
  assert.equal(before.status, 200);
  assert.equal(sessionCookie(before), undefined);
  assert.equal(session().expiresAt, start + lifetime);
  assert.equal(session().updatedAt, start);

  t.mock.timers.setTime(start + day);
  const renewed = await request();
  assert.equal(renewed.status, 200);
  assertRenewed(renewed);
  assert.equal(
    sessionCookie(renewed)?.split(';')[0],
    sessionCookie(login)?.split(';')[0],
  );
  assert.equal(session().expiresAt, start + day + lifetime);
  assert.equal(session().updatedAt, start + day);
  assert.equal(sessionCookie(await request()), undefined);

  // Returning after several weeks, then beyond the original login lifetime,
  // continues to extend the same native session rather than requiring a login.
  for (const elapsed of [30 * day, 59 * day]) {
    t.mock.timers.setTime(start + elapsed);
    const response = await request();
    assert.equal(response.status, 200);
    assertRenewed(response);
    assert.equal(session().expiresAt, start + elapsed + lifetime);
  }
});

test('Better Auth get-session renews after several days away', async (t) => {
  const { session, request } = await setup(t);
  t.mock.timers.setTime(start + 4 * day);
  const response = await request('/api/auth/get-session');
  assert.equal(response.status, 200);
  assertRenewed(response);
  const body = await response.json();
  assert.equal(
    new Date(body.session.expiresAt).getTime(),
    start + 4 * day + lifetime,
  );
  assert.equal(session().expiresAt, start + 4 * day + lifetime);
});

test('renewal cookies survive authenticated API error responses', async (t) => {
  const { session, request } = await setup(t);
  t.mock.timers.setTime(start + 2 * day);
  const response = await request('/api/images/missing');
  assert.equal(response.status, 404);
  assertRenewed(response);
  assert.equal(session().expiresAt, start + 2 * day + lifetime);
});

test('renewal cookies survive image responses without changing image headers or bytes', async (t) => {
  const { request } = await setup(t);
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const upload = await request('/api/images', { method: 'POST', body: bytes });
  assert.equal(upload.status, 201);
  const { src } = await upload.json();
  t.mock.timers.setTime(start + 2 * day);
  const response = await request(src);
  assert.equal(response.status, 200);
  assertRenewed(response);
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-cache');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test('a WebSocket identity check cannot consume the renewal due on the next HTTP request', async (t) => {
  const { app, cookie, session, request } = await setup(t);
  t.mock.timers.setTime(start + 4 * day);
  const connection = await app.connect(
    new Request(origin + '/api/sync', { headers: { cookie, origin } }),
  );
  assert.equal(connection.identity.expiresAt, start + lifetime);
  assert.equal(session().expiresAt, start + lifetime);
  const response = await request();
  assert.equal(response.status, 200);
  assertRenewed(response);
  assert.equal(session().expiresAt, start + 4 * day + lifetime);
});

test('inactive sessions expire after 30 days and cannot be revived', async (t) => {
  const { app, cookie, session, request } = await setup(t);
  t.mock.timers.setTime(start + lifetime + 1);
  const response = await request();
  assert.equal(response.status, 401);
  assert.match(sessionCookie(response) || '', /Max-Age=0(?:;|$)/);
  assert.equal(session(), undefined);
  assert.equal(await (await request('/api/auth/get-session')).json(), null);
  await assert.rejects(() =>
    app.connect(
      new Request(origin + '/api/sync', { headers: { cookie, origin } }),
    ),
  );
});

test('existing unexpired seven-day sessions adopt the new lifetime on activity', async (t) => {
  const { handle, session, request } = await setup(t);
  handle.store.run('UPDATE session SET expiresAt = ?', start + 7 * day);
  t.mock.timers.setTime(start + 3 * day);
  const response = await request();
  assert.equal(response.status, 200);
  assertRenewed(response);
  assert.equal(session().expiresAt, start + 3 * day + lifetime);
});

test('sign-out and password reset immediately revoke renewed sessions', async (t) => {
  for (const action of ['sign-out', 'reset-password']) {
    await t.test(action, async (t) => {
      const { app, request } = await setup(t);
      t.mock.timers.setTime(start + 4 * day);
      assertRenewed(await request());
      if (action === 'sign-out') {
        const response = await request('/api/auth/sign-out', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        assert.equal(response.status, 200);
      } else {
        await app.provision({
          action,
          email: 'alice@example.com',
          password: 'new-password-1234',
        });
      }
      assert.equal((await request()).status, 401);
      assert.equal(await (await request('/api/auth/get-session')).json(), null);
    });
  }
});

test('explicit rememberMe=false keeps Better Auth non-persistent login behavior', async (t) => {
  const { login, session, request } = await setup(t, false);
  assert.doesNotMatch(sessionCookie(login) || '', /Max-Age=/);
  const expiry = session().expiresAt;
  t.mock.timers.setTime(start + day);
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(sessionCookie(response), undefined);
  assert.equal(session().expiresAt, expiry);
});
