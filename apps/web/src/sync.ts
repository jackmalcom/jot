import { uuidv4 } from 'lib0/random';
import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import { IndexeddbPersistence } from 'y-indexeddb';
const encode = (bytes: Uint8Array) => {
  let str = '';
  for (let i = 0; i < bytes.length; i += 8192)
    str += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(str);
};
const decode = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export class PageSync {
  doc = new Y.Doc();
  awareness = new Awareness(this.doc);
  persistence: IndexeddbPersistence;
  ws?: WebSocket;
  stopped = false;
  deleted = false;
  timer?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  pending = new Set<string>();
  synced = false;
  reconnectDelay = 500;
  constructor(
    public pageId: string,
    userId: string,
    public notify: (message: any) => void,
  ) {
    this.persistence = new IndexeddbPersistence(
      `jot:${location.origin}:${userId}:${pageId}`,
      this.doc,
    );
    window.addEventListener('offline', this.offline);
    window.addEventListener('online', this.online);
    this.doc.on('update', this.onUpdate);
    this.awareness.on('update', this.onAwareness);
  }
  offline = () => {
    this.ws?.close();
    this.notify({ type: 'status', value: 'Offline · saved on device' });
  };
  online = () => {
    clearTimeout(this.timer);
    if (
      !this.stopped &&
      this.ws?.readyState !== WebSocket.OPEN &&
      this.ws?.readyState !== WebSocket.CONNECTING
    )
      this.connect();
  };
  async start() {
    await this.persistence.whenSynced;
    if (!this.stopped) this.connect();
  }
  send(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify(data));
  }
  onUpdate = (update: Uint8Array, origin: any) => {
    if (origin === this || origin === this.persistence) return;
    this.notify({
      type: 'status',
      value:
        this.ws?.readyState === WebSocket.OPEN
          ? 'Saving…'
          : 'Offline · saved on device',
    });
    if (this.synced && !this.deleted) this.push(update);
  };
  push(update: Uint8Array) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const id = uuidv4();
    this.pending.add(id);
    this.send({ type: 'update', id, update: encode(update) });
  }
  onAwareness = (_: any, origin: any) => {
    if (origin === this) return;
    this.sendPresence();
  };
  sendPresence() {
    this.send({
      type: 'presence',
      clientId: this.doc.clientID,
      clock: this.awareness.meta.get(this.doc.clientID)?.clock || 0,
      state: this.awareness.getLocalState(),
    });
  }
  connect() {
    if (this.stopped || this.deleted || !navigator.onLine) return;
    this.notify({ type: 'status', value: 'Connecting…' });
    const ws = (this.ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/sync?page=${encodeURIComponent(this.pageId)}`,
    ));
    ws.onopen = () => {
      this.reconnectDelay = 500;
      this.pending.clear();
      this.send({
        type: 'sync',
        vector: encode(Y.encodeStateVector(this.doc)),
      });
      this.sendPresence();
      this.heartbeat = setInterval(() => {
        this.send({ type: 'ping' });
        this.sendPresence();
      }, 20000);
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'sync') {
        Y.applyUpdate(this.doc, decode(msg.update), this);
        this.synced = true;
        this.push(Y.encodeStateAsUpdate(this.doc, decode(msg.vector)));
        this.sendPresence();
      } else if (msg.type === 'update')
        Y.applyUpdate(this.doc, decode(msg.update), this);
      else if (msg.type === 'ack') {
        this.pending.delete(msg.id);
        if (!this.pending.size) this.notify({ type: 'status', value: 'Saved' });
      } else if (msg.type === 'presence') {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 1);
        encoding.writeVarUint(encoder, msg.clientId);
        encoding.writeVarUint(encoder, msg.clock);
        encoding.writeVarString(encoder, JSON.stringify(msg.state));
        applyAwarenessUpdate(
          this.awareness,
          encoding.toUint8Array(encoder),
          this,
        );
      } else if (msg.type === 'presence-request') this.sendPresence();
      else if (msg.type === 'leave')
        removeAwarenessStates(this.awareness, [msg.clientId], this);
      else if (
        msg.type === 'deleted' ||
        (msg.type === 'error' && msg.status === 404)
      ) {
        this.deleted = true;
        this.notify({ type: 'deleted' });
        ws.close();
      } else this.notify(msg);
    };
    ws.onclose = (event) => {
      this.synced = false;
      clearInterval(this.heartbeat);
      removeAwarenessStates(
        this.awareness,
        [...this.awareness.getStates().keys()].filter(
          (id) => id !== this.doc.clientID,
        ),
        this,
      );
      if (this.stopped || this.deleted) return;
      if (event.code === 4001) {
        this.notify({ type: 'expired' });
        return;
      }
      this.notify({ type: 'status', value: 'Offline · saved on device' });
      this.timer = setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
    };
  }
  async destroy() {
    this.stopped = true;
    window.removeEventListener('offline', this.offline);
    window.removeEventListener('online', this.online);
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.awareness.setLocalState(null);
    this.ws?.close();
    this.doc.off('update', this.onUpdate);
    this.awareness.off('update', this.onAwareness);
    this.awareness.destroy();
    await this.persistence.destroy();
    this.doc.destroy();
  }
}
