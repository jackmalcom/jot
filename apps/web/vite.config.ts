import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { hostname, networkInterfaces } from 'node:os';

// LAN access is limited to this development proxy; production origin checks stay strict.
const lanHosts = [hostname() + '.local', 'jot.local'];
const devOrigins = new Set(
  [
    ...lanHosts,
    ...Object.values(networkInterfaces()).flatMap((addresses) =>
      (addresses || [])
        .filter((address) => address.family === 'IPv4' && !address.internal)
        .map((address) => address.address),
    ),
  ].map((host) => 'http://' + host + ':5173'),
);
const appOrigin = process.env.APP_ORIGIN || 'http://localhost:5173';
devOrigins.add('https://jot.local');

export default defineConfig({
  plugins: [svelte()],
  server: {
    host: '0.0.0.0',
    allowedHosts: lanHosts,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        ws: true,
        configure(proxy) {
          const rewriteOrigin = (
            outgoing: import('node:http').ClientRequest,
            request: import('node:http').IncomingMessage,
          ) => {
            if (
              request.headers.origin &&
              devOrigins.has(request.headers.origin)
            ) {
              outgoing.setHeader('origin', appOrigin);
            }
          };
          proxy.on('proxyReq', rewriteOrigin);
          proxy.on('proxyReqWs', rewriteOrigin);
        },
      },
    },
  },
  build: { target: 'es2022' },
});
