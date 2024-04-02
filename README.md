# OpenStreetMap-TileServer-GL

Project for making OpenStreetMap vector tiles based on the [OpenMapTiles](https://github.com/openmaptiles/openmaptiles)
schema using [systemed/tilemaker](https://github.com/systemed/tilemaker) and also serving and rendering the generated
vector tiles using [maptiler/tileserver-gl](https://github.com/maptiler/tileserver-gl)

- [OpenMapTiles](#openmaptiles)
- [Tilemaker](#tilemaker)

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

## Tilemaker

Tilemaker creates vector tiles (in Mapbox Vector Tile format) from an .osm.pbf planet extract, as typically downloaded
from providers like [Geofabrik](https://download.geofabrik.de/).
It aims to be 'stack-free': you need no database and there is only one executable to install.

Vector tiles are used by many in-browser/app renderers, and can also power server-side raster rendering. They enable
on-the-fly style changes and greater interactivity, while imposing less of a storage burden.
Tilemaker can output them to individual files, or to .mbtiles or .pmtiles tile containers.

You can read more about this in [TILEMAKER.md](tilemaker/README.md).