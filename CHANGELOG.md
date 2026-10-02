# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

- **The fork's own version** is plain [semver](https://semver.org/), kept in `tileserver-gl/package.json` `version`. It tags
  the Docker images: `stsdockerhub/tileserver-gl:<version>`, `<version>-light` and `<version>-light-s3`, and the server
  reports it at startup and with `--version`. MAJOR for a breaking change to configuration, URLs or behaviour clients
  rely on; MINOR for a feature; PATCH for fixes only.
- **The upstream base** is the [tileserver-gl](https://github.com/maptiler/tileserver-gl) release the code is built on,
  kept in `package.json` `upstreamVersion` and in each image's `tileserver-gl.upstream.version` label. Every release below
  starts with an `Upstream:` line naming it, followed by what was pulled from upstream since the previous release, or
  "nothing new".

To release: move the `Unreleased` entries under a new version heading with its `Upstream:` line, set `version` with
`npm version <x.y.z> --no-git-tag-version` in `tileserver-gl/` (and `upstreamVersion` if upstream was merged), run
`npm run version:sync`, commit, tag `v<x.y.z>`, then `PUSH=1 npm run images:build`. `npm test` fails while the version,
this file and the compose files disagree.

## [Unreleased]

## [1.0.0] - 2026-10-02

Upstream: tileserver-gl 5.7.0-pre.1. 5.7.0-pre.0 was vendored on 2026-08-04 (commit 401c968), replacing the earlier
5.1.3 base (2025-01-29), and the 5.7.0-pre.1 changes (upstream release of 2026-08-31) were ported on 2026-09-30.
Pulled from 5.7.0-pre.1:

- opt-in Prometheus metrics endpoint (#2211); the data decorator may be async (#2352), and runs on Windows and for
  PMTiles style sources (#2351)
- fixes: renderer requests and pool slots are always settled (#2347); 512 px static map overlays align (#2344);
  the format-based sparse default is restored and an archive's own `sparse` metadata is honoured (#2348, #2350);
  stale tile-source state is cleaned on `SIGHUP` reload (#2158); `public_url` in the WMTS endpoint (#2205); a style
  source given as a string no longer throws (#2179); native install scripts are allowed under npm 12 so canvas builds
  (#2343)

This is the first versioned release of the fork; before it, the images were tagged with the upstream version.

### Added

- Stateless S3 deployment: PMTiles read from S3 or an S3-compatible store with SigV4 credentials, a `-light-s3` image
  with config, styles and fonts baked in, and `${VAR}` / `${VAR:-default}` substitution in `config.json`. A required
  variable that is unset stops startup by name.
- Optional API-key and expiring HMAC-token gate (`TILESERVER_GL_API_KEYS`, `TILESERVER_GL_TOKEN_SECRET`), with an
  `Origin`/`Referer` allowlist for hotlink deterrence.
- `Cache-Control` headers per response category, configurable through `cacheControl`.
- S3 connection pool and timeouts configurable by environment (`TILESERVER_GL_S3_*`).
- Static-map overlay limits: `maxStaticMarkers`, `maxStaticPaths`, `maxStaticPathPoints`.
- MapTiler style pairs and survey-optimised street styles (light and dark), with a viewer theme switch.
- k6 load testing: a closed-model smoke test, an open-model capacity mode, many keys and per-user tokens, conditional
  revalidation traffic, a fault run that pauses storage and reloads the server, and an S3 socket-sizing procedure.
- Versioned Docker images built by `npm run images:build`, labelled with version, git commit, build date and upstream
  base; this changelog.

### Changed

- The viewer runs MapLibre GL JS 6, bundled with esbuild; right-to-left text needs no plugin.
- Glyphs and sprites are cached for an hour, like the `style.json` that references them, instead of a year as
  `immutable`.
- `serveAllStyles` reads the styles folder at startup only; a `SIGHUP` reload or restart picks up changes. The file
  watcher and the chokidar dependency are gone.
- Dependencies updated to current releases; the Docker images are slimmer and fail their build when a native module
  would be missing.
- The dev stacks publish their ports on `127.0.0.1` only, and their credentials can be overridden from the environment.

### Fixed

- **Storage:** a stalled S3 read fails at the request timeout instead of hanging; a tile the archive fails to read is
  answered 502/503/504 with `no-store`, not as an empty tile; clearing the PMTiles cache on reload closes S3 clients.
- **Startup and reload:** requests before startup completes get `503 Starting`, not 404; `options.allowedHosts` in a
  `--config` file is honoured.
- **Caching:** a response under an expiring token is never fresh beyond the token's expiry; `If-None-Match` takes
  precedence over `If-Modified-Since`, and 304 responses carry the right headers.
- **Rendering (full image):** a renderer whose tile read failed is replaced instead of reused in a stuck state; reload
  stops each style's metrics timer.
- **Viewer:** a browser that cannot start MapLibre gets the raster map or a message instead of a blank page; the raster
  view opens on the style's area when the URL has no position.
- **Metrics:** font metrics are labelled by known font instead of the requested stack; renderer pool gauges report real
  counts.
- `gen-token.js` only prints tokens the server accepts.

### Security

- API keys and tokens are redacted from the request log, however the parameter name is encoded and in the `Referer`;
  viewer pages send `Referrer-Policy: strict-origin`; the nginx example and the dev load balancer log no query string or
  `Referer`.
- Static-map requests are capped by marker, path and coordinate count before anything is drawn.
