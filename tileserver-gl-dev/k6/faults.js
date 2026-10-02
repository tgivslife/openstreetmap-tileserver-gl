// k6 fault run: a steady request rate against the compose.s3.yml stack while faults.sh pauses MinIO and then reloads
// the tileserver with SIGHUP, on the same schedule this script uses to tag each request with its phase.
//
//   ./faults.sh                       # runs this script and injects the faults (see README.md)
//
// Phases (seconds from the start of the run):
//   baseline   before the outage                                must succeed
//   outage     MinIO paused, plus RECOVERY_GRACE after          may fail, but only fast (under FAULT_MAX_MS) with a
//                                                               502/503/504 that carries Cache-Control: no-store
//   recovered  after the outage, until the reload               must succeed
//   reload     SIGHUP, plus RELOAD_GRACE after                  may also fail to connect while the listener restarts
//   final      after the reload                                 must succeed
// Each fault window opens LEAD seconds early, since faults.sh starts its clock just before k6 does.
//
// Env (all optional):
//   BASE_URL      default http://localhost:8082 (compose.s3.yml)
//   DATA          default planet-s3
//   KEY           default devkey123 (compose.s3.yml's static key)
//   BBOX, ZMIN, ZMAX   where to sample tiles, default Romania, 8..14
//   RATE          requests/s, default 50 (one tile per iteration, so iterations/s = requests/s)
//   PAUSE_AT, PAUSE_FOR, RELOAD_AT, DURATION   schedule in seconds, default 30, 20, 90, 150 (faults.sh reads the same)
//   RECOVERY_GRACE, RELOAD_GRACE               seconds after each fault still counted as part of it, default 10
//   FAULT_MAX_MS  slowest acceptable error response, default 6000 (the 5 s S3 request timeout plus 1 s)

import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://localhost:8082').replace(/\/$/, '');
const DATA = __ENV.DATA || 'planet-s3';
const KEY = __ENV.KEY !== undefined ? __ENV.KEY : 'devkey123';
const [MINLON, MINLAT, MAXLON, MAXLAT] = (__ENV.BBOX || '20.24181,43.61247,30.27896,48.26948')
  .split(',')
  .map(Number);
const ZMIN = Number(__ENV.ZMIN || 8);
const ZMAX = Number(__ENV.ZMAX || 14);
const RATE = Number(__ENV.RATE || 50);
const PAUSE_AT = Number(__ENV.PAUSE_AT || 30);
const PAUSE_FOR = Number(__ENV.PAUSE_FOR || 20);
const RELOAD_AT = Number(__ENV.RELOAD_AT || 90);
const DURATION = Number(__ENV.DURATION || 150);
const RECOVERY_GRACE = Number(__ENV.RECOVERY_GRACE || 10);
const RELOAD_GRACE = Number(__ENV.RELOAD_GRACE || 10);
const FAULT_MAX_MS = Number(__ENV.FAULT_MAX_MS || 6000);
const LEAD = 2;

const unexpected = new Rate('unexpected_response');
const errorCached = new Rate('error_response_cacheable');
const errorDuration = new Trend('error_response_duration', true);
const outageErrors = new Counter('outage_errors');
const reloadConnectionErrors = new Counter('reload_connection_errors');

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: `${DURATION}s`,
      // During the outage each request waits up to the S3 timeout, so many more are in flight than at baseline.
      preAllocatedVUs: Math.max(10, RATE * 2),
      maxVUs: Math.max(50, Math.ceil((RATE * FAULT_MAX_MS) / 1000) * 2),
    },
  },
  thresholds: {
    // Outside the fault windows everything succeeds.
    'http_req_failed{phase:baseline}': ['rate<0.01'],
    'http_req_failed{phase:recovered}': ['rate<0.01'],
    'http_req_failed{phase:final}': ['rate<0.01'],
    // Inside them, failures are the expected kind only: fast, uncached 5xx (or refused connections during reload).
    unexpected_response: ['rate==0'],
    error_response_cacheable: ['rate==0'],
    error_response_duration: [`max<${FAULT_MAX_MS}`],
    // The outage actually happened: a run where MinIO was never paused proves nothing.
    outage_errors: ['count>0'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'max'],
};

function phaseAt(seconds) {
  if (seconds < PAUSE_AT - LEAD) return 'baseline';
  if (seconds < PAUSE_AT + PAUSE_FOR + RECOVERY_GRACE) return 'outage';
  if (seconds < RELOAD_AT - LEAD) return 'recovered';
  if (seconds < RELOAD_AT + RELOAD_GRACE) return 'reload';
  return 'final';
}

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * Math.pow(2, z));
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z));
};

export default function () {
  const phase = phaseAt(exec.instance.currentTestRunDuration / 1000);
  exec.vu.metrics.tags.phase = phase;

  const z = ZMIN + Math.floor(Math.random() * (ZMAX - ZMIN + 1));
  const x = lon2x(MINLON + Math.random() * (MAXLON - MINLON), z);
  const y = lat2y(MAXLAT - Math.random() * (MAXLAT - MINLAT), z);
  const key = KEY ? `?key=${encodeURIComponent(KEY)}` : '';
  const r = http.get(`${BASE}/data/${DATA}/${z}/${x}/${y}.pbf${key}`, {
    tags: { name: 'vector_tile' },
    timeout: '15s',
  });

  const ok = r.status === 200 || r.status === 204;
  const storageError = r.status === 502 || r.status === 503 || r.status === 504;
  const refused = r.status === 0 && phase === 'reload';
  if (storageError) {
    errorDuration.add(r.timings.duration);
    errorCached.add(!/\bno-store\b/.test(r.headers['Cache-Control'] || ''));
    if (phase === 'outage') outageErrors.add(1);
  }
  if (refused) reloadConnectionErrors.add(1);

  const allowed = phase === 'outage' ? ok || storageError : phase === 'reload' ? ok || storageError || refused : ok;
  unexpected.add(!allowed);
  check(r, { [`${phase}: expected response`]: () => allowed });
}
