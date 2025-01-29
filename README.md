# OpenStreetMap-TileServer-GL

Project for making OpenStreetMap vector tiles based on the [OpenMapTiles](https://github.com/openmaptiles/openmaptiles)
schema.

We use tools that generate [Vector Tiles](https://github.com/mapbox/vector-tile-spec/tree/master/2.1) from geographic
data sources like [OpenStreetMap](https://www.openstreetmap.org/) or [Geofabrik](https://download.geofabrik.de/).

- [Planetiler](https://github.com/onthegomap/planetiler) aims to be fast and memory-efficient so that you can build a
  map of the world in a few hours on a single machine without any external tools or database.

For serving and rendering the generated vector tiles we use [maptiler/tileserver-gl](https://github.com/maptiler/tileserver-gl)

- [OpenMapTiles](#openmaptiles)
- [Planetiler](#planetiler)
- [TilseServer-GL](#tileserver-gl)

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

## TileServer GL

Vector and raster maps with GL styles. Server-side rendering by MapLibre GL Native. Map tile server for MapLibre GL JS,
Android, iOS, Leaflet, OpenLayers, GIS via WMTS, etc.

You can read more about this in [TileServer GL.md](tileserver-gl/README.md)