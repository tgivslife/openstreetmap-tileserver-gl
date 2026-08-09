// esbuild entry for the browser viewer bundle.
//
// maplibre-gl v6 ships ES modules only (no UMD/global build), but the viewer templates load a classic <script> and use window.maplibregl / MaplibreInspect.
// So bundle maplibre-gl + the inspect plugin (and their CSS) into one IIFE that re-exposes those globals.
// Built by `npm run build:maplibre` into public/resources/maplibre-gl.js (+ .css + .js.map).

import * as maplibregl from 'maplibre-gl'
import MaplibreInspect from '@maplibre/maplibre-gl-inspect'
import 'maplibre-gl/dist/maplibre-gl.css'
import '@maplibre/maplibre-gl-inspect/dist/maplibre-gl-inspect.css'

// v6 loads its web worker as a separate module resolved from import.meta.url, which is meaningless in this IIFE,
// it would resolve against the page URL and 404.
// Point maplibre at maplibre-gl-worker.js shipped next to this script (built by the same npm script),
// preserving this script's query string so an auth-gated deployment (?key=) still fetches it.
const scriptSrc = document.currentScript && document.currentScript.src
if (scriptSrc && typeof maplibregl.setWorkerUrl === 'function') {
  const workerUrl = new URL('maplibre-gl-worker.js', scriptSrc)
  workerUrl.search = new URL(scriptSrc).search
  maplibregl.setWorkerUrl(workerUrl.href)
}

window.maplibregl = maplibregl
window.MaplibreInspect = MaplibreInspect
