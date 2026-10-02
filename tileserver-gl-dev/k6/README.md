# k6 load test

`tiles-load.js` drives the tileserver container: a browsing mix of vector-tile viewports (the dominant load) plus
occasional style / glyph / sprite fetches, with valid tile coordinates sampled inside the tileset bounds. Requests are
tagged so the summary breaks p95/p99 down per endpoint.

## Run

k6 on the host (`brew install k6`, or `C:\Program Files\k6\k6.exe` on Windows):

```powershell
k6 run tiles-load.js                                        # smoke test (closed model)
k6 run -e VUS=200 -e DURATION=2m tiles-load.js
k6 run -e MODE=open -e RATE=400 tiles-load.js               # capacity test (open model), see below
k6 run -e KEY=static-key-1 tiles-load.js                    # auth-enabled container, one key
k6 run -e KEYS=k1,k2,k3 -e TOKEN_SECRET=dev-hmac-secret tiles-load.js   # many keys + per-user tokens
k6 run -e RENDERED=1 tiles-load.js                          # full image only (raster tiles)
```

Env: `BASE_URL STYLE DATA FONT BBOX ZMIN ZMAX RENDERED`, `MODE` with `VUS DURATION` (closed) or
`RATE STEPS STEP_DURATION MAX_VUS` (open), `KEY KEYS TOKEN_SECRET TOKEN_TTL TOKEN_SHARE`, `CONDITIONAL_SHARE`. The header of
`tiles-load.js` documents each. Defaults target `http://localhost:8081`, `streets-v2`, `romania-tilemaker`, Romania bounds,
zoom 8–14. Thresholds fail the run if vector p95 > 200 ms, error rate > 1 %, checks < 99 %, or fewer than 99 % of
revalidations answer 304; in open mode also if any step's p95 > 200 ms or k6 dropped iterations.

## Load models: smoke vs capacity

**Closed (`MODE=closed`, default): a smoke test.** `VUS` users loop back to back, each fetching a 2×2 viewport in
parallel, so 50 VUs keep up to ~200 tile requests in flight. When the server slows, each VU sends less: the offered load
falls exactly when it matters, so this answers "is it healthy at this concurrency", not "what rate can it take".

**Open (`MODE=open`): a capacity test.** Iterations arrive at a set rate whatever the response times, climbing in `STEPS`
equal steps up to `RATE` iterations/s (each ~3.7 requests: viewports of four tiles, revisits, the occasional style load),
each step held `STEP_DURATION`. Every request is tagged with its step, and the summary prints one p95 line per step
(illustrative values):

```
http_req_duration{name:vector_tile,level:200}   ✓ 'p(95)<200' p(95)=41ms
http_req_duration{name:vector_tile,level:400}   ✗ 'p(95)<200' p(95)=612ms     ← the knee
dropped_iterations                              ✗ 'count==0'  count=1834
```

The last passing step is the sustainable rate for that setup. Watch `dropped_iterations` too: when responses get slow
enough that all `MAX_VUS` are busy, k6 skips arrivals instead of queueing them, so an overload can show up as drops while
the p95 of the requests that did run still looks fine.

## Auth and conditional traffic

- **Many credentials.** `KEYS` spreads static keys over VUs round-robin. `TOKEN_SECRET` makes VUs sign their own expiring
  tokens (`<expiry>.<hmac>`), as a backend would per user, renewing them in the last 10 % of `TOKEN_TTL`; with both set,
  `TOKEN_SHARE` (default 0.5) of VUs use tokens. Each VU keeps one credential, so the server sees many distinct keys
  instead of one.
- **Conditional requests.** Each VU remembers its last 20 viewports with their `ETag` / `Last-Modified`, and
  `CONDITIONAL_SHARE` (default 0.2) of viewport steps revisit one with `If-None-Match` / `If-Modified-Since`, as a browser
  revalidates stale tiles. Those requests are tagged `vector_tile_revalidate` and should all answer 304
  (`revalidation_not_modified`). On this server a revalidation still reads the tile before comparing the ETag, so expect
  similar latency to a 200, just fewer bytes.

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

Romania tileset, zoom 8–14, closed model with one key and no revalidation traffic (`CONDITIONAL_SHARE=0`), **0 errors**
throughout. Two machines:

| load    | Windows, 32 cores, k6 in-network | Apple M1 Max, Docker VM 8 CPUs, k6 on the host (2026-10-02) |
|---------|-----------------------------------|-------------------------------------------------------------|
| 50 VUs  | 639 req/s, p95 632 ms, p99 838 ms | 1,266 req/s, 46.5 MB/s, p95 354 ms, p99 508 ms               |
| 200 VUs | 613 req/s, p95 **2.72 s**, p99 4.1 s | 1,272 req/s, 46.8 MB/s, p95 **1.47 s**, p99 2.18 s        |

On both, one light container saturates by about **50 concurrent users**: past that, more users add only latency (four
times the users gave ~4× the p95 and no more throughput). It never drops requests, though: 0 errors even when overloaded.
On the Mac the container used ~3.3 CPUs at saturation, so more than one core is in play (the S3 client, gzip and the
network stack), not only the JS event loop.

**Capacity (open model)**, same Mac, `MODE=open RATE=400 STEPS=8 STEP_DURATION=20s MAX_VUS=150`, 0 errors:

