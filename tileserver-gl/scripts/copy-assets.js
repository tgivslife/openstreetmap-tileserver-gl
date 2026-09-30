'use strict'

// Copy the prebuilt browser assets that ship as-is into public/resources.
//
// These are vendor files we serve verbatim rather than bundle: leaflet's own dist build.
// maplibre-gl shapes right-to-left text itself since 6.9, so the viewer no longer loads an RTL text plugin.
// Everything else under public/resources is produced by the esbuild steps in the `prepare` script.
//
//   npm run copy:assets
//   node scripts/copy-assets.js
//
// Exit code: 0 all copied, 1 a source file is missing.

import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const destDir = path.join(root, 'public', 'resources')

const sources = [
  'node_modules/leaflet/dist/leaflet.js',
  'node_modules/leaflet/dist/leaflet.js.map',
  'node_modules/leaflet/dist/leaflet.css'
]

mkdirSync(destDir, { recursive: true })

let failed = 0
for (const source of sources) {
  const from = path.join(root, source)
  const to = path.join(destDir, path.basename(source))
  try {
    copyFileSync(from, to)
    console.log(`copy ${source} -> public/resources/${path.basename(source)}`)
  } catch (err) {
    console.error(`failed to copy ${source}: ${err.message}`)
    failed++
  }
}

if (failed > 0) process.exit(1)
