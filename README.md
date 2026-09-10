# jot

A small shared notebook. Svelte, Tiptap, Yjs, Better Auth, Drizzle, and SQLite. Everyone with an account can edit every page. No workspaces, external sync service, or public registration.

## Local development

Requires Node.js 24 and npm. The local installation does **not** install or import Cloudflare tooling.

```sh
npm ci
cp .env.example .env
# Set BETTER_AUTH_SECRET in .env to a random secret of at least 32 characters.
# You can generate one with: openssl rand -hex 32
npm run operator -- create --email you@example.com --name 'Your name'
# Enter a password at the hidden prompt (12–128 characters).
npm run dev
```

Open http://localhost:5173. Vite proxies requests and WebSockets to the standalone server on port 3000. The server stores everything in `data/jot.sqlite`. Account provisioning works while the server is running. Without `.env`, development uses a temporary auth secret, so restarting signs users out.

## Self-hosting

```sh
npm ci
npm run build
# Set APP_ORIGIN to the exact browser-facing origin, e.g. https://notes.example.com
npm start
```

The same Node process serves assets, auth, APIs, and WebSockets. Set `PORT` (default 3000), `DATABASE_PATH` (default `./data/jot.sqlite`), `APP_ORIGIN`, and `BETTER_AUTH_SECRET`. Keep the secret stable across restarts. Put public installations behind an HTTPS reverse proxy with WebSocket upgrade support. Run one server process per database; this version does not coordinate multiple Node processes.

Alternatively, use `docker compose up --build -d` after setting `.env`. The named volume holds the database. Create the first account with:

```sh
docker compose exec jot npm run operator -- create --email you@example.com --name 'Your name'
```

Reset a password with `npm run operator -- reset-password --email you@example.com`. This revokes existing sessions. For noninteractive use, provide the password in `JOT_ACCOUNT_PASSWORD`, not as a command-line argument. There is no public password-reset or signup flow and no email-service dependency.

## Cloudflare

Cloudflare tooling is an isolated, optional package with its own lockfile. One Worker serves assets and routes `/api/*` to one named Durable Object. Its single SQLite database contains accounts, sessions, page metadata, and Yjs content. No D1 is used.

```sh
npm ci
npm run cloudflare:setup
cd apps/cloudflare
npx wrangler login
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put OPERATOR_SECRET
cd ../..
JOT_DEPLOY_ORIGIN=https://jot.YOUR-SUBDOMAIN.workers.dev npm run deploy
```

Choose the Worker name in `apps/cloudflare/wrangler.jsonc` before first deployment. Set `JOT_DEPLOY_ORIGIN` to its actual HTTPS origin (or your configured custom domain); deployment refuses an absent or non-HTTPS value. Wrangler creates the Durable Object namespace through the checked-in binding and migration. Subsequent updates use the same deploy command and retain the database. Set auth and operator secrets to **different** random values of at least 32 characters. The operator secret is never sent to the browser.

Provision or reset cloud accounts:

```sh
export JOT_OPERATOR_SECRET='the value configured above'
npm run operator -- create --url https://jot.YOUR-SUBDOMAIN.workers.dev \
  --email you@example.com --name 'Your name'
```

The command reads the account password from a hidden prompt. The remote operator endpoint uses a separate bearer secret, a bounded attempt rate, and HTTPS. Normal users cannot access it. Store operator credentials outside source control.

### Cloudflare runtime check without deployment

```sh
npm run cloudflare:check
# In apps/cloudflare/.dev.vars, set BETTER_AUTH_SECRET and OPERATOR_SECRET.
npm --prefix apps/cloudflare run dev
```

Open http://localhost:8787. This optional check uses Wrangler; the ordinary local server does not. Local Node data, Wrangler data, and deployed data are independent. The shared core makes local hosting the normal development server, but runtime-specific changes should also pass the Wrangler integration checks.

## Editing

