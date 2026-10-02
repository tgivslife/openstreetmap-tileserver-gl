# TileServer GL

Vector and raster maps with GL styles. Server-side rendering by MapLibre GL Native. Map tile server for MapLibre GL JS,
Android, iOS, Leaflet, OpenLayers, GIS via WMTS, etc.

This is the vendored copy of [maptiler/tileserver-gl](https://github.com/maptiler/tileserver-gl) used by this project.
It has its own version (`version` in `package.json`); the upstream release it is based on is `upstreamVersion`, and the
[changelog](../CHANGELOG.md) records both, release by release.

Download vector tiles from [OpenMapTiles](https://data.maptiler.com/downloads/planet/), or generate your own
with [Planetiler](https://github.com/onthegomap/planetiler).

## What it serves

* **Vector tiles** from MBTiles and PMTiles (local, http (s) or S3-hosted PMTiles)
* **Styles** — MapLibre style JSON with sources, sprites and glyphs rewritten to this server
* **Rendered raster tiles** (`png` / `jpg` / `webp`, 256 or 512 px, up to `@3x`) via MapLibre GL Native
* **Static map images** — by center+zoom, bounding box, or auto-fitted to the overlays, with paths and markers
* **Fonts** (glyph ranges, including merged font stacks) and **sprites** (`@2x`, `@3x`)
* **Terrain** — preview and elevation lookup for `mapbox`/`terrarium` encoded sources
* **WMTS** capabilities, a MapLibre viewer and a Leaflet viewer
* **Operational endpoints** — `/health` and an opt-in Prometheus metrics server

Two builds exist. The full image renders raster output; the **light** build (`Dockerfile_light`, package name
`tileserver-gl-light`) drops MapLibre GL Native, sharp and canvas and therefore serves vector tiles, styles, fonts and
sprites only — no rendered tiles, no static maps, no elevation.

## Installation

The recommended method is to use docker:

    docker build -f Dockerfile . -t stsdockerhub/tileserver-gl:<ver>
    docker build -f Dockerfile_light . -t stsdockerhub/tileserver-gl:<ver>-light

For further details see [INSTALL.md](docs/1.INSTALL.md).

## Usage

    docker run --rm -it -v $(pwd):/data -p 8080:8080 stsdockerhub/tileserver-gl:<ver> --config /data/config.json

For CLI options and the full endpoint reference see [USAGE.md](docs/2.USAGE.md).

## Environment variables

All optional; grouped below, with full descriptions in
[USAGE.md](docs/2.USAGE.md#environment-variables).

| Group               | Variables                                                                                                                                             |
|---------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Server**          | `PORT`, `BIND`, `PUBLIC_URL`, `NODE_ENV`, `UV_THREADPOOL_SIZE`                                                                                        |
| **Auth / security** | `TILESERVER_GL_API_KEYS`, `TILESERVER_GL_TOKEN_SECRET`, `TILESERVER_GL_TOKEN_MAX_TTL`, `TILESERVER_GL_ALLOWED_ORIGINS`, `TILESERVER_GL_ALLOWED_HOSTS` |
| **Metrics**         | `TILESERVER_GL_METRICS`, `TILESERVER_GL_METRICS_ZOOM`, `METRICS_PORT`                                                                                 |
| **S3 (PMTiles)**    | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_PROFILE`                                                        |

Secrets (API keys, token secret, AWS credentials) are read from the environment, never from `config.json`. Non-secret
config values can be parameterized in `config.json` with `${VAR}` / `${VAR:-default}` — see
[CONFIG.md](docs/3.CONFIG.md#environment-variable-substitution).

## Configuration file

For further details see [CONFIGURATION.md](docs/3.CONFIG.md).

## Deployment

Reverse proxy, caching, forwarded headers, monitoring and tuning: [DEPLOYMENT.md](docs/4.DEPLOYMENT.md).

## Layout

| Path                                               | Contents                                                                         |
|----------------------------------------------------|----------------------------------------------------------------------------------|
| `src/main.js`                                      | CLI entry point, config discovery and auto-configuration                         |
| `src/server.js`                                    | Express app, route wiring, front page, `/health`, SIGHUP reload                  |
| `src/serve_data.js`                                | `/data/*` — raw tiles, TileJSON, elevation API                                   |
| `src/serve_style.js`                               | `/styles/*/style.json` and sprites                                               |
| `src/serve_rendered.js`                            | Rendered tiles and static maps (replaced by `serve_light.js` in the light build) |
| `src/serve_font.js`                                | `/fonts/*`                                                                       |
| `src/metrics.js`                                   | Prometheus registry and metric definitions                                       |
| `src/pmtiles_adapter.js`, `src/mbtiles_wrapper.js` | Tile source backends, incl. S3 for PMTiles                                       |
| `public/`                                          | Viewer templates and browser bundles (populated by `npm run prepare`)            |
| `test/`                                            | Mocha suite, including static-image regression fixtures                          |
