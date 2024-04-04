# Tilemaker

- [Vector tiles](#vector-tiles)
- [Installing](#installing)
- [Out-of-the-box](#out-of-the-box)
- [Configuration](#configuration)
- [Running](#running)

## Vector tiles

Vector tiles are the modern way of rendering maps. [Read more](docs/4.VECTOR_TILES.md)

## Installing

Tilemaker is written in C++14. The dependencies are:

* Boost (latest version advised, 1.66 minimum)
* Lua (5.1 or later) or LuaJIT
* sqlite3
* shapelib
* rapidjson

Other third-party code is bundled in the include/ directory.

You can then simply install with:

    make
    sudo make install

The recommended method is to use docker:

    docker build . -t tilemaker

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
in it, such that tilemaker can find a file at `coastline/water_polygons.shx`.

_(If you want to include optional small-scale land-cover, create a `landcover` directory, and download the appropriate
10m files from 'Features' at https://www.naturalearthdata.com so that you
have 
[landcover/ne_10m_antarctic_ice_shelves_polys/ne_10m_antarctic_ice_shelves_polys.shp](https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-antarctic-ice-shelves/), 
[landcover/ne_10m_urban_areas/ne_10m_urban_areas.shp](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-urban-area/), 
[landcover/ne_10m_glaciated_areas/ne_10m_glaciated_areas.shp](https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-glaciated-areas/).)_

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

The recommended method is to use docker:

    docker run \
        -v ./osm/coastline/:/coastline \
        -v ./osm/landcover/:/landcover \
        -v ./osm/data/:/osm-data \
        -v ./osm/cache/:/osm-cache \
        -v ./osm/config/:/tilemaker-config \
        -it --rm stsdockerhub/tilemaker:1.0.2b68d2c \
        --input /osm-data/romania-latest.osm.pbf \ 
        --output /osm-data/romania-latest.mbtiles \
        --config /tilemaker-config/config-openmaptiles.json \
        --process /tilemaker-config/process-openmaptiles.lua \
        --store /osm-cache

The docker command assumes the existence of the following folder structure:

    // * required
    osm
        cache
        coastline
            water_polygons.cpg
            water_polygons.dbf
            water_polygons.prj
            water_polygons.shp
            *water_polygons.shx
        config
            *config-openmaptiles.json
            *process-openmaptiles.lua
        data
            *romania-latest.mbtiles
            *romania-latest.osm.pbf
        landcover
            ne_10m_urban_areas
                ne_10m_urban_areas.cpg
                ne_10m_urban_areas.dbf
                ne_10m_urban_areas.prj
                ne_10m_urban_areas.README.html
                *ne_10m_urban_areas.shp
                ne_10m_urban_areas.shx
                ne_10m_urban_areas.VERSION.txt

Read more about Tilemaker's runtime options in [RUNNING.md](docs/3.RUNNING.md).