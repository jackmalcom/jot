import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { database } from '../apps/node/src/database.ts';
import { Jot, encode, decode, type Peer } from '../packages/core/src/index.ts';
const config = {
  origin: 'http://localhost:3000',
  secret: 'protocol-test-secret-with-at-least-32-chars',
};
test('acknowledged edits survive closing SQLite and rehydrating connection attachments', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jot-protocol-'));
  const path = join(directory, 'jot.sqlite');
  let db = database(path);
  let sent: any[] = [];
  const meta: Peer['meta'] = {
    connectionId: 'connection',
    identity: {
      id: 'user',
      name: 'Writer',
      sessionId: 'session',
      expiresAt: Date.now() + 60000,
    },
    pageId: null,
  };
  const peer = (): Peer => ({
    meta,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
    close() {
      throw new Error('Unexpected close');
    },
    save() {},
  });
  let jot = new Jot(db.store, db.db, config, () => [peer()]);
  try {
    db.store.run(
      'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)',
      'user',
      'Writer',
      'writer@example.com',
      Date.now(),
      Date.now(),
    );
    db.store.run(
      'INSERT INTO session (id, token, userId, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
      'session',
      'token',
      'user',
      Date.now() + 60000,
      Date.now(),
      Date.now(),
    );
    meta.pageId = jot.create({ title: 'Durable' }).id;
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'Persisted before ack');
    jot.message(
      peer(),
      JSON.stringify({
        type: 'update',
        id: 'first',
        update: encode(Y.encodeStateAsUpdate(doc)),
      }),
    );
    assert.deepEqual(
      sent.map((m) => m.type),
      ['ack'],
      'the sender should not receive its own broadcast after attachment rehydration',
    );
    db.close();
    db = database(path);
    jot = new Jot(db.store, db.db, config, () => [peer()]);
    sent = [];
    jot.message(
      peer(),
      JSON.stringify({
        type: 'sync',
        vector: encode(Y.encodeStateVector(new Y.Doc())),
      }),
    );
    const restored = new Y.Doc();
    Y.applyUpdate(restored, decode(sent[0].update));
    assert.equal(
      restored.getText('content').toString(),
      'Persisted before ack',
    );
    jot.message(
      peer(),
      JSON.stringify({
        type: 'presence',
        clientId: doc.clientID,
        clock: 1,
        state: { user: { name: 'forged' } },
      }),
    );
    assert.equal(
      sent.filter((m) => m.type === 'error').length,
      0,
      'a rehydrated peer must not collide with itself',
    );
    doc.destroy();
    restored.destroy();
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