- Create pages inline in the sidebar. Use a page's action menu to add a nested page. Choose an optional emoji from its icon. On desktop, drag near a page's top or bottom edge to reorder, or hold over its center for 325 ms to nest it. Collapsed parents show a small child count.
- The home button beside **jot** opens up to eight recently viewed pages. History is stored per account in SQLite, is refreshed on opening Home, and excludes trashed pages.
- Blocks include text, ordered/unordered lists, checkbox todos, images, page links, headings 1–6, toggles, and heading toggles 1–6. Type a slash command such as `/todo`, `/h3`, `/image`, `/page`, or `/heading toggle 2` and press Enter. Arrow keys select other matching commands; Escape dismisses the menu.
- Toggles start collapsed for each reader. Click the caret to expand; Enter in the summary opens the body for editing. Expansion is local and does not change what another reader sees.
- Image blocks accept HTTP(S) URLs or PNG/JPEG/GIF/WebP uploads up to 5 MB. Uploads are authenticated and stored in SQLite chunks on both hosting targets. Pasting an image also uploads it.
- On desktop, hover a block for its copy/delete menu. Formatting uses standard keyboard shortcuts (Ctrl/Cmd+K edits links); lists support Tab/Shift+Tab and blocks can move with Ctrl/Cmd+Shift+Up/Down. On mobile, a single formatting toolbar appears while editing and follows the visual viewport above the keyboard. Undo affects your own editing history.
- Click the page title to rename in place. Enter or blur saves; Escape cancels.
- Connected users see edits, cursor positions, and names. “Saved” means the server acknowledged persistence. During interruptions, content changes stay in browser IndexedDB and merge on reconnect, including after a refresh and subsequent sign-in.
- Page creation, titles, moves, and trash require connectivity. This is reconnect recovery, not a fully offline app: cold-start browsing without a network is not supported.
- Deleted pages stay recoverable in Trash. Deleting the open page returns to the empty home view. If another user deletes a page while you have unsynced content, a separate recovery field preserves that text for copying. Restoring a subtree does not restore descendants that were separately trashed earlier.

Browser storage is scoped by origin, account, and page. Signing out does not erase pending edits; they remain available when the same account returns. Use separate browser profiles on shared devices. Clearing site data removes locally pending edits.

## Code and storage

- `packages/core`: platform-independent request handling, Better Auth configuration, Drizzle schema, versioned migrations, page operations, and document protocol.
- `apps/node`: Node HTTP/WebSocket server and `better-sqlite3` driver.
- `apps/cloudflare`: Worker routing and Durable Object SQLite/WebSocket adapter.
- `apps/web`: Svelte interface and Yjs/IndexedDB provider.

The HTTP API provides `/api/auth/*`, `/api/pages`, `/api/pages/:id`, `/api/pages/:id/restore`, `/api/health`, and the operator-only `/api/operator`. `/api/sync[?page=ID]` uses protocol v1 JSON envelopes with Yjs binary payloads encoded as base64. Page metadata follows server commit order. Text merges with Yjs rather than last-write-wins replacement.

Yjs snapshots and incremental updates are the source of truth for block content. There is no duplicate editable block table. Updates are committed before acknowledgment/broadcast and compacted every 100 updates. Document state is reconstructed from SQLite, so runtime eviction cannot lose acknowledged changes. Cloudflare uses hibernating WebSockets and connection attachments; presence remains ephemeral.

Migrations live in `packages/core/src/storage.ts` and execute synchronously and transactionally at startup, with applied versions recorded in SQLite. Add new versions rather than modifying an applied migration. Better Auth uses its supported Drizzle adapter with asynchronous auth transactions disabled; note writes use synchronous SQLite transactions. Do not enable async transaction callbacks on the DO driver.

## Verification

```sh
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run cloudflare:check
```

Browser tests launch an isolated Node server with a temporary database. They exercise two independent accounts, same-paragraph edits, offline merge, reload durability, checkboxes, nested pages, trash/restore, and mobile widths. The same tests can target a running Wrangler instance configured with the test secrets used in `tests/browser-server.ts`:

```sh
JOT_TEST_URL=http://localhost:8787 JOT_TEST_OUTPUT=test-results/cloudflare npm run test:browser
```

Do not run this test suite against a real instance: it creates accounts and pages. Keep browser and adapter checks in addition to core tests when changing synchronization or storage.

## Current boundaries

Designed for a small trusted group using one instance. No general file attachments, comments, full offline navigation, per-page permissions, export/import, or cross-target migration tools. Back up the self-hosted database using SQLite's backup API or stop the process before copying the database and its WAL files. Uploaded images remain stored when their blocks are deleted so collaborative undo and copied blocks keep working; automatic image garbage collection is not implemented. Database growth and maximum document sizes have not been load-tested for large installations.
