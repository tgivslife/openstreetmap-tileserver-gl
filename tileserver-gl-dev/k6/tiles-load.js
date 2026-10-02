// k6 load test for the tileserver-gl container.
//
//   k6 run tiles-load.js                                         # closed-model smoke test
//   k6 run -e VUS=100 -e DURATION=2m tiles-load.js
//   k6 run -e MODE=open -e RATE=200 tiles-load.js                # capacity: stepped arrival rate up to 200 it/s
//   k6 run -e KEY=static-key-1 tiles-load.js                     # auth-enabled container
//   k6 run -e KEYS=k1,k2 -e TOKEN_SECRET=dev-hmac-secret tiles-load.js
//   k6 run -e RENDERED=1 tiles-load.js                           # full image only (raster)
//
// Env (all optional):
//   BASE_URL   default http://localhost:8081
//   STYLE      default streets-v2         (used for style.json / sprite / raster)
//   DATA       default romania-tilemaker  (vector tile source id)
//   FONT       default Noto Sans Regular  (glyph stack to exercise)
//   BBOX       "minLon,minLat,maxLon,maxLat" — where to sample tiles from
//   ZMIN/ZMAX  zoom sampling range, default 8..14 (dense data, realistic views)
//   RENDERED   any value → also request rendered raster tiles (404 on -light)
//
//   MODE       closed (default) | open
//     closed: VUS virtual users loop back to back (ramp 20 s, hold DURATION). A smoke test: when the server slows,
//             each VU sends less, so the offered load falls exactly when it matters.
//       VUS        peak virtual users, default 50
//       DURATION   hold time at peak, default 1m
//     open:   iterations arrive at a set rate whatever the response times, climbing in STEPS equal steps from
//             RATE/STEPS to RATE iterations/s, each held STEP_DURATION. An iteration is ~3.7 requests on average.
//             Every request is tagged with its step's rate (level), and per-level p95 thresholds make the summary
//             show where latency breaks. dropped_iterations > 0 means k6 ran out of VUs: the server stopped keeping up.
//       RATE           peak iterations/s, default 100
//       STEPS          number of steps, default 5
//       STEP_DURATION  hold per step, default 30s
//       MAX_VUS        VU ceiling, default 1000
//
//   Auth (each VU picks one credential for its lifetime, so the load spreads over many keys and users):
//     KEY            one static API key (kept for compatibility; same as KEYS with one entry)
//     KEYS           comma-separated static API keys, assigned to VUs round-robin
//     TOKEN_SECRET   sign expiring HMAC tokens per VU, as a backend would per user (server's TILESERVER_GL_TOKEN_SECRET)
//     TOKEN_TTL      token lifetime in seconds, default 3600; a VU renews its token in the last 10 %
//     TOKEN_SHARE    fraction of VUs on tokens when both KEYS and TOKEN_SECRET are set, default 0.5
//
//   CONDITIONAL_SHARE  fraction of viewport steps that revisit a viewport this VU fetched before, sending its tiles'
//                      ETag / Last-Modified the way a browser revalidates a stale cache entry; expects 304. Default 0.2.
//
// The load model is one browsing step per iteration: mostly a small viewport of
// vector tiles (a 2×2 block, fetched in parallel like a browser pans), with an
// occasional style (re)load — style.json + glyph ranges + sprite — as a real
// client does once per session. Requests are tagged so the end-of-test summary
// breaks p95/p99 down per endpoint.

import http from 'k6/http';
import crypto from 'k6/crypto';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://localhost:8081').replace(/\/$/, '');
const STYLE = __ENV.STYLE || 'streets-v2';
const DATA = __ENV.DATA || 'romania-tilemaker';
const FONT = __ENV.FONT || 'Noto Sans Regular';
const RENDERED = !!__ENV.RENDERED;
const ZMIN = Number(__ENV.ZMIN || 8);
const ZMAX = Number(__ENV.ZMAX || 14);
const MODE = (__ENV.MODE || 'closed').toLowerCase();
const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || '1m';
const RATE = Number(__ENV.RATE || 100);
const STEPS = Number(__ENV.STEPS || 5);
const STEP_DURATION = __ENV.STEP_DURATION || '30s';
const MAX_VUS = Number(__ENV.MAX_VUS || 1000);
const KEYS = (__ENV.KEYS || __ENV.KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);
const TOKEN_SECRET = __ENV.TOKEN_SECRET || '';
const TOKEN_TTL = Number(__ENV.TOKEN_TTL || 3600);
const TOKEN_SHARE =
  __ENV.TOKEN_SHARE !== undefined ? Number(__ENV.TOKEN_SHARE) : KEYS.length ? 0.5 : 1;
const CONDITIONAL_SHARE = Number(
  __ENV.CONDITIONAL_SHARE !== undefined ? __ENV.CONDITIONAL_SHARE : 0.2,
);

if (MODE !== 'closed' && MODE !== 'open') {
  throw new Error(`MODE must be "closed" or "open", got "${MODE}"`);
}

const [MINLON, MINLAT, MAXLON, MAXLAT] = (
  __ENV.BBOX || '20.24181,43.61247,30.27896,48.26948' // Romania tileset bounds
)
  .split(',')
  .map(Number);

// Fraction of iterations that (re)load the style instead of panning.
const SESSION_SHARE = 0.08;
// When RENDERED, fraction of viewport iterations that fetch a raster tile too.
const RENDERED_SHARE = 0.25;

// Viewports a VU remembers for conditional revisits (per VU: module state is per VU in k6).
// Each entry is a list of { url, etag, lastModified } for the tiles that came back 200 with an ETag.
const REMEMBERED_VIEWPORTS = 20;
const remembered = [];

