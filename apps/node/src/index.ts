import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { Jot, type Peer } from '../../../packages/core/src/index.ts';
import { database } from './database.ts';
const port = Number(process.env.PORT || 3000);
const origin = process.env.APP_ORIGIN || `http://localhost:${port}`;
const databasePath = process.env.DATABASE_PATH || './data/jot.sqlite';
const databaseHandle = database(databasePath);
const peers = new Set<Peer>();
const jot = new Jot(
  databaseHandle.store,
  databaseHandle.db,
  {
    origin,
    secret: process.env.BETTER_AUTH_SECRET || '',
    operatorSecret: process.env.OPERATOR_SECRET,
  },
  () => [...peers],
);
const assets = resolve('apps/web/dist');
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', origin);
    if (url.pathname.startsWith('/api/')) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (url.pathname === '/api/images' ? 5_000_000 : 2_000_000)) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value)
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const request = new Request(url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method || 'GET')
          ? undefined
          : Buffer.concat(chunks),
      });
      const response = await jot.handle(request);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') res.setHeader(key, value);
      });
      res.setHeader('set-cookie', response.headers.getSetCookie());
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let path = resolve(assets, '.' + decodeURIComponent(url.pathname));
    if (path !== assets && !path.startsWith(assets + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (!(await stat(path)).isFile()) path = resolve(assets, 'index.html');
    } catch {
      path = resolve(assets, 'index.html');
    }
    const data = await readFile(path);
    res.setHeader(
      'Content-Type',
      types[extname(path)] || 'application/octet-stream',
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Cache-Control',
      path.includes('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    );
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res
      .writeHead(500)
      .end('Unable to serve jot. Build the frontend with npm run build.');
  }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 2_000_000 });
server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url || '/', origin);
    if (url.pathname !== '/api/sync') throw new Error('Not found');
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const meta = await jot.connect(new Request(url, { headers }));
    wss.handleUpgrade(req, socket, head, (ws) => {
      const peer: Peer = {
        meta,
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
        save() {},
      };
      peers.add(peer);
      jot.open(peer);
      ws.on('message', (data, binary) => {
        if (binary) ws.close(1003, 'Text protocol required');
        else jot.message(peer, data.toString());
      });
      ws.on('close', () => {
        peers.delete(peer);
        jot.closed(peer);
      });
      ws.on('error', () => ws.close());
      const timer = setInterval(() => {
        if (jot.valid(peer)) ws.ping();
      }, 30000);
      ws.on('close', () => clearInterval(timer));
    });
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});
server.listen(port, '0.0.0.0', () =>
  console.log(`jot server: http://localhost:${port}`),
);
function stop() {
  for (const peer of peers) peer.close(1001, 'Server stopping');
  server.close(() => {
    databaseHandle.close();
    process.exit(0);
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
