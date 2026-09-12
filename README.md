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

Open http://localhost:5173. Vite proxies requests and WebSockets to the standalone server on port 3000. The server stores data in `data/jot.sqlite`; uploaded images can optionally use an S3-compatible bucket. Account provisioning works while the server is running. Without `.env`, development uses a temporary auth secret, so restarting signs users out.

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

## Railway

Deploy this repository as a Railway service from the repository root. `railway.json` selects the Dockerfile and `/api/health` startup check. Attach a persistent volume at `/data` and keep the service at **one replica in one region**; SQLite and collaboration run in a single process.

Set these service variables before deployment:

- `APP_ORIGIN=https://your-public-domain` (generate a Railway domain or use your custom domain).
- `BETTER_AUTH_SECRET`: a stable random secret of at least 32 characters.
- `OPERATOR_SECRET`: a separate random secret for remote account management.
- `DATABASE_PATH=/data/jot.sqlite` (also the Docker image default).
- `RAILWAY_RUN_UID=0`: Railway volumes are root-owned; this allows the image to write the mounted volume.

Railway supplies `PORT`. Schema migrations run at application startup, after the volume is mounted. A volume is required even when images use a bucket. Configure volume backups in Railway. See Railway's [Dockerfile](https://docs.railway.com/builds/dockerfiles) and [volume documentation](https://docs.railway.com/volumes).

After deployment, create your first account from your local checkout:

```sh
export JOT_OPERATOR_SECRET='your remote operator secret'
npm run operator -- create --url https://your-public-domain \
  --email you@example.com --name 'Your name'
```

## S3-compatible image storage

Set these server variables together to send new uploads to a private bucket:

| Variable               | Purpose                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `S3_ENDPOINT`          | Base endpoint, including `https://`, without a bucket name or path    |
| `S3_BUCKET`            | Existing bucket name                                                  |
| `S3_REGION`            | Signing region from the provider                                      |
| `S3_ACCESS_KEY_ID`     | Bucket access key                                                     |
| `S3_SECRET_ACCESS_KEY` | Bucket secret key                                                     |
| `S3_FORCE_PATH_STYLE`  | `true` for path-style URLs; defaults to `false` (virtual-hosted URLs) |

On Node, use environment variables or `.env`; Docker Compose forwards these variables. On Cloudflare, put endpoint, bucket, region, and URL style in Wrangler `vars`, and set the two credentials with `wrangler secret put S3_ACCESS_KEY_ID` and `wrangler secret put S3_SECRET_ACCESS_KEY`. For Wrangler development use `.dev.vars`. Partial configuration fails at startup.

**Railway Buckets:** add a bucket to your project and reference its Credentials values in the app service variables above. Use the supplied base endpoint and region; current buckets use `S3_FORCE_PATH_STYLE=false`. Older buckets may require `true`. See [Railway Buckets](https://docs.railway.com/storage-buckets).

**Cloudflare R2:** use `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, `S3_REGION=auto`, and `S3_FORCE_PATH_STYLE=true`, with S3 credentials scoped to read/write the bucket. Use the provider's jurisdiction-specific endpoint if applicable. This works from Railway, self-hosted Node, or the Worker. See [R2 S3 configuration](https://developers.cloudflare.com/r2/get-started/s3/).

Images stay behind the authenticated `/api/images/<id>` route. The browser never receives bucket credentials or accesses the bucket directly, so public access and bucket CORS are unnecessary. Object keys are `images/<uuid>`; use a dedicated bucket per installation. SQLite retains image metadata and object keys. Existing SQLite images continue to load after enabling S3; they are not moved automatically. Disabling S3 leaves bucket images unavailable until configuration is restored. When changing buckets, copy the objects with their existing keys first. Back up both the database and bucket. Failed database writes after an upload may leave an unreferenced object; automatic garbage collection is not implemented.

### Local bucket with Docker

```sh
docker compose -f compose.s3.yaml up -d
```

This starts persistent MinIO storage and creates `jot-images`. Uncomment the local S3 settings in `.env.example` in your `.env`, then restart `npm run dev`. The API is at `http://localhost:9000`; the console is at `http://localhost:9001` (login `jot-local` / `jot-local-secret`). These credentials and loopback-bound ports are for local development only.

To run the app and bucket together in Docker, use the same variables but set `S3_ENDPOINT=http://s3:9000`, then run:

```sh
docker compose -f compose.yaml -f compose.s3.yaml up --build -d
```

Wait for `s3-init` to finish before uploading. Data survives container restarts in named volumes. The optional bucket service is independent of the Caddy development proxy. With the bucket running, verify the S3 adapter with `JOT_TEST_S3=1 node --import tsx --test tests/images.test.ts`.

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
- Image blocks accept HTTP(S) URLs or PNG/JPEG/GIF/WebP uploads up to 5 MB. Uploads are authenticated and stored in SQLite chunks by default, or in a configured private S3-compatible bucket on either hosting target. Pasting an image also uploads it.
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
