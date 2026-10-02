# OpenStreetMap-TileServer-GL

Self-hosted OpenStreetMap vector tiles, based on the
[OpenMapTiles](https://github.com/openmaptiles/openmaptiles) schema.

The pipeline has two halves:

1. **Generate** [Vector Tiles](https://github.com/mapbox/vector-tile-spec/tree/master/2.1) from
   [OpenStreetMap](https://www.openstreetmap.org/) / [Geofabrik](https://download.geofabrik.de/) extracts with
   [Planetiler](https://github.com/onthegomap/planetiler) — fast and memory-efficient enough to build a map of the world
   in a few hours on a single machine, with no external tools or database.
2. **Serve and render** those tiles with [tileserver-gl](https://github.com/maptiler/tileserver-gl), whose sources are
   vendored in this repository.

## Repository layout

| Path                  | Contents                                                                                                                                                                                                |
|-----------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `tileserver-gl/`      | Vendored tileserver-gl sources (upstream base in [CHANGELOG.md](CHANGELOG.md)) and three Docker builds: `Dockerfile` (full), `Dockerfile_light` (vector-only), `Dockerfile_light_s3` (light + baked assets for stateless S3 deployment). |
| `tileserver-gl-data/` | Portable map assets — `config.json`, `styles/`, `fonts/` — mounted by the dev compose and baked into the S3 image.                                                                                      |
| `tileserver-gl-dev/`  | Ready-to-run local environments: `compose.yml` (local mbtiles), `compose.perf.yml` (local mbtiles from a named volume, for load tests), `compose.s3.yml` (S3/MinIO), `compose.scale.yml` + `nginx-lb.conf` (replicas behind a load balancer); `k6/` (load and fault tests), `gen-token.js` (access tokens), and `data/` holding the tile databases. |
| `.github/workflows/`  | CI: builds the light and light-s3 images for amd64 and arm64, and publishes them to Docker Hub on a version tag.                                                                                        |
| `CHANGELOG.md`        | Release notes, versioning, and the upstream tileserver-gl version each release is based on.                                                                                                            |

- [OpenMapTiles](#openmaptiles)
- [Planetiler](#planetiler)
- [TileServer GL](#tileserver-gl)
- [Environment variables](#environment-variables)
- [Running locally](#running-locally)
- [Performance](#performance)
- [Light/dark theme switch](#lightdark-theme-switch)
- [Changelog](CHANGELOG.md)

## OpenMapTiles

OpenMapTiles is an extensible and open tile schema based on the OpenStreetMap. This project is used to generate vector
tiles for online zoom-able maps. OpenMapTiles is about creating beautiful base-maps with general layers containing
topographic information.

Please keep in mind that OpenMapTiles schema should display general topographic content. If creating a new layer or
expanding an existing layer with a specific theme, please create a fork and invite other community members to cooperate
on your topic. OpenMapTiles schema is used in many projects all over the world and the size of the final vector tiles
needs to be considered in any update.

- :link: Schema https://openmaptiles.org/schema
- :link: Docs https://openmaptiles.org/docs
- :link: Data for download: https://www.maptiler.com/data/
- :link: Hosting https://www.maptiler.com/cloud/
- :link: Create own layer https://github.com/openmaptiles/openmaptiles-skiing
- :link: Practical usage of OpenMapTiles https://github.com/maptiler/foss4g-workshop
- :link: Discuss at the #openmaptiles channel at [OSM Slack](https://slack.openstreetmap.us/)

## Planetiler

Planetiler generates the OpenMapTiles-schema `.mbtiles` (or `.pmtiles`) archive that this server consumes. It runs as a
single Java process, so nothing needs to be installed besides Docker:

```bash
# a small extract, downloaded automatically
docker run -e JAVA_TOOL_OPTIONS="-Xmx1g" -v "$(pwd)/data":/data \
  ghcr.io/onthegomap/planetiler:latest --download --area=monaco

# a country extract from Geofabrik
docker run -e JAVA_TOOL_OPTIONS="-Xmx8g" -v "$(pwd)/data":/data \
  ghcr.io/onthegomap/planetiler:latest --download --area=romania --output=/data/romania.mbtiles
```

Memory and disk requirements scale with the area; the whole planet needs a machine with a lot of both. See the
[Planetiler documentation](https://github.com/onthegomap/planetiler/blob/main/PLANETILER.md) for the full option list
and hardware guidance.

Copy the resulting archive into `tileserver-gl-dev/data/mbtiles/` to serve it.

## TileServer GL

Vector and raster maps with GL styles. Server-side rendering by MapLibre GL Native. Map tile server for MapLibre GL JS,
Android, iOS, Leaflet, OpenLayers, GIS via WMTS, etc.

The sources live in [`tileserver-gl/`](tileserver-gl/README.md) and build into three images:

* `stsdockerhub/tileserver-gl:<ver>` — full build (`Dockerfile`): renders raster tiles, static map images and elevation
  queries.
* `stsdockerhub/tileserver-gl:<ver>-light` — vector tiles, styles, fonts and sprites only (`Dockerfile_light`); much
  smaller, no GL stack.
* `stsdockerhub/tileserver-gl:<ver>-light-s3` — the **same** light image, with this deployment's `config.json`,`styles/`
  and `fonts/` baked in from `tileserver-gl-data/` (`Dockerfile_light_s3`); a stateless container that reads tiles from
  S3. Same repository as the light image — the `-s3` tag suffix distinguishes the baked variant.

`<ver>` is the fork's own version, kept in `tileserver-gl/package.json` and described release by release in
[CHANGELOG.md](CHANGELOG.md), which also records the upstream tileserver-gl version each release is based on.

Releases are published by GitHub Actions: pushing the tag `v<version>` builds the light and light-s3 images for
amd64 and arm64 and pushes them to Docker Hub as `<version>-light` and `<version>-light-s3`
([workflow](.github/workflows/docker-images.yml); it needs the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository
secrets). To build locally instead, for your own architecture, tagged with the same version:

```bash
cd tileserver-gl
npm run images:build                      # all three; or: npm run images:build -- light light-s3
PUSH=1 npm run images:build               # build and push, bypassing CI
```

The S3 image is built on the light image of the same version, from `../tileserver-gl-data`. Each image is labelled with
its version, git commit, build date and upstream base: `docker inspect -f '{{json .Config.Labels}}' <image>`. The dev
compose files run the current version by default; set `TILESERVER_VERSION` to run another.

Documentation: [Install](tileserver-gl/docs/1.INSTALL.md) ·
[Usage and endpoints](tileserver-gl/docs/2.USAGE.md) ·
[Configuration](tileserver-gl/docs/3.CONFIG.md) ·
[Deployment](tileserver-gl/docs/4.DEPLOYMENT.md)

### Serving tiles from S3 / object storage

A data source can point at object storage instead of a local file, so the container carries no tile data:

```json
"data": {
  "planet": {
    "pmtiles": "s3+https://minio.example.com/tiles/planet.pmtiles",
    "s3Region": "us-east-1"
  }
}
```

Schemes: `s3://…` (AWS S3), `s3+https://…` / `s3+http://…` (self-hosted MinIO, Ceph, R2, …), or plain
`https://…` (range reads, no auth). Private buckets are read with credentials from the standard AWS chain —
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, a mounted `~/.aws` profile via `s3Profile`, or an IAM role — never inline
in `config.json`, so the bucket never has to be public.

Any string in `config.json` may reference the environment as `${VAR}` or `${VAR:-default}` (shell-style: the default
applies when the variable is unset or empty). So a single **baked** config retargets per deployment without a rebuild —
the S3 config uses `"pmtiles": "${PMTILES_URL}"`, and you set `PMTILES_URL` (compose env, k8s env) to your bucket.
It has no default, so a container started without it exits at startup naming the missing variable.
[`tileserver-gl-dev/compose.s3.yml`](tileserver-gl-dev/compose.s3.yml) runs the baked
`stsdockerhub/tileserver-gl:<ver>-light-s3` image against a local MinIO (private bucket, SigV4) end to end.

## Environment variables

All optional. Secrets (API keys, token secret, AWS credentials) come from the environment and are **never**
read from `config.json`; non-secret config values can be parameterized with `${VAR}` / `${VAR:-default}`
([details](tileserver-gl/docs/3.CONFIG.md#environment-variable-substitution)). Full descriptions:
[USAGE.md](tileserver-gl/docs/2.USAGE.md#environment-variables).

| Group                              | Variables                                                                                                                                             |
|------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Server**                         | `PORT`, `BIND`, `PUBLIC_URL` (public base URL), `NODE_ENV`, `UV_THREADPOOL_SIZE`                                                                      |
| **Auth / security**                | `TILESERVER_GL_API_KEYS`, `TILESERVER_GL_TOKEN_SECRET`, `TILESERVER_GL_TOKEN_MAX_TTL`, `TILESERVER_GL_ALLOWED_ORIGINS`, `TILESERVER_GL_ALLOWED_HOSTS` |
| **Metrics**                        | `TILESERVER_GL_METRICS`, `TILESERVER_GL_METRICS_ZOOM`, `METRICS_PORT`                                                                                 |
| **S3 (PMTiles)**                   | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`, `AWS_PROFILE`                                                        |
| **S3 client tuning**               | `TILESERVER_GL_S3_MAX_SOCKETS`, `TILESERVER_GL_S3_KEEP_ALIVE`, `TILESERVER_GL_S3_CONNECTION_TIMEOUT_MS`, `TILESERVER_GL_S3_REQUEST_TIMEOUT_MS`        |
| **Config `${VAR}` (this project)** | `PMTILES_URL`, `TILE_CACHE_CONTROL` — author-chosen names used by the baked S3 config                                                                 |
| **Dev compose files**              | `TILESERVER_VERSION` (image version to run, default the current one); `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `TILESERVER_GL_API_KEYS`, `TILESERVER_GL_TOKEN_SECRET` override the S3 stacks' dev credentials |

## Running locally

`tileserver-gl-dev/` holds the compose files and a `data/` directory with `config.json` and the tile databases; the
styles and fonts come from `../tileserver-gl-data`.

```bash
cd tileserver-gl-dev
# drop your generated archive here first:
#   data/mbtiles/<your>.mbtiles
docker compose up
```

The map is then served at <http://localhost:8081/>.

The assets are split across two folders.

`tileserver-gl-data/` — portable map assets (mounted into `/data` by the dev compose, baked into the S3 image):

* `styles/` — `osm-openmaptiles`, `streets-v2`, `basic-v2` and `streets-v2-survey` (a survey-optimised streets style),
  and a `-dark` sibling of each, every one with its own sprite sheet. They are MapTiler styles localized to this server:
  tiles from the configured data source, glyphs from `fonts/`, sprites from the style folder, and no API key. Each
  `-dark` variant carries its **own** sprite sheet (MapTiler ships a separate one drawn for dark backgrounds) so POI and
  peak icons stay legible. The S3 image serves all eight; the dev config serves the first three pairs.
* `fonts/` — 14 glyph sets (Noto Sans, Open Sans and variants).
* `config.json` — the configuration baked into the S3 image; it points a data source at the object store. The local dev
  stack uses its own config under `tileserver-gl-dev/data/` instead.

`tileserver-gl-dev/data/` — local, machine-specific data:

* `config.json` — the dev configuration; maps the styles onto a local mbtiles source. `serveAllFonts` is on.
* `mbtiles/` — where the generated tile archive goes (the archives themselves are gitignored).
* `pmtiles/` — must exist because `config.json` declares `paths.pmtiles`, even when unused; every configured path is
  checked at startup and a missing one aborts with `The specified path for "pmtiles" does not exist`.

Style edits are picked up without a restart:

```bash
docker compose kill -s HUP tileserver-gl
```

Every style references its tiles as `mbtiles://{planet-planetiler}`, and the dev `config.json` maps that name onto a real
data source:

```json
"styles": {
  "osm-openmaptiles": {
    "style": "osm-openmaptiles/style.json",
    "mapping": {
      "planet-planetiler": "planet-tilemaker"
    }
  }
},
"data": {
  "planet-tilemaker": {
    "mbtiles": "planet-latest.tilemaker.mbtiles"
  }
}
```

So the styles need no editing when the tile set changes — point the `data` entry at your own file (and update the
`mapping` targets if you rename the data id). The default expects `data/mbtiles/planet-latest.tilemaker.mbtiles`; to
serve a smaller extract under that name, link it (`ln -s romania-latest.tilemaker.mbtiles
planet-latest.tilemaker.mbtiles` in `data/mbtiles/`). Startup fails if the configured file is missing, unless the server
is started with `--ignore-missing-files`.

The compose file runs the **light** image, so `http://localhost:8081/styles/<id>/{z}/{x}/{y}.png` and the static-map
endpoints are not available there. For server-side rendering, drop the `-light` suffix from the `image:` line to run the
full image of the same version.

## Performance

Rough numbers from the `compose.s3.yml` stack (light image, tiles read from MinIO over the S3 path; Romania tileset,
zoom 8–14; closed-model k6 with one key, **0 errors** throughout), on two machines:

| setup                            | Windows, 32 cores, k6 in-network | M1 Max, Docker VM 8 CPUs, k6 on the host |
|----------------------------------|----------------------------------|------------------------------------------|
| 1 container, 50 VUs              | ~640 req/s, p95 632 ms           | ~1,270 req/s, p95 354 ms                 |
| 1 container, 200 VUs (saturated) | ~610 req/s, p95 2.7 s            | ~1,270 req/s, p95 1.47 s                 |
| **4 replicas + LB, 200 VUs**     | **~1,275 req/s, p95 745 ms**     | ~1,140 req/s, p95 769 ms                 |

Capacity, with arrivals at a fixed rate instead (open model, M1 Max): one container holds a vector-tile p95 under
200 ms up to **~200 iterations/s, about 740 req/s**; at 250 it is 272 ms and climbing.

A single light container saturates by ~50 concurrent users and degrades by adding latency, not errors. It's stateless,
so scaling out is the answer: on the Windows host four replicas behind an LB roughly doubled throughput and cut p95
~3.6× on the same load. On one box the shared MinIO/LB/client cap it near 2×, and on the Mac, measured through Docker
Desktop's host port forward, four replicas gave no gain at all; scaling comparisons need k6 in-network. In production a
real object store, a managed LB, and — the big multiplier — **a CDN in front** (the tile `Cache-Control` headers are
already set for it) lift it much further. Method, full tables, the macOS port-forward caveat and the load script:
[`tileserver-gl-dev/k6/README.md`](tileserver-gl-dev/k6/README.md).

## Light/dark theme switch

The style viewer (`/styles/<id>/`) shows a ☾/☀ button when both `<id>` and `<id>-dark` are served. Pairing is purely by
name, so any style gets the toggle as soon as a `-dark` sibling exists in `config.json` — no server-side configuration.

Switching calls `map.setStyle()`, so the camera is preserved, and rewrites the address bar to the style actually on
screen (hash included).

Nothing is persisted: **the URL is the state**. Each tab therefore keeps its own theme — you can watch the same place in
light and dark side by side — a reload stays on whatever that tab was showing, and the link you copy is the map you were
looking at.

The template ships inside the image, so changing it needs a rebuild. The build tags the current version, which is what
the dev compose file runs:

```bash
(cd tileserver-gl && npm run images:build -- light)
docker compose -f tileserver-gl-dev/compose.yml up -d --force-recreate
```
