import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import {
  Jot,
  schema,
  type Store,
  type Peer,
} from '../../../packages/core/src/index';
interface Env {
  JOT: DurableObjectNamespace<JotInstance>;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  BETTER_AUTH_SECRET: string;
  OPERATOR_SECRET?: string;
}
export class JotInstance extends DurableObject<Env> {
  jot: Jot;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const store: Store = {
      all: (sql, ...params) =>
        [
          ...ctx.storage.sql.exec(
            sql,
            ...params.map((v) =>
              v instanceof Uint8Array ? v.slice().buffer : v,
            ),
          ),
        ] as any,
      run: (sql, ...params) => {
        ctx.storage.sql.exec(
          sql,
          ...params.map((v) =>
            v instanceof Uint8Array ? v.slice().buffer : v,
          ),
        );
      },
      transaction: (fn) => ctx.storage.transactionSync(fn),
    };
    this.jot = new Jot(
      store,
      drizzle(ctx.storage, { schema }),
      {
        origin: env.APP_ORIGIN,
        secret: env.BETTER_AUTH_SECRET,
        operatorSecret: env.OPERATOR_SECRET,
      },
      () => ctx.getWebSockets().map((ws) => this.peer(ws)),
    );
  }
  peer(ws: WebSocket): Peer {
    return {
      meta: ws.deserializeAttachment(),
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
      save() {
        ws.serializeAttachment(this.meta);
      },
    };
  }
  async fetch(request: Request) {
    if (
      new URL(request.url).pathname === '/api/sync' &&
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
    ) {
      try {
        const meta = await this.jot.connect(request);
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.serializeAttachment(meta);
        this.ctx.acceptWebSocket(server);
        this.jot.open(this.peer(server));
        return new Response(null, { status: 101, webSocket: client });
      } catch {
        return new Response('Unauthorized', { status: 401 });
      }
    }
    const maxBody =
      new URL(request.url).pathname === '/api/images' ? 5_000_000 : 2_000_000;
    if (Number(request.headers.get('content-length') || 0) > maxBody)
      return new Response('Too large', { status: 413 });
    return this.jot.handle(request);
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') {
      ws.close(1003, 'Text protocol required');
      return;
    }
    this.jot.message(this.peer(ws), message);
  }
  webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.jot.closed(this.peer(ws));
    ws.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
  }
  webSocketError(ws: WebSocket) {
    this.jot.closed(this.peer(ws));
    ws.close(1011, 'Reconnect');
  }
}
export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname.startsWith('/api/'))
      return env.JOT.get(env.JOT.idFromName('jot')).fetch(request);
    return env.ASSETS.fetch(request);
  },
};
