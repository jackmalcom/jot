import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { hashPassword } from 'better-auth/crypto';
import * as Y from 'yjs';
import * as schema from './schema.ts';
import { type Store, migrate } from './storage.ts';
export { migrate, type Store } from './storage.ts';
export { schema };
export interface Page {
  id: string;
  title: string;
  emoji: string | null;
  parentId: string | null;
  position: number;
  deletedAt: number | null;
  deletionId: string | null;
  updatedAt: number;
}
export interface Identity {
  id: string;
  name: string;
  sessionId: string;
  expiresAt: number;
}
export interface Peer {
  send(data: string): void;
  close(code: number, reason: string): void;
  meta: {
    connectionId: string;
    identity: Identity;
    pageId: string | null;
    clientId?: number;
  };
  save(): void;
}
export interface Config {
  origin: string;
  secret: string;
  operatorSecret?: string;
}
export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const encode = (data: Uint8Array) => {
  let str = '';
  for (let i = 0; i < data.length; i += 8192)
    str += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(str);
};
export const decode = (data: string) =>
  Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
function title(value: unknown) {
  if (typeof value !== 'string' || value.length > 200)
    throw new Problem(400, 'Use a title of 200 characters or fewer.');
  return value.trim() || 'Untitled';
}
function pageEmoji(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (
    typeof value !== 'string' ||
    value.length > 32 ||
    [
      ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
        value,
      ),
    ].length !== 1 ||
    !/(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u.test(
      value,
    )
  )
    throw new Problem(400, 'Choose a single emoji.');
  return value;
}
export class Jot {
  auth;
  constructor(
    public store: Store,
    db: any,
    public config: Config,
    public peers: () => Peer[],
  ) {
    if (!config.secret || config.secret.length < 32)
      throw new Error(
        'BETTER_AUTH_SECRET must contain at least 32 characters.',
      );
    migrate(store);
    this.auth = betterAuth({
      database: drizzleAdapter(db, {
        provider: 'sqlite',
        schema,
        transaction: false,
      }),
      baseURL: config.origin,
      secret: config.secret,
      trustedOrigins: [config.origin],
      emailAndPassword: { enabled: true, disableSignUp: true },
      session: { cookieCache: { enabled: false } },
      rateLimit: { enabled: false },
    });
  }
  list() {
    return this.store.all<Page>('SELECT * FROM pages ORDER BY position, id');
  }
  page(id: string, includeDeleted = false) {
    const p = this.store.all<Page>('SELECT * FROM pages WHERE id = ?', id)[0];
    if (!p || (!includeDeleted && p.deletedAt))
      throw new Problem(404, 'This page is in trash or no longer exists.');
    return p;
  }
  tree() {
    this.broadcast({ type: 'tree', pages: this.list() });
  }
  broadcast(message: unknown, pageId?: string | null, except?: Peer) {
    const data = JSON.stringify(message);
    for (const peer of this.peers())
      if (
        peer.meta.connectionId !== except?.meta.connectionId &&
        (pageId === undefined || peer.meta.pageId === pageId)
      ) {
        try {
          peer.send(data);
        } catch {
          peer.close(1011, 'Reconnect');
        }
      }
  }
  create(input: any) {
    return this.store.transaction(() => {
      const parentId = input.parentId || null;
      if (parentId) this.page(parentId);
      const id = crypto.randomUUID();
      const siblings = this.list().filter(
        (p) => p.parentId === parentId && !p.deletedAt,
      );
      this.store.run(
        'INSERT INTO pages (id, title, parentId, position, deletedAt, deletionId, updatedAt, emoji) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)',
        id,
        title(input.title ?? 'Untitled'),
        parentId,
        siblings.length,
        Date.now(),
        pageEmoji(input.emoji),
      );
      this.store.run(
        'INSERT INTO documents VALUES (?, ?)',
        id,
        Y.encodeStateAsUpdate(new Y.Doc()),
      );
      return this.page(id);
    });
  }
  change(id: string, input: any) {
    return this.store.transaction(() => {
      const page = this.page(id);
      const all = this.list();
      if (input.title !== undefined)
        this.store.run(
          'UPDATE pages SET title = ?, updatedAt = ? WHERE id = ?',
          title(input.title),
          Date.now(),
          id,
        );
      if ('emoji' in input)
        this.store.run(
          'UPDATE pages SET emoji = ?, updatedAt = ? WHERE id = ?',
          pageEmoji(input.emoji),
          Date.now(),
          id,
        );
      if ('parentId' in input || 'beforeId' in input) {
        const parentId =
          'parentId' in input ? input.parentId || null : page.parentId;
        if (parentId) this.page(parentId);
        let ancestor = parentId;
        const seen = new Set<string>();
        while (ancestor) {
          if (ancestor === id || seen.has(ancestor))
            throw new Problem(409, 'A page cannot be moved inside itself.');
          seen.add(ancestor);
          ancestor = all.find((p) => p.id === ancestor)?.parentId || null;
        }
        const siblings = all.filter(
          (p) => p.parentId === parentId && p.id !== id && !p.deletedAt,
        );
        const index = input.beforeId
          ? siblings.findIndex((p) => p.id === input.beforeId)
          : siblings.length;
        if (index < 0)
          throw new Problem(409, 'The destination changed. Try again.');
        siblings.splice(index, 0, page);
        siblings.forEach((p, i) =>
          this.store.run(
            'UPDATE pages SET parentId = ?, position = ?, updatedAt = ? WHERE id = ?',
            parentId,
            i,
            Date.now(),
            p.id,
          ),
        );
      }
      return this.page(id);
    });
  }
  trash(id: string) {
    return this.store.transaction(() => {
      this.page(id);
      const all = this.list();
      const ids = new Set([id]);
      let size;
      do {
        size = ids.size;
        all
          .filter((p) => !p.deletedAt && p.parentId && ids.has(p.parentId))
          .forEach((p) => ids.add(p.id));
      } while (ids.size !== size);
      const now = Date.now();
      for (const child of ids) {
        this.store.run(
          'UPDATE pages SET deletedAt = ?, deletionId = ?, updatedAt = ? WHERE id = ?',
          now,
          id,
          now,
          child,
        );
      }
      return [...ids];
    });
  }
  restore(id: string) {
    this.store.transaction(() => {
      const page = this.page(id, true);
      if (!page.deletedAt) return;
      const group = page.deletionId || id;
      const root = this.page(group, true);
      if (root.parentId && this.page(root.parentId, true).deletedAt)
        this.store.run(
          'UPDATE pages SET parentId = NULL WHERE id = ?',
          root.id,
        );
      this.store.run(
        'UPDATE pages SET deletedAt = NULL, deletionId = NULL, updatedAt = ? WHERE deletionId = ?',
        Date.now(),
        group,
      );
    });
  }
  document(id: string) {
    this.page(id);
    const doc = new Y.Doc();
    const snapshot = this.store.all<{ snapshot: Uint8Array }>(
      'SELECT snapshot FROM documents WHERE pageId = ?',
      id,
    )[0];
    if (snapshot) Y.applyUpdate(doc, new Uint8Array(snapshot.snapshot));
    for (const update of this.store.all<{ data: Uint8Array }>(
      'SELECT data FROM updates WHERE pageId = ? ORDER BY id',
      id,
    ))
      Y.applyUpdate(doc, new Uint8Array(update.data));
    return doc;
  }
  update(id: string, bytes: Uint8Array) {
    this.store.transaction(() => {
      const doc = this.document(id);
      try {
        Y.applyUpdate(doc, bytes);
        this.store.run(
          'INSERT INTO updates (pageId, data) VALUES (?, ?)',
          id,
          bytes,
        );
        this.store.run(
          'UPDATE pages SET updatedAt = ? WHERE id = ?',
          Date.now(),
          id,
        );
        const count = this.store.all<{ n: number }>(
          'SELECT COUNT(*) AS n FROM updates WHERE pageId = ?',
          id,
        )[0].n;
        if (count >= 100) {
          this.store.run(
            'UPDATE documents SET snapshot = ? WHERE pageId = ?',
            Y.encodeStateAsUpdate(doc),
            id,
          );
          this.store.run('DELETE FROM updates WHERE pageId = ?', id);
        }
      } finally {
        doc.destroy();
      }
    });
  }
  valid(peer: Peer) {
    const rows = this.store.all(
      'SELECT id FROM session WHERE id = ? AND userId = ? AND expiresAt > ?',
      peer.meta.identity.sessionId,
      peer.meta.identity.id,
      Date.now(),
    );
    if (!rows.length) {
      peer.close(4001, 'Sign in again');
      return false;
    }
    return true;
  }
  async identify(headers: Headers): Promise<Identity> {
    const s = await this.auth.api.getSession({ headers });
    if (!s) throw new Problem(401, 'Please sign in.');
    return {
      id: s.user.id,
      name: s.user.name,
      sessionId: s.session.id,
      expiresAt: new Date(s.session.expiresAt).getTime(),
    };
  }
  async connect(request: Request) {
    if (request.headers.get('origin') !== this.config.origin)
      throw new Problem(403, 'Origin rejected');
    const identity = await this.identify(request.headers);
    const pageId = new URL(request.url).searchParams.get('page');
    if (pageId) this.page(pageId);
    return { connectionId: crypto.randomUUID(), identity, pageId };
  }
  open(peer: Peer) {
    peer.send(JSON.stringify({ type: 'tree', pages: this.list() }));
    peer.send(JSON.stringify({ type: 'ready', version: 1 }));
    if (peer.meta.pageId)
      this.broadcast({ type: 'presence-request' }, peer.meta.pageId, peer);
  }
  message(peer: Peer, raw: string) {
    if (!this.valid(peer)) return;
    try {
      if (raw.length > 2_000_000)
        throw new Problem(413, 'Update is too large.');
      const msg = JSON.parse(raw);
      const pageId = peer.meta.pageId;
      if (msg.type === 'ping') {
        peer.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (!pageId) throw new Problem(400, 'Open a page first.');
      this.page(pageId);
      if (msg.type === 'sync') {
        const doc = this.document(pageId);
        try {
          peer.send(
            JSON.stringify({
              type: 'sync',
              update: encode(Y.encodeStateAsUpdate(doc, decode(msg.vector))),
              vector: encode(Y.encodeStateVector(doc)),
            }),
          );
        } finally {
          doc.destroy();
        }
      } else if (msg.type === 'update') {
        const bytes = decode(msg.update);
        this.update(pageId, bytes);
        peer.send(JSON.stringify({ type: 'ack', id: msg.id }));
        this.broadcast({ type: 'update', update: msg.update }, pageId, peer);
      } else if (msg.type === 'presence') {
        if (
          !Number.isSafeInteger(msg.clientId) ||
          msg.clientId < 0 ||
          JSON.stringify(msg.state).length > 10000 ||
          !Number.isSafeInteger(msg.clock)
        )
          throw new Problem(400, 'Invalid presence');
        if (
          peer.meta.clientId !== undefined &&
          peer.meta.clientId !== msg.clientId
        )
          throw new Problem(400, 'Invalid client');
        if (
          this.peers().some(
            (p) =>
              p.meta.connectionId !== peer.meta.connectionId &&
              p.meta.clientId === msg.clientId,
          )
        )
          throw new Problem(409, 'Client collision');
        peer.meta.clientId = msg.clientId;
        peer.save();
        const color = ['#4263eb', '#a04bc2', '#168873', '#bd5b36'][
          Array.from(peer.meta.identity.id).reduce(
            (n, c) => n + c.charCodeAt(0),
            0,
          ) % 4
        ];
        this.broadcast(
          {
            type: 'presence',
            clientId: msg.clientId,
            clock: msg.clock,
            state:
              msg.state === null
                ? null
                : {
                    ...msg.state,
                    user: { name: peer.meta.identity.name, color },
                  },
          },
          pageId,
          peer,
        );
      } else throw new Problem(400, 'Unknown message');
    } catch (error) {
      peer.send(
        JSON.stringify({
          type: 'error',
          message:
            error instanceof Problem
              ? error.message
              : 'Unable to sync this update.',
          status: error instanceof Problem ? error.status : 400,
        }),
      );
    }
  }
  closed(peer: Peer) {
    if (peer.meta.clientId !== undefined)
      this.broadcast(
        { type: 'leave', clientId: peer.meta.clientId },
        peer.meta.pageId,
        peer,
      );
  }
  limit(key: string, max = 15) {
    this.store.transaction(() => {
      const now = Date.now();
      this.store.run('DELETE FROM limits WHERE expiresAt < ?', now);
      const row = this.store.all<{ count: number }>(
        'SELECT count FROM limits WHERE key = ?',
        key,
      )[0];
      if ((row?.count || 0) >= max)
        throw new Problem(429, 'Too many attempts. Try again in a minute.');
      this.store.run(
        'INSERT INTO limits VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1',
        key,
        now + 60000,
      );
    });
  }
  async provision(input: any) {
    const email = String(input.email || '')
      .trim()
      .toLowerCase();
    const password = String(input.password || '');
    const name = String(input.name || '').trim();
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      password.length < 12 ||
      password.length > 128
    )
      throw new Problem(
        400,
        'Provide a valid email and a password between 12 and 128 characters.',
      );
    if (input.action !== 'create' && input.action !== 'reset-password')
      throw new Problem(400, 'Unknown operator action.');
    if (input.action === 'create' && (!name || name.length > 100))
      throw new Problem(
        400,
        'Provide a display name (100 characters maximum).',
      );
    const passwordHash = await hashPassword(password);
    this.store.transaction(() => {
      const existing = this.store.all<{ id: string }>(
        'SELECT id FROM user WHERE email = ?',
        email,
      )[0];
      const now = Date.now();
      if (input.action === 'reset-password') {
        if (!existing) throw new Problem(404, 'Account not found.');
        this.store.run(
          'UPDATE account SET password = ?, updatedAt = ? WHERE userId = ? AND providerId = ?',
          passwordHash,
          now,
          existing.id,
          'credential',
        );
        this.store.run('DELETE FROM session WHERE userId = ?', existing.id);
      } else {
        if (existing)
          throw new Problem(409, 'An account with this email already exists.');
        const id = crypto.randomUUID();
        this.store.run(
          'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)',
          id,
          name,
          email,
          now,
          now,
        );
        this.store.run(
          'INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
          crypto.randomUUID(),
          id,
          'credential',
          id,
          passwordHash,
          now,
          now,
        );
      }
    });
    for (const peer of this.peers()) this.valid(peer);
    return { ok: true };
  }
  async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/api/health') return json({ ok: true });
      if (path === '/api/operator' && request.method === 'POST') {
        this.limit('operator', 30);
        const token =
          request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
        if (
          !this.config.operatorSecret ||
          !(await sameSecret(token, this.config.operatorSecret))
        )
          throw new Problem(403, 'Operator credentials rejected.');
        return json(await this.provision(await request.json()));
      }
      if (
        !['GET', 'HEAD'].includes(request.method) &&
        request.headers.get('origin') !== this.config.origin
      )
        throw new Problem(403, 'Origin rejected');
      if (path.startsWith('/api/auth/')) {
        if (path.includes('sign-up'))
          throw new Problem(
            403,
            'Accounts are created by the instance operator.',
          );
        if (request.method === 'POST') {
          this.limit('auth:global', 120);
          if (path.endsWith('/sign-in/email')) {
            const body = (await request.clone().json()) as { email?: string };
            this.limit('auth:' + String(body.email).toLowerCase(), 10);
          }
        }
        const response = await this.auth.handler(request);
        for (const peer of this.peers()) this.valid(peer);
        return response;
      }
      const identity = await this.identify(request.headers);
      if (path === '/api/recent-pages' && request.method === 'GET') {
        return json(
          this.store.all(
            'SELECT pages.*, page_visits.viewedAt FROM page_visits JOIN pages ON pages.id = page_visits.pageId WHERE page_visits.userId = ? AND pages.deletedAt IS NULL ORDER BY page_visits.viewedAt DESC, pages.id LIMIT 8',
            identity.id,
          ),
        );
      }
      const visit = path.match(/^\/api\/pages\/([a-zA-Z0-9-]+)\/visit$/);
      if (visit && request.method === 'POST') {
        this.page(visit[1]);
        this.store.transaction(() => {
          const latest =
            this.store.all<{ time: number | null }>(
              'SELECT MAX(viewedAt) AS time FROM page_visits WHERE userId = ?',
              identity.id,
            )[0]?.time || 0;
          this.store.run(
            'INSERT INTO page_visits (userId, pageId, viewedAt) VALUES (?, ?, ?) ON CONFLICT(userId, pageId) DO UPDATE SET viewedAt = excluded.viewedAt',
            identity.id,
            visit[1],
            Math.max(Date.now(), latest + 1),
          );
        });
        return json({ ok: true });
      }
      if (path === '/api/images' && request.method === 'POST') {
        this.limit('images:' + identity.id, 30);
        const declared = Number(request.headers.get('content-length') || 0);
        if (declared > 5_000_000)
          throw new Problem(413, 'Images must be 5 MB or smaller.');
        const reader = request.body?.getReader();
        if (!reader) throw new Problem(400, 'Choose an image.');
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 5_000_000) {
            await reader.cancel();
            throw new Problem(413, 'Images must be 5 MB or smaller.');
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const starts = (...signature: number[]) =>
          signature.every((v, i) => bytes[i] === v);
        const mime = starts(137, 80, 78, 71, 13, 10, 26, 10)
          ? 'image/png'
          : starts(255, 216, 255)
            ? 'image/jpeg'
            : starts(71, 73, 70, 56)
              ? 'image/gif'
              : starts(82, 73, 70, 70) &&
                  bytes[8] === 87 &&
                  bytes[9] === 69 &&
                  bytes[10] === 66 &&
                  bytes[11] === 80
                ? 'image/webp'
                : null;
        if (!mime)
          throw new Problem(400, 'Choose a PNG, JPEG, GIF, or WebP image.');
        const id = crypto.randomUUID();
        this.store.transaction(() => {
          this.store.run('INSERT INTO images VALUES (?, ?, ?)', id, mime, size);
          for (let i = 0; i < size; i += 512_000) {
            this.store.run(
              'INSERT INTO image_chunks VALUES (?, ?, ?)',
              id,
              i / 512_000,
              bytes.slice(i, i + 512_000),
            );
          }
        });
        return json({ src: '/api/images/' + id }, 201);
      }
      const image = path.match(/^\/api\/images\/([a-zA-Z0-9-]+)$/);
      if (image && request.method === 'GET') {
        const record = this.store.all<{ mime: string; size: number }>(
          'SELECT * FROM images WHERE id = ?',
          image[1],
        )[0];
        if (!record) throw new Problem(404, 'Image not found.');
        const bytes = new Uint8Array(record.size);
        let offset = 0;
        for (const chunk of this.store.all<{ data: Uint8Array | ArrayBuffer }>(
          'SELECT data FROM image_chunks WHERE imageId = ? ORDER BY position',
          image[1],
        )) {
          const data = new Uint8Array(chunk.data);
          bytes.set(data, offset);
          offset += data.length;
        }
        return new Response(bytes, {
          headers: {
            'Content-Type': record.mime,
            'Cache-Control': 'private, no-cache',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      if (path === '/api/pages') {
        if (request.method === 'GET') return json(this.list());
        if (request.method === 'POST') {
          const page = this.create(await request.json());
          this.tree();
          return json(page, 201);
        }
      }
      const match = path.match(/^\/api\/pages\/([a-zA-Z0-9-]+)(\/restore)?$/);
      if (match) {
        const id = match[1];
        if (match[2] && request.method === 'POST') {
          this.restore(id);
          this.tree();
          return json({ ok: true });
        }
        if (!match[2] && request.method === 'PATCH') {
          const page = this.change(id, await request.json());
          this.tree();
          return json(page);
        }
        if (!match[2] && request.method === 'DELETE') {
          const ids = this.trash(id);
          this.tree();
          for (const peer of this.peers())
            if (peer.meta.pageId && ids.includes(peer.meta.pageId))
              peer.send(JSON.stringify({ type: 'deleted' }));
          return json({ ok: true });
        }
      }
      throw new Problem(404, 'Not found');
    } catch (error) {
      if (!(error instanceof Problem)) console.error('Request failed', error);
      return json(
        {
          message:
            error instanceof Problem
              ? error.message
              : 'The request could not be completed.',
        },
        error instanceof Problem ? error.status : 500,
      );
    }
  }
}
async function sameSecret(a: string, b: string) {
  const hash = async (s: string) =>
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)),
    );
  const [x, y] = await Promise.all([hash(a), hash(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
