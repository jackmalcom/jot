import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { database } from '../apps/node/src/database.ts';
import { migrations, migrate } from '../packages/core/src/storage.ts';
import { Jot, encode, type Peer } from '../packages/core/src/index.ts';
const origin = 'http://localhost:3000';
function setup() {
  const handle = database(':memory:');
  const peers: Peer[] = [];
  const app = new Jot(
    handle.store,
    handle.db,
    {
      origin,
      secret: 'test-secret-that-is-at-least-32-characters',
      operatorSecret: 'operator-secret-test',
    },
    () => peers,
  );
  return { app, handle, peers };
}
async function login(
  app: Jot,
  email = 'alice@example.com',
  password = 'test-password-1234',
) {
  const response = await app.handle(
    new Request(origin + '/api/auth/sign-in/email', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  return response.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
}
test('operator accounts, login, session, disabled signup, origin checks and revocation', async () => {
  const { app, handle, peers } = setup();
  try {
    await app.provision({
      action: 'create',
      email: 'Alice@example.com',
      name: 'Alice',
      password: 'test-password-1234',
    });
    const cookie = await login(app);
    const identity = await app.identify(new Headers({ cookie }));
    assert.equal(identity.name, 'Alice');
    assert.equal(
      (
        await app.handle(
          new Request(origin + '/api/auth/sign-up/email', {
            method: 'POST',
            headers: { origin },
          }),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await app.handle(
          new Request(origin + '/api/pages', {
            method: 'POST',
            headers: { cookie, origin: 'http://evil.test' },
          }),
        )
      ).status,
      403,
    );
    assert.equal(
      (await app.handle(new Request(origin + '/api/pages'))).status,
      401,
    );
    let closed = false;
    peers.push({
      meta: { connectionId: 'test', identity, pageId: null },
      send() {},
      save() {},
      close() {
        closed = true;
      },
    });
    await app.provision({
      action: 'reset-password',
      email: 'alice@example.com',
      password: 'new-password-1234',
    });
    assert.ok(closed);
    await assert.rejects(() => app.identify(new Headers({ cookie })));
    const next = await login(app, 'alice@example.com', 'new-password-1234');
    const response = await app.handle(
      new Request(origin + '/api/auth/sign-out', {
        method: 'POST',
        headers: { cookie: next, origin, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    assert.equal(response.status, 200);
    await assert.rejects(() => app.identify(new Headers({ cookie: next })));
  } finally {
    handle.close();
  }
});
test('tree rejects cycles, reorders siblings, restores subtrees and respects prior trash', () => {
  const { app, handle } = setup();
  try {
    const a = app.create({ title: 'A' });
    const b = app.create({ title: 'B', parentId: a.id });
    const c = app.create({ title: 'C', parentId: b.id });
    const d = app.create({ title: 'D' });
    assert.throws(() => app.change(a.id, { parentId: c.id }), /inside itself/);
    app.change(d.id, { parentId: null, beforeId: a.id });
    assert.equal(app.list().filter((p) => !p.parentId)[0].id, d.id);
    app.trash(c.id);
    app.trash(a.id);
    assert.equal(app.page(b.id, true).deletionId, a.id);
    app.restore(a.id);
    assert.equal(app.page(b.id).deletedAt, null);
    assert.ok(app.page(c.id, true).deletedAt);
    app.trash(a.id);
    app.restore(c.id);
    assert.equal(app.page(c.id).parentId, null);
  } finally {
    handle.close();
  }
});
test('concurrent Yjs changes merge, replay is idempotent and compaction survives reconstruction', () => {
  const { app, handle } = setup();
  try {
    const page = app.create({ title: 'Shared' });
    const a = new Y.Doc(),
      b = new Y.Doc();
    a.getText('test').insert(0, 'Hello');
    b.getText('test').insert(0, 'World');
    const x = Y.encodeStateAsUpdate(a),
      y = Y.encodeStateAsUpdate(b);
    app.update(page.id, x);
    app.update(page.id, y);
    app.update(page.id, x);
    for (let i = 0; i < 105; i++) {
      a.getText('test').insert(a.getText('test').length, '.');
      app.update(page.id, Y.encodeStateAsUpdate(a));
    }
    const restored = app.document(page.id);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    assert.equal(
      restored.getText('test').toString(),
      a.getText('test').toString(),
    );
    const fresh = new Jot(handle.store, handle.db, app.config, () => []);
    assert.equal(
      fresh.document(page.id).getText('test').toString(),
      restored.getText('test').toString(),
    );
    assert.ok(
      handle.store.all<{ n: number }>('SELECT count(*) n FROM updates')[0].n <
        100,
    );
    app.trash(page.id);
    assert.throws(() => app.update(page.id, x), /trash/);
    a.destroy();
    b.destroy();
    restored.destroy();
  } finally {
    handle.close();
  }
});
test('invalid Yjs updates are not persisted', () => {
  const { app, handle } = setup();
  try {
    const p = app.create({});
    assert.throws(() => app.update(p.id, new Uint8Array([255, 255])));
    assert.equal(handle.store.all('SELECT * FROM updates').length, 0);
  } finally {
    handle.close();
  }
});
test('operator endpoint rejects absent/invalid token and public signup cannot be bypassed', async () => {
  const { app, handle } = setup();
  try {
    for (const headers of [
      new Headers(),
      new Headers({ authorization: 'Bearer invalid' }),
    ]) {
      assert.equal(
        (
          await app.handle(
            new Request(origin + '/api/operator', { method: 'POST', headers }),
          )
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await app.handle(
          new Request(origin + '/api/auth/sign-up/email/', {
            method: 'POST',
            headers: { origin },
          }),
        )
      ).status,
      403,
    );
  } finally {
    handle.close();
  }
});
test('page emojis persist and validate single composed emoji', () => {
  const { app, handle } = setup();
  try {
    const page = app.create({ title: 'Notes', emoji: '📝' });
    assert.equal(page.emoji, '📝');
    for (const emoji of ['👩🏽‍💻', '🇺🇸', '1️⃣'])
      assert.equal(app.change(page.id, { emoji }).emoji, emoji);
    for (const emoji of ['abc', '📝📝', '1', 42])
      assert.throws(() => app.change(page.id, { emoji }), /single emoji/);
    assert.equal(app.change(page.id, { emoji: null }).emoji, null);
    assert.equal(app.create({}).emoji, null);
  } finally {
    handle.close();
  }
});

test('emoji migration preserves existing pages and document snapshots', () => {
  const handle = database(':memory:');
  try {
    for (const sql of migrations[0].statements) handle.store.run(sql);
    handle.store.run('CREATE TABLE migrations (version INTEGER PRIMARY KEY)');
    handle.store.run('INSERT INTO migrations VALUES (1)');
    handle.store.run(
      'INSERT INTO pages VALUES (?, ?, NULL, 0, NULL, NULL, ?)',
      'legacy',
      'Existing page',
      Date.now(),
    );
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'Keep my notes');
    handle.store.run(
      'INSERT INTO documents VALUES (?, ?)',
      'legacy',
      Y.encodeStateAsUpdate(doc),
    );
    migrate(handle.store);
    migrate(handle.store);
    const page = handle.store.all<{ title: string; emoji: string | null }>(
      'SELECT * FROM pages',
    )[0];
    assert.equal(page.title, 'Existing page');
    assert.equal(page.emoji, null);
    const saved = handle.store.all<{ snapshot: Uint8Array }>(
      'SELECT snapshot FROM documents',
    )[0];
    const restored = new Y.Doc();
    Y.applyUpdate(restored, saved.snapshot);
    assert.equal(restored.getText('content').toString(), 'Keep my notes');
    doc.destroy();
    restored.destroy();
  } finally {
    handle.close();
  }
});

test('recent pages are per-account, ordered, capped, and exclude trash', async () => {
  const { app, handle } = setup();
  try {
    for (const name of ['Alice', 'Bob'])
      await app.provision({
        action: 'create',
        name,
        email: name.toLowerCase() + '@example.com',
        password: 'test-password-1234',
      });
    const cookie = await login(app);
    const bobCookie = await login(app, 'bob@example.com');
    const ids: string[] = [];
    for (let index = 0; index < 10; index++) {
      const page = app.create({ title: 'Page ' + index });
      ids.push(page.id);
      const response = await app.handle(
        new Request(origin + '/api/pages/' + page.id + '/visit', {
          method: 'POST',
          headers: { cookie, origin },
        }),
      );
      assert.equal(response.status, 200);
      // Deterministic timestamps for ordering and truncation assertions.
      handle.store.run(
        'UPDATE page_visits SET viewedAt = ? WHERE pageId = ?',
        index,
        page.id,
      );
    }
    const recents = async (session = cookie) =>
      (
        await app.handle(
          new Request(origin + '/api/recent-pages', {
            headers: { cookie: session },
          }),
        )
      ).json();
    assert.deepEqual(
      (await recents()).map((page: any) => page.id),
      ids.slice(2).reverse(),
    );
    assert.deepEqual(await recents(bobCookie), []);
    await app.handle(
      new Request(origin + '/api/pages/' + ids[0] + '/visit', {
        method: 'POST',
        headers: { cookie, origin },
      }),
    );
    assert.equal((await recents())[0].id, ids[0]);
    assert.equal((await recents()).length, 8);
    app.change(ids[0], { title: 'Renamed', emoji: '📘' });
    assert.equal((await recents())[0].title, 'Renamed');
    app.trash(ids[0]);
    assert.equal(
      (await recents()).some((page: any) => page.id === ids[0]),
      false,
    );
    assert.equal(
      (
        await app.handle(
          new Request(origin + '/api/pages/' + ids[0] + '/visit', {
            method: 'POST',
            headers: { cookie, origin },
          }),
        )
      ).status,
      404,
    );
    assert.equal(
      (await app.handle(new Request(origin + '/api/recent-pages'))).status,
      401,
    );
  } finally {
    handle.close();
  }
});

test('image uploads persist in chunks and require authentication and supported content', async () => {
  const { app, handle } = setup();
  try {
    await app.provision({
      action: 'create',
      name: 'Alice',
      email: 'alice@example.com',
      password: 'test-password-1234',
    });
    const cookie = await login(app);
    const bytes = new Uint8Array(600_000);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const upload = await app.handle(
      new Request(origin + '/api/images', {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'image/png' },
        body: bytes,
      }),
    );
    assert.equal(upload.status, 201);
    const { src } = await upload.json();
    const image = await app.handle(
      new Request(origin + src, { headers: { cookie } }),
    );
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), bytes);
    assert.equal(handle.store.all('SELECT * FROM image_chunks').length, 2);
    assert.equal((await app.handle(new Request(origin + src))).status, 401);
    assert.equal(
      (
        await app.handle(
          new Request(origin + '/api/images', {
            method: 'POST',
            headers: { cookie, origin, 'content-type': 'image/svg+xml' },
            body: '<svg></svg>',
          }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await app.handle(
          new Request(origin + '/api/images', {
            method: 'POST',
            headers: { cookie, origin, 'content-length': '5000001' },
            body: bytes,
          }),
        )
      ).status,
      413,
    );
  } finally {
    handle.close();
  }
});
