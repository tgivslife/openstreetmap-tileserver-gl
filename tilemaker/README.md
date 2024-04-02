# Tilemaker

- [Vector tiles](#vector-tiles)
- [Installing](#installing)
- [Out-of-the-box](#out-of-the-box)
- [Configuration](#configuration)
- [Running](#running)

## Vector tiles

Vector tiles are the modern way of rendering maps. [Read more](docs/4.VECTOR_TILES.md)

## Installing

Tilemaker is written in C++14. The chief dependencies are:

* Boost (latest version advised, 1.66 minimum)
* Lua (5.1 or later) or LuaJIT
* sqlite3
* shapelib
* rapidjson

Other third-party code is bundled in the include/ directory.

You can then simply install with:

    make
    sudo make install

For detailed installation instructions for your operating system, see [INSTALL.md](docs/1.INSTALL.md).

## Out-of-the-box

Tilemaker comes with configuration files compatible with the popular [OpenMapTiles](https://openmaptiles.org) schema,
and a demonstration map server.
You'll run Tilemaker to make vector tiles from your `.osm.pbf` source data.
To create the tiles, run this from the tilemaker directory:

    tilemaker /path/to/your/input.osm.pbf /path/to/your/output.mbtiles

Tilemaker keeps everything in RAM by default.
To process large areas without running out of memory, tell it to use temporary storage on SSD:

    tilemaker /path/to/your/input.osm.pbf /path/to/your/output.mbtiles --store /path/to/your/ssd

To include sea tiles, create a directory called `coastline` in the same place you're running tilemaker from, and then
save the files from [osmdata.openstreetmap.de](https://osmdata.openstreetmap.de/download/water-polygons-split-4326.zip)
in it, such that tilemaker can find a file at `coastline/water_polygons.shp`.

_(If you want to include optional small-scale land-cover, create a `landcover` directory, and download the appropriate
10m files from 'Features' at https://www.naturalearthdata.com so that you
have [landcover/ne_10m_antarctic_ice_shelves_polys/ne_10m_antarctic_ice_shelves_polys.shp](https://www.naturalearthdata.com/http//www.naturalearthdata.com/download/10m/physical/ne_10m_antarctic_ice_shelves_polys.zip), [landcover/ne_10m_urban_areas/ne_10m_urban_areas.shp](https://www.naturalearthdata.com/http//www.naturalearthdata.com/download/10m/cultural/ne_10m_urban_areas.zip), [landcover/ne_10m_glaciated_areas/ne_10m_glaciated_areas.shp](https://www.naturalearthdata.com/http//www.naturalearthdata.com/download/10m/physical/ne_10m_glaciated_areas.zip).)_

Then, to serve your tiles using the demonstration server:

    cd server
	tilemaker-server /path/to/your/output.mbtiles

You can now navigate to http://localhost:8080/ and see your map!

## Configuration

Vector tiles contain (generally thematic) 'layers'. For example, your tiles might contain river, cycleway and railway
layers.
It's up to you what OSM data goes into each layer. You configure this in Tilemaker with two files:

* a JSON file listing each layer, and the zoom levels at which to apply it
* a Lua program that looks at each node/way's tags, and places it into layers accordingly

You can read more about these in [CONFIGURATION.md](docs/2.CONFIGURATION.md).

The JSON configuration and Lua processing files are specified with `--config` and `--process` respectively.
Defaults are `config.json` and `process.lua` in the current directory.
If there is no `config.json` and `process.lua` in the current directory, and you do not specify `--config`
and `--process`, an error will result.

## Running

Read about tilemaker's runtime options in [RUNNING.md](docs/3.RUNNING.md).