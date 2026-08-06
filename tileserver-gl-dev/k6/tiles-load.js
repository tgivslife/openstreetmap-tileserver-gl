// k6 load test for the tileserver-gl container.
//
//   k6 run tiles-load.js
//   k6 run -e VUS=100 -e DURATION=2m tiles-load.js
//   k6 run -e KEY=static-key-1 tiles-load.js          # auth-enabled container
//   k6 run -e RENDERED=1 tiles-load.js                # full image only (raster)
//
// Env (all optional):
//   BASE_URL   default http://localhost:8081
//   STYLE      default streets-v2         (used for style.json / sprite / raster)
//   DATA       default romania-tilemaker  (vector tile source id)
//   FONT       default Noto Sans Regular  (glyph stack to exercise)
//   KEY        API key / token, appended as ?key=… when set
//   BBOX       "minLon,minLat,maxLon,maxLat" — where to sample tiles from
//   ZMIN/ZMAX  zoom sampling range, default 8..14 (dense data, realistic views)
//   VUS        peak virtual users, default 50
//   DURATION   hold time at peak, default 1m
//   RENDERED   any value → also request rendered raster tiles (404 on -light)
//
// The load model is one browsing step per iteration: mostly a small viewport of
// vector tiles (a 2×2 block, fetched in parallel like a browser pans), with an
// occasional style (re)load — style.json + glyph ranges + sprite — as a real
// client does once per session. Requests are tagged so the end-of-test summary
// breaks p95/p99 down per endpoint.

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://localhost:8081').replace(/\/$/, '');
const STYLE = __ENV.STYLE || 'streets-v2';
const DATA = __ENV.DATA || 'romania-tilemaker';
const FONT = __ENV.FONT || 'Noto Sans Regular';
const KEY = __ENV.KEY || '';
const RENDERED = !!__ENV.RENDERED;
const ZMIN = Number(__ENV.ZMIN || 8);
const ZMAX = Number(__ENV.ZMAX || 14);
const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || '1m';

const [MINLON, MINLAT, MAXLON, MAXLAT] = (
  __ENV.BBOX || '20.24181,43.61247,30.27896,48.26948' // Romania tileset bounds
)
  .split(',')
  .map(Number);

// Fraction of iterations that (re)load the style instead of panning.
const SESSION_SHARE = 0.08;
// When RENDERED, fraction of viewport iterations that fetch a raster tile too.
const RENDERED_SHARE = 0.25;

const emptyTiles = new Counter('vector_tiles_empty_204');

// --- helpers ----------------------------------------------------------------

const withKey = (path) =>
  BASE + path + (KEY ? (path.includes('?') ? '&' : '?') + 'key=' + KEY : '');

const rnd = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rnd(min, max + 1));

// slippy-map tile coordinates from lon/lat/zoom
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * Math.pow(2, z));
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) *
      Math.pow(2, z),
  );
};

// a random tile (z,x,y) inside the configured bbox
function sampleTile() {
  const z = randInt(ZMIN, ZMAX);
  const max = Math.pow(2, z) - 1;
  const x = Math.min(max, lon2x(rnd(MINLON, MAXLON), z));
  const y = Math.min(max, lat2y(rnd(MAXLAT, MINLAT), z)); // note lat order
  return { z, x, y };
}

const okTile = (r) => r.status === 200 || r.status === 204;

// --- scenario options -------------------------------------------------------

const thresholds = {
  http_req_failed: ['rate<0.01'],
  checks: ['rate>0.99'],
  'http_req_duration{name:vector_tile}': ['p(95)<200', 'p(99)<500'],
  'http_req_duration{name:style}': ['p(95)<300'],
  'http_req_duration{name:glyph}': ['p(95)<200'],
  'http_req_duration{name:sprite}': ['p(95)<400'],
};
if (RENDERED) {
  // GL render per miss — expensive, lenient bound.
  thresholds['http_req_duration{name:rendered_tile}'] = ['p(95)<1500'];
}

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// --- steps ------------------------------------------------------------------

function viewport() {
  // A 2×2 block of adjacent tiles, fetched in parallel like a browser viewport.
  const { z, x, y } = sampleTile();
  const max = Math.pow(2, z) - 1;
  const coords = [
    [x, y],
    [Math.min(max, x + 1), y],
    [x, Math.min(max, y + 1)],
    [Math.min(max, x + 1), Math.min(max, y + 1)],
  ];
  const reqs = coords.map(([tx, ty]) => ({
    method: 'GET',
    url: withKey(`/data/${DATA}/${z}/${tx}/${ty}.pbf`),
    params: { tags: { name: 'vector_tile' } },
  }));
  const res = http.batch(reqs);
  for (const r of res) {
    check(r, { 'vector tile 200/204': okTile });
    if (r.status === 204) emptyTiles.add(1);
  }

  if (RENDERED && Math.random() < RENDERED_SHARE) {
    const r = http.get(withKey(`/styles/${STYLE}/${z}/${x}/${y}.png`), {
      tags: { name: 'rendered_tile' },
    });
    check(r, { 'rendered tile 200': (x) => x.status === 200 });
  }
}

function sessionSetup() {
  const style = http.get(withKey(`/styles/${STYLE}/style.json`), {
    tags: { name: 'style' },
  });
  check(style, { 'style.json 200': (r) => r.status === 200 });

  const stack = encodeURIComponent(FONT);
  const glyphs = http.batch(
    ['0-255', '256-511'].map((range) => ({
      method: 'GET',
      url: withKey(`/fonts/${stack}/${range}.pbf`),
      params: { tags: { name: 'glyph' } },
    })),
  );
  for (const g of glyphs) check(g, { 'glyph 200': (r) => r.status === 200 });

  const sprite = http.get(withKey(`/styles/${STYLE}/sprite.png`), {
    tags: { name: 'sprite' },
  });
  check(sprite, { 'sprite 200': (r) => r.status === 200 });
}

export default function () {
  if (Math.random() < SESSION_SHARE) {
    sessionSetup();
  } else {
    viewport();
  }
}
