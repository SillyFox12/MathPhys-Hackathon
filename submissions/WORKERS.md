# Cloudflare Workers + Static Assets

Run these commands from this `src` directory using Node 24 or newer. On Windows
PowerShell, use `npm.cmd` / `npx.cmd` if execution policy blocks the `.ps1` shims.

```sh
npm ci
npm run build
npm run worker:dev
```

Open **http://127.0.0.1:8787**. Wrangler builds the allowlisted assets and runs the
Worker locally on loopback. It requires no Google credentials or Cloudflare login.
`npm run preview` still runs the original Node offline preview on port 3000.

## Data and configuration

The Worker imports the production-owned offline tables from
`preview/illustrative.js` and the latest source-specific configuration from
`preview/game_profile.js`. Neither imports test fixtures. `/api/spreadsheet?tab=...`
returns the original two-dimensional cell array for exactly `Narrative & Choice Matrix`
or `Real-World Benchmarks`. `/api/game-configuration` returns the same browser-safe
configuration as the Node offline preview, including `applicationMode: "preview"`.
The existing preview notice remains visible.

This hackathon profile is illustrative game balance, not experimentally calibrated
detector performance. See `preview/PROFILE.md` for units, formulas and reference means.
The 30-day reference build (water, surface, 3-inch PMT, no shielding) has means:
player solar/atmospheric/astronomical/background **300/30/1/60**;
IceCube **0/300/5/20**; Super-K **500/50/0.2/15**.
Displayed integer counts are stored Poisson samples, so individual games vary.

Spreadsheet edits are **not live**. Update the production-owned offline snapshot
and profile as appropriate, rebuild, then redeploy. The Worker makes no Google API
calls and has no ADC, credentials, access tokens or runtime secret requirements.
The separate Node live mode and its authentication setup are unchanged.

## Packaging and routing

`scripts/build-worker.mjs` creates `dist/index.html` from the existing game entry
page and copies only the required `/development/...` and `/src/...` browser modules,
styles, four local fonts and their licenses, and the three recordings explicitly listed
in `development/audio_configuration.js`. `dist/` is generated and ignored.
It does not recursively copy the repository. Server/authentication code, snapshots,
tests, configuration files, credentials and `node_modules` are not static assets.
The offline tables/profile are bundled into the Worker; only their intended API
responses are public.

Wrangler runs the Worker before assets. Unknown `/api` routes always return JSON
404, including browser navigation requests. No SPA fallback is configured. The
Worker preserves asset content types and applies the Node preview's no-store,
nosniff and Content-Security-Policy headers to API and asset responses. APIs allow
GET only and reject foreign origins and arbitrary tab/range/ID queries.

## Verification

```sh
npm run test:integration
npm run worker:check
# With worker:dev running, and Playwright installed in the development environment:
node integration_tests/worker_browser_check.mjs
```

For an external Playwright installation, set `PLAYWRIGHT_MODULE_PATH` to its absolute
package directory. Optional `WORKER_ORIGIN` overrides `http://127.0.0.1:8787`.
The browser check completes the reference game, checks expected and stored counts,
fonts/modules, animation, Settings, resizing and restart. Playwright and tests are
development tools and are excluded from the upload.

Verified locally: Wrangler's workerd preview and deployment dry run; all 16 integration
checks; all 1,322 existing Node tests (run sequentially to avoid timing-test contention).
Desktop and mobile full-game checks passed against both the Worker and the unchanged
Node preview, including the reference means above, stored integer samples, all four
fonts, module loading, water animation pause/resume, Settings, resize and restart.
Missing API/navigation requests and private file paths returned 404 rather than HTML.
The generated static directory contains only 31 allowlisted public files, including audio.

Cloudflare references: [Static Assets binding and routing](https://developers.cloudflare.com/workers/static-assets/binding/)
and [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/).

## Deploy (owner action)

```sh
npx wrangler login
npm run worker:check
npm run worker:deploy
```

`worker:check` is a local dry run, not a publication. `worker:deploy` builds and uploads
the Worker and only `dist/` as Static Assets. The default name is `gotta-detect-em-all`;
change `name` in `wrangler.jsonc` if needed for your account. Wrangler reports the
deployed URL. No deployment is performed by this change.

The deployed game, both snapshot tabs and browser-safe game profile are available
to anyone who can reach the endpoint unless the owner adds access control such as
Cloudflare Access. Google spreadsheet permissions do not restrict these offline
API responses. Publish only data approved for the hackathon's audience.
