# k6 load test

`tiles-load.js` drives the tileserver container: a browsing mix of vector-tile viewports (the dominant load) plus
occasional style / glyph / sprite fetches, with valid tile coordinates sampled inside the tileset bounds. Requests are
tagged so the summary breaks p95/p99 down per endpoint.

## Run

k6 on the host (`C:\Program Files\k6\k6.exe` on this machine):

```powershell
k6 run tiles-load.js
k6 run -e VUS=200 -e DURATION=2m tiles-load.js
k6 run -e KEY=static-key-1 tiles-load.js        # auth-enabled container
k6 run -e RENDERED=1 tiles-load.js              # full image only (raster tiles)
```

Env: `BASE_URL STYLE DATA FONT KEY BBOX ZMIN ZMAX VUS DURATION RENDERED`
(defaults target `http://localhost:8081`, `streets-v2`, `romania-tilemaker`, Romania bounds, zoom 8–14). Thresholds fail
the run if vector p95 > 200 ms, error rate > 1 %, or checks < 99 %.

## ⚠ On Docker Desktop / Windows, benchmark from a named volume

The dev `compose.yml` bind-mounts `./data` from the Windows drive. Reads of the mbtiles then cross the Windows→WSL2
filesystem layer (9p/virtiofs), and that per-read latency — **not** the server — dominates the numbers. Measured at 50
VUs, wide bbox:

|                 | bind mount (`D:\`)              | named volume    |
|-----------------|---------------------------------|-----------------|
| vector tile p95 | 245 ms                          | **42 ms**       |
| throughput      | ~950 req/s                      | **4,200 req/s** |
| container CPU   | ~0.5 of 32 cores (idle-waiting) | still low       |

Same file, same server, ~5× faster — the bind mount was the bottleneck. So for a representative number, serve `/data`
from a Docker **named volume** (WSL2 ext4), via `compose.perf.yml` one directory up.

One-time populate (run from `tileserver-gl-dev/`; copies data **without** the 95 GB planet file and remaps the styles to
the romania source so everything resolves):

```powershell
docker volume create ts_data
docker run --rm -v ts_data:/dest -v "${PWD}\data:/src:ro" -v "${PWD}\..\tileserver-gl-data:/assets:ro" alpine sh -c `
  "mkdir -p /dest/mbtiles /dest/pmtiles; cp -a /src/config.json /dest/; cp -a /assets/fonts /assets/styles /dest/; cp /src/mbtiles/romania-latest.tilemaker.mbtiles /dest/mbtiles/; sed -i '/mapping/ s/planet-tilemaker/romania-tilemaker/g' /dest/config.json"

docker compose -f compose.perf.yml up -d       # serves off ts_data on :8081
```

(config.json + tile databases come from `./data`; styles and fonts from the shared `../tileserver-gl-data` folder.)

Then run k6 against it. To take the k6↔server host hop out too, run k6 as a container on the same network:

```powershell
docker run --rm --network tileserver-gl-dev_default -v "${PWD}\k6:/scripts" `
  grafana/k6 run -e BASE_URL=http://tileserver-gl:8080 -e VUS=50 -e DURATION=25s /scripts/tiles-load.js
```

## S3 / PMTiles: single container vs horizontal scaling

The `compose.s3.yml` stack serves tiles straight from object storage (MinIO here, real S3 in production) via PMTiles
range reads — no local mbtiles, so the Windows bind-mount caveat above does not apply. Drive the load in-network to skip
the host port-forward hop; that stack enables auth, so pass the key:

```powershell
# single container (compose.s3.yml, service `tileserver-gl`)
docker run --rm --network tileserver-s3_default -v "${PWD}\k6:/scripts" `
  -e BASE_URL=http://tileserver-gl:8080 -e DATA=planet-s3 -e KEY=devkey123 `
  -e VUS=50 -e DURATION=1m grafana/k6 run /scripts/tiles-load.js
```

Measured on this machine (32 cores, Docker Desktop), Romania tileset, zoom 8–14, **0 errors** throughout:

| load    | throughput | vector p95 | vector p99 |
|---------|------------|------------|------------|
| 50 VUs  | 639 req/s  | 632 ms     | 838 ms     |
| 200 VUs | 613 req/s  | **2.72 s** | 4.1 s      |

One light container tops out at **~640 req/s / ~40 MB/s** and saturates around **50 concurrent users** — the single JS
event loop is the wall. Past the knee you only add latency: 200 VUs gave *no* more throughput than 50, just ~4× the p95.
It never drops requests, though — 0 errors even when overloaded.

### Scaling out

`compose.scale.yml` + `nginx-lb.conf` run N stateless replicas behind an nginx round-robin LB, all sharing the same
MinIO (joined via the existing network):

```powershell
docker compose -f compose.s3.yml up -d                     # MinIO + tiles first
docker compose -f compose.scale.yml up -d --scale app=4
docker run --rm --network tileserver-s3_default -v "${PWD}\k6:/scripts" `
  -e BASE_URL=http://lb -e DATA=planet-s3 -e KEY=devkey123 `
  -e VUS=200 -e DURATION=45s grafana/k6 run /scripts/tiles-load.js
docker compose -f compose.scale.yml down
```

Same 200-VU load, 1 container vs 4 replicas:

|            | 1 container | 4 replicas + LB        |
|------------|-------------|------------------------|
| throughput | 613 req/s   | **1,275 req/s** (2.1×) |
| data out   | 37 MB/s     | 77 MB/s                |
| vector p95 | 2.72 s      | **745 ms**             |
| vector p99 | 4.1 s       | 870 ms                 |
| errors     | 0%          | 0%                     |

Load spread evenly (all four replicas ~260% CPU mid-run). Throughput scaled ~2× rather than 4× because everything shares
one box here — a single MinIO, one nginx, and one k6 client on the same Docker Desktop VM cap the aggregate, **not** the
tileserver. In production the ceiling lifts as those separate: real S3 / an object-store cluster, a managed LB, and
above all **a CDN in front** — with the tile `Cache-Control` headers already set, most requests never reach origin,
which is the real multiplier for a tile server.

## Reading the results

- **Check CPU during a run**: `docker stats tileserver-gl`. Low CPU + high latency = I/O or concurrency wait, not
  compute (the bind-mount symptom above).
- **No cache in front**: every request hits the origin — this is raw origin cost. Production behind an ingress/CDN cache
  is far higher for repeat tiles.
- **k6 shares the machine**: at high VUs the client competes with the server for cores, so numbers are a lower bound.
  For a true figure, drive from another host.
- **204s aren't errors**: empty tiles (water/edges) are valid and counted in
  `vector_tiles_empty_204`. Narrow `BBOX` to a dense area to reduce them.

## Cleanup

```powershell
docker compose -f compose.perf.yml down
docker volume rm ts_data
```