| iterations/s (~3.7 req each) | 50    | 100   | 150   | 200    | 250        | 300        | 350        | 400        |
|------------------------------|-------|-------|-------|--------|------------|------------|------------|------------|
| vector p95                   | 28 ms | 32 ms | 49 ms | 103 ms | 272 ms ✗   | 480 ms ✗   | 1.08 s ✗   | 1.26 s ✗   |

So one container holds p95 < 200 ms up to **~200 iterations/s, about 740 req/s**; past that latency climbs and k6 starts
dropping iterations (2,854 over the run).

**⚠ Docker Desktop on macOS: cap `MAX_VUS` when k6 runs on the host.** With `MAX_VUS=400` the first steps, at only 50
and 100 iterations/s, had requests hang to k6's 60 s timeout (0.8 % failed); with 100 or 150 VUs, or against the same
server run natively without Docker, nothing hung. Hundreds of VUs open a burst of new connections (four per viewport)
through Docker Desktop's port forward to `localhost`, and part of the burst stalls. Keep `MAX_VUS` around 150 on the
host, or run k6 in-network as above, which skips the port forward.

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

Same 200-VU load, 1 container vs 4 replicas, on the Windows machine with k6 in-network:

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

On the M1 Max with k6 on the host (through the load balancer's published port, 2026-10-02), 4 replicas gave **no** gain:
1,143 req/s at 200 VUs (p95 769 ms, half the single container's, but no more throughput), and the open-model run held
p95 < 200 ms only up to 150 iterations/s, versus 200 for one container. Each replica used ~1.1 CPUs and MinIO ~0.9, so
something shared caps the aggregate there; the port forward that stalls connection bursts (above) is the likely suspect,
but that was not isolated. Compare scaling with k6 in-network, as in the Windows run.

## Fault run: storage outage and reload

`faults.sh` drives `faults.js` against the `compose.s3.yml` stack: a steady 50 requests/s for 150 s, while it pauses MinIO
for 20 s at 30 s (a storage outage) and sends the tileserver `SIGHUP` at 90 s (a config reload). Needs k6 and docker on
the host; Windows users run it from WSL or Git Bash.

```bash
docker compose -f ../compose.s3.yml up -d      # from tileserver-gl-dev/, first
./faults.sh                                    # from k6/
PAUSE_AT=20 PAUSE_FOR=30 RELOAD_AT=80 DURATION=120 RATE=100 ./faults.sh
```

Every request is tagged with the phase it falls in, and the thresholds check:

- **baseline, recovered, final**: under 1 % failed.
- **outage**: failures are only 502/503/504, each faster than `FAULT_MAX_MS` (default 6 s, the 5 s S3 request timeout
  plus 1 s) and marked `Cache-Control: no-store`, so nothing hangs and no CDN keeps the error; and there were some
  (`outage_errors > 0`), proving MinIO was really paused.
- **reload**: as for the outage, plus refused connections while the listener restarts (`reload_connection_errors`).

The script always unpauses MinIO on exit, and exits with k6's status, so a failed threshold fails the run.

## Sizing the S3 socket pool

`TILESERVER_GL_S3_MAX_SOCKETS` (default 256) caps the S3 connections per container. Connections in use are roughly
S3 reads per second × S3 response time, so the right value depends on the request rate you need and your storage's
latency. A local MinIO answers in well under a millisecond, which would make any value look sufficient, so add realistic
latency first. From `tileserver-gl-dev/`, with the stack up:

```bash
# 1. Delay MinIO's replies by your real S3 latency (here 20 ms ± 5 ms). Use your platform's alpine image (--platform)
#    so tc runs natively; under emulation it fails with "Cannot talk to rtnetlink".
docker run --rm --net container:tileserver-s3-minio-1 --cap-add NET_ADMIN alpine:3.22 \
  sh -c "apk add -q iproute2 && tc qdisc add dev eth0 root netem delay 20ms 5ms"

# 2. For each candidate, restart the tileserver with it and run the same capacity test.
for sockets in 32 64 128 256; do
  TILESERVER_GL_S3_MAX_SOCKETS=$sockets docker compose -f compose.s3.yml up -d tileserver-gl
  sleep 10
  (cd k6 && k6 run -e MODE=open -e RATE=400 -e STEPS=4 -e STEP_DURATION=30s \
     -e BASE_URL=http://127.0.0.1:8082 -e DATA=planet-s3 -e KEY=devkey123 tiles-load.js)
done

# 3. Remove the delay.
docker run --rm --net container:tileserver-s3-minio-1 --cap-add NET_ADMIN alpine:3.22 \
  sh -c "apk add -q iproute2 && tc qdisc del dev eth0 root"
```

Keep the smallest value whose highest passing step matches 256's: past it, more sockets buy nothing, and each socket
held open costs memory on the server and a connection on S3. For a production figure, run against the real bucket from
the same region instead of MinIO plus a delay. In a short local run of this procedure (20 ms delay, one machine),
8 sockets broke at 200 iterations/s (p95 2.5 s) while 256 held 200 and broke at 300, so the sweep does separate
settings; the absolute numbers are not production figures. The first step of a run also includes PMTiles directory
reads on a cold cache, so its p95 can be higher than the next step's.

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