const emptyTiles = new Counter('vector_tiles_empty_204');
const notModified = new Rate('revalidation_not_modified');

// --- open-model steps ---------------------------------------------------------

// "30s" / "2m" / "500ms" → milliseconds.
function durationMs(d) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(d);
  if (!m) throw new Error(`Unsupported duration "${d}" (use e.g. 500ms, 30s or 2m)`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60000 }[m[2]];
}

// Iterations/s of each step, rounded up, lowest first.
const LEVELS = Array.from({ length: STEPS }, (_, i) =>
  Math.max(1, Math.ceil((RATE * (i + 1)) / STEPS)),
);
const RAMP_MS = 5000;
const STEP_MS = RAMP_MS + durationMs(STEP_DURATION);

// The step whose rate k6 is ramping to or holding now, as a tag value; '' in closed mode.
function currentLevel() {
  if (MODE !== 'open') return '';
  const step = Math.floor(exec.instance.currentTestRunDuration / STEP_MS);
  return String(LEVELS[Math.min(step, LEVELS.length - 1)]);
}

// --- auth -------------------------------------------------------------------

// One credential per VU for its lifetime: a static key, or a token it signs and renews like a per-user backend would.
let credential = null;

function useToken() {
  if (!TOKEN_SECRET) return false;
  if (!KEYS.length) return true;
  // Spread token VUs evenly over VU ids instead of taking the first ones.
  return ((exec.vu.idInTest * 0.6180339887) % 1) < TOKEN_SHARE;
}

function signToken() {
  const expiry = Math.floor(Date.now() / 1000) + TOKEN_TTL;
  const signature = crypto.hmac('sha256', TOKEN_SECRET, String(expiry), 'hex');
  return { key: `${expiry}.${signature}`, renewAt: (expiry - TOKEN_TTL * 0.1) * 1000 };
}

// The ?key= value for this VU's next request, or '' with no auth configured.
function currentKey() {
  if (!credential) {
    credential = useToken()
      ? signToken()
      : { key: KEYS.length ? KEYS[(exec.vu.idInTest - 1) % KEYS.length] : '', renewAt: Infinity };
  }
  if (Date.now() >= credential.renewAt) {
    credential = signToken();
    // Remembered URLs carry the old token, which is about to stop working.
    remembered.length = 0;
  }
  return credential.key;
}

// --- helpers ----------------------------------------------------------------

const withKey = (path) => {
  const key = currentKey();
  return BASE + path + (key ? (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key) : '');
};

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
if (CONDITIONAL_SHARE > 0) {
  // A revalidation runs the same tile read as a 200 before the ETag is compared, so it gets the same latency bound.
  thresholds['http_req_duration{name:vector_tile_revalidate}'] = ['p(95)<200'];
  thresholds.revalidation_not_modified = ['rate>0.99'];
}
if (MODE === 'open') {
  // One p95 line per step in the summary: the first step that fails is where this server stops keeping up.
  for (const level of LEVELS) {
    thresholds[`http_req_duration{name:vector_tile,level:${level}}`] = ['p(95)<200'];
  }
  // k6 ran out of VUs to start iterations on time: responses were too slow for the arrival rate.
  thresholds.dropped_iterations = ['count==0'];
}

const scenario =
  MODE === 'open'
    ? {
        executor: 'ramping-arrival-rate',
        startRate: LEVELS[0],
        timeUnit: '1s',
        preAllocatedVUs: Math.min(MAX_VUS, Math.max(10, RATE)),
        maxVUs: MAX_VUS,
        stages: LEVELS.flatMap((level) => [
          { duration: `${RAMP_MS}ms`, target: level },
          { duration: STEP_DURATION, target: level },
        ]),
      }
    : {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
          { duration: '20s', target: VUS },
          { duration: DURATION, target: VUS },
          { duration: '10s', target: 0 },
        ],
      };

export const options = {
  scenarios: { browse: scenario },
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
  const validators = [];
  for (const [i, r] of res.entries()) {
    check(r, { 'vector tile 200/204': okTile });
    if (r.status === 204) emptyTiles.add(1);
    const etag = r.status === 200 && r.headers['Etag'];
    if (etag) {
      validators.push({ url: reqs[i].url, etag, lastModified: r.headers['Last-Modified'] });
    }
  }
  if (validators.length) {
    remembered.push(validators);
    if (remembered.length > REMEMBERED_VIEWPORTS) remembered.shift();
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

// Revisits a viewport this VU fetched before, the way a browser revalidates a stale cache entry: each tile is requested
// with the ETag (and Last-Modified) it came with, and the server should answer 304 with no body.
function revisit() {
  const tiles = remembered[Math.floor(Math.random() * remembered.length)];
  const res = http.batch(
    tiles.map(({ url, etag, lastModified }) => ({
      method: 'GET',
      url,
      params: {
        headers: lastModified
          ? { 'If-None-Match': etag, 'If-Modified-Since': lastModified }
          : { 'If-None-Match': etag },
        tags: { name: 'vector_tile_revalidate' },
      },
    })),
  );
  for (const r of res) {
    notModified.add(r.status === 304);
    check(r, { 'revalidated tile 304': (x) => x.status === 304 });
  }
}

export default function () {
  // In open mode every metric of this iteration carries the step's rate, for the per-level thresholds.
  const level = currentLevel();
  if (level) exec.vu.metrics.tags.level = level;

  if (Math.random() < SESSION_SHARE) {
    sessionSetup();
  } else if (remembered.length && Math.random() < CONDITIONAL_SHARE) {
    revisit();
  } else {
    viewport();
  }
}
