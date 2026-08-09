'use strict'

// Verify that every glyph PBF under a fonts directory decodes cleanly.
// Some font builds emit corrupt ranges (invalid protobuf wire types) that both
// the server's combiner (@jsse/pbfont) and MapLibre's own client decoder reject
// with "Unimplemented type: 6" / "illegal tag ...". This surfaces them up front.
//
//   npm run check:fonts                 # checks ../tileserver-gl-data/fonts
//   npm run check:fonts -- /data/fonts  # or any fonts directory
//   node scripts/check-fonts.js <dir>
//
// Exit code: 0 all clean, 1 corrupt file(s) found, 2 the directory is unreadable.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PbfReader } from 'pbf'

// Minimal glyphs.proto walkers. They descend into every glyph sub-message so an
// invalid protobuf wire type buried in glyph data is actually hit (and throws)
// rather than silently skipped at the top level.

/**
 * Reads one field of a glyph message (id/bitmap/width/height/left/top/advance).
 * @param {number} tag - Protobuf field number.
 * @param {object} obj - Accumulator (unused; we only need the read to succeed).
 * @param {import('pbf').PbfReader} pbf - Reader positioned at the field value.
 * @returns {void}
 */
function readGlyphField (tag, obj, pbf) {
  if (tag === 2) pbf.readBytes()
  else if (tag === 1 || tag === 3 || tag === 4 || tag === 7) pbf.readVarint()
  else if (tag === 5 || tag === 6) pbf.readSVarint()
}

/**
 * Reads one field of a fontstack message (name / range / repeated glyphs).
 * @param {number} tag - Protobuf field number.
 * @param {object} obj - Accumulator (unused).
 * @param {import('pbf').PbfReader} pbf - Reader positioned at the field value.
 * @returns {void}
 */
function readStackField (tag, obj, pbf) {
  if (tag === 1 || tag === 2) pbf.readString()
  else if (tag === 3) pbf.readMessage(readGlyphField, {})
}

/**
 * Reads one field of the top-level glyphs message (repeated stacks).
 * @param {number} tag - Protobuf field number.
 * @param {object} obj - Accumulator (unused).
 * @param {import('pbf').PbfReader} pbf - Reader positioned at the field value.
 * @returns {void}
 */
function readGlyphsField (tag, obj, pbf) {
  if (tag === 1) pbf.readMessage(readStackField, {})
}

/**
 * Whether a buffer decodes as a valid glyphs PBF (fully walked).
 * @param {Buffer} buf - Candidate glyph PBF bytes.
 * @returns {boolean} - True if it decodes cleanly, false if the bytes are corrupt.
 */
function isGlyphPbf (buf) {
  try {
    new PbfReader(buf).readFields(readGlyphsField, {})
    return true
  } catch {
    return false
  }
}

const fontsDir = path.resolve(
  process.argv[2] || path.join('..', 'tileserver-gl-data', 'fonts')
)

// Set process.exitCode rather than calling process.exit(): process.exit() can
// truncate buffered stdout/stderr when the output is piped, and this script's
// last act is printing the corrupt-file list. Letting Node exit naturally flushes.
let fontDirs = null
try {
  fontDirs = readdirSync(fontsDir, { withFileTypes: true }).filter((d) =>
    d.isDirectory()
  )
} catch (err) {
  console.error(`Cannot read fonts directory "${fontsDir}": ${err.message}`)
  process.exitCode = 2
}

if (fontDirs) {
  let total = 0
  const bad = []
  for (const d of fontDirs) {
    const dir = path.join(fontsDir, d.name)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.pbf')) continue
      total++
      if (!isGlyphPbf(readFileSync(path.join(dir, file)))) {
        bad.push(path.join(d.name, file))
      }
    }
  }

  console.log(
    `Checked ${total} glyph PBF file(s) across ${fontDirs.length} font(s) in ${fontsDir}`
  )
  if (bad.length) {
    console.error(`\n${bad.length} undecodable (corrupt) file(s):`)
    for (const f of bad) console.error(`  ${f}`)
    process.exitCode = 1
  } else {
    console.log('All glyph PBFs decode cleanly.')
  }
}
