# OpenStreetMap-TileServer-GL

Self-hosted OpenStreetMap vector tiles, based on the
[OpenMapTiles](https://github.com/openmaptiles/openmaptiles) schema.

The pipeline has two halves:

1. **Generate** [Vector Tiles](https://github.com/mapbox/vector-tile-spec/tree/master/2.1) from
   [OpenStreetMap](https://www.openstreetmap.org/) / [Geofabrik](https://download.geofabrik.de/) extracts with
   [Planetiler](https://github.com/onthegomap/planetiler) — fast and memory-efficient enough to build a map of
   the world in a few hours on a single machine, with no external tools or database.
2. **Serve and render** those tiles with [tileserver-gl](https://github.com/maptiler/tileserver-gl), whose
   sources are vendored in this repository.

## Repository layout

| Path                | Contents                                                                                              |
|---------------------|-------------------------------------------------------------------------------------------------------|
| `tileserver-gl/`    | Vendored tileserver-gl sources (v5.7.0-pre.0) plus the Docker builds for the full and light images.     |
| `tileserver-gl-dev/`| A ready-to-run local environment: `compose.yml` and a `data/` directory with styles, fonts and config. |

- [OpenMapTiles](#openmaptiles)
- [Planetiler](#planetiler)
- [TileServer GL](#tileserver-gl)
- [Running locally](#running-locally)

## OpenMapTiles

OpenMapTiles is an extensible and open tile schema based on the OpenStreetMap.
This project is used to generate vector tiles for online zoom-able maps.
OpenMapTiles is about creating beautiful base-maps with general layers containing topographic information.

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

Planetiler generates the OpenMapTiles-schema `.mbtiles` (or `.pmtiles`) archive that this server consumes. It
runs as a single Java process, so nothing needs to be installed besides Docker:

```bash
# a small extract, downloaded automatically
docker run -e JAVA_TOOL_OPTIONS="-Xmx1g" -v "$(pwd)/data":/data \
  ghcr.io/onthegomap/planetiler:latest --download --area=monaco

# a country extract from Geofabrik
docker run -e JAVA_TOOL_OPTIONS="-Xmx8g" -v "$(pwd)/data":/data \
  ghcr.io/onthegomap/planetiler:latest --download --area=romania --output=/data/romania.mbtiles
```

Memory and disk requirements scale with the area; the whole planet needs a machine with a lot of both. See the
[Planetiler documentation](https://github.com/onthegomap/planetiler/blob/main/PLANETILER.md) for the full
option list and hardware guidance.

Copy the resulting archive into `tileserver-gl-dev/data/mbtiles/` to serve it.

## TileServer GL

Vector and raster maps with GL styles. Server-side rendering by MapLibre GL Native. Map tile server for
MapLibre GL JS, Android, iOS, Leaflet, OpenLayers, GIS via WMTS, etc.

The sources live in [`tileserver-gl/`](tileserver-gl/README.md) and build into two images:

* `stsdockerhub/tileserver-gl` — full build, renders raster tiles, static map images and elevation queries.
* `stsdockerhub/tileserver-gl-light` — vector tiles, styles, fonts and sprites only; much smaller, no GL stack.

```bash
cd tileserver-gl
docker build . -t stsdockerhub/tileserver-gl:5.7.0-pre.0
docker build -f Dockerfile_light . -t stsdockerhub/tileserver-gl-light:5.7.0-pre.0
```

Documentation: [Install](tileserver-gl/docs/1.INSTALL.md) ·
[Usage and endpoints](tileserver-gl/docs/2.USAGE.md) ·
[Configuration](tileserver-gl/docs/3.CONFIG.md) ·
[Deployment](tileserver-gl/docs/4.DEPLOYMENT.md)

## Running locally

`tileserver-gl-dev/` holds a compose file and a `/data` volume with everything except the tiles themselves.

```bash
cd tileserver-gl-dev
# drop your generated archive here first:
#   data/mbtiles/<your>.mbtiles
docker compose up
```

The map is then served at <http://localhost:8081/>.

What is in `tileserver-gl-dev/data/`:

* `config.json` — serves six styles and declares one data source. `serveAllFonts` is on.
* `styles/` — `openstreetmap`, `osm-openmaptiles`, `osm-openmaptiles-dark`, `osm-liberty`, `streets`,
  `streets-v2`, `streets-v3`, each with its own sprite sheet. `osm-openmaptiles` is the MapTiler
  OpenStreetMap style localized to this server: tiles from the configured data source, glyphs from
  `data/fonts/`, sprites from the style folder, and no API key.
Both `osm-openmaptiles` and `osm-openmaptiles-dark` are MapTiler styles localized the same way — tiles from
the configured data source, glyphs from `data/fonts/`, sprites from the style folder. The dark one carries
its **own** sprite sheet (MapTiler ships a separate one whose icons are drawn for dark backgrounds), so its
POI and peak icons stay legible.

Style edits are picked up without a restart:

```bash
docker compose kill -s HUP tileserver-gl
```

## Light/dark theme switch

The style viewer (`/styles/<id>/`) shows a ☾/☀ button when both `<id>` and `<id>-dark` are served. Pairing
is purely by name, so any style gets the toggle as soon as a `-dark` sibling exists in `config.json` — no
server-side configuration.

Switching calls `map.setStyle()`, so the camera is preserved, and rewrites the address bar to the style
actually on screen (hash included).

Nothing is persisted: **the URL is the state**. Each tab therefore keeps its own theme — you can watch the
same place in light and dark side by side — a reload stays on whatever that tab was showing, and the link
you copy is the map you were looking at.

The template ships inside the image, so changing it needs a rebuild:

```bash
docker build tileserver-gl -t stsdockerhub/tileserver-gl:5.7.0-pre.0
docker compose -f tileserver-gl-dev/compose.yml up -d --force-recreate
```
* `fonts/` — 28 glyph sets (Noto Sans, Open Sans, Roboto and variants).
* `mbtiles/` — where the generated tile archive goes (the archives themselves are gitignored).
* `pmtiles/` — must exist because `config.json` declares `paths.pmtiles`, even when unused. Every configured
  path is checked at startup and a missing one aborts with
  `The specified path for "pmtiles" does not exist`.

Every style references its tiles as `mbtiles://{planet-planetiler}`, and `config.json` maps that name onto a
real data source:

```json
  "styles": {
    "openstreetmap": {
      "style": "openstreetmap/style.json",
      "mapping": { "planet-planetiler": "romania-tilemaker" }
    }
  },
  "data": {
    "romania-tilemaker": { "mbtiles": "romania-latest.tilemaker.mbtiles" }
  }
```

So the styles need no editing when the tile set changes — point the `data` entry at your own file (and update
the `mapping` targets if you rename the data id). The default expects
`data/mbtiles/romania-latest.tilemaker.mbtiles`; startup fails if the configured file is missing, unless the
server is started with `--ignore-missing-files`.

The compose file runs the **light** image, so `http://localhost:8081/styles/<id>/{z}/{x}/{y}.png` and the
static-map endpoints are not available there. Switch the `image:` line to `stsdockerhub/tileserver-gl` if you
need server-side rendering.
