'use strict'

import express from 'express'

import { getFontsPbf, listFonts, setCacheControl } from './utils.js'

let metricsModule = null

/**
 * Initializes and returns an Express app that serves font files.
 * @param {object} options - Configuration options for the server.
 * @param {object} allowedFonts - An object containing allowed fonts.
 * @param {object} programOpts - An object containing the program options.
 * @returns {Promise<express.Application>} - A promise that resolves to the Express app.
 */
export async function serve_font (options, allowedFonts, programOpts) {
  const { verbose } = programOpts
  // Cache metrics module if enabled. Safe because tests verify before production.
  if (programOpts.metrics) {
    const m = await import('./metrics.js')
    metricsModule = m
  }
  const app = express().disable('x-powered-by')

  const lastModified = new Date().toUTCString()

  const fontPath = options.paths.fonts

  const existingFonts = {}

  /**
   * Handles requests for a font file.
   * @param {object} req - Express request object.
   * @param {object} res - Express response object.
   * @param {string} req.params.fontstack - Name of the font stack.
   * @param {string} req.params.range - The range of the font (e.g. 0-255).
   * @returns {Promise<void>}
   */
  app.get('/fonts/:fontstack/:range.pbf', async (req, res) => {
    const sRange = String(req.params.range).replace(/\n|\r/g, '')
    // decodeURI throws URIError on a malformed percent-encoding (e.g. a request of /fonts/%25/... leaves req.params.fontstack as '%').
    // Guard it so that is a clean 400 rather than an uncaught rejection surfacing as a generic 500.
    let sFontStack
    try {
      sFontStack = String(decodeURI(req.params.fontstack)).replace(/\n|\r/g, '')
    } catch {
      return res
        .status(400)
        .header('Content-Type', 'text/plain')
        .send('Error serving font')
    }

    if (verbose >= 1) {
      console.log(`Handling font request for: /fonts/%s/%s.pbf`, sFontStack, sRange)
    }

    const modifiedSince = req.get('if-modified-since')
    const cc = req.get('cache-control')
    if (modifiedSince && (!cc || cc.indexOf('no-cache') === -1)) {
      if (
        new Date(lastModified).getTime() === new Date(modifiedSince).getTime()
      ) {
        // A cache that gets this 304 keeps its stored copy but restarts its freshness from the headers sent here, so send the
        // Cache-Control a 200 would; without one it would reuse the stored one, which may allow longer than this request should.
        setCacheControl(res, options, 'asset')
        return res.sendStatus(304)
      }
    }

    // Glyph PBFs only cover the Basic Multilingual Plane: codepoints 0-65535, in 256-wide blocks.
    // A request beyond that — e.g. the U+E0100 variation selectors some labels carry (range 917760-918015) — cannot exist for any font.
    // Answer it directly instead of ENOENT-cascading through every fallback font, which floods the log with dozens of errors before failing anyway.
    const rangeStart = Number(sRange.split('-')[0])
    if (Number.isFinite(rangeStart) && rangeStart > 65535) {
      if (verbose >= 1) {
        console.log(
          'Skipping out-of-range glyph request: /fonts/%s/%s.pbf',
          sFontStack,
          sRange
        )
      }
      return res
        .status(404)
        .header('Content-Type', 'text/plain')
        .send('Glyph range out of range')
    }

    try {
      const concatenated = await getFontsPbf(
        options.serveAllFonts ? null : allowedFonts,
        fontPath,
        sFontStack,
        sRange,
        existingFonts
      )
      res.header('Content-type', 'application/x-protobuf')
      res.header('Last-Modified', lastModified)
      setCacheControl(res, options, 'asset')
      if (metricsModule) {
        metricsModule.tilesServedTotal.inc({ type: 'font', name: sFontStack })
      }
      return res.send(concatenated)
    } catch (err) {
      console.error(`Error serving font: %s/%s.pbf, Error: %s`, sFontStack, sRange, String(err))
      return res.status(400).header('Content-Type', 'text/plain').send('Error serving font')
    }
  })

  /**
   * Handles requests for a list of all available fonts.
   * @param {object} req - Express request object.
   * @param {object} res - Express response object.
   * @returns {void}
   */
  app.get('/fonts.json', (req, res) => {
    if (verbose >= 1) {
      console.log('Handling list font request for /fonts.json')
    }
    res.header('Content-type', 'application/json')
    setCacheControl(res, options, 'metadata')
    return res.send(
      Object.keys(options.serveAllFonts ? existingFonts : allowedFonts).sort()
    )
  })

  const fonts = await listFonts(options.paths.fonts)
  Object.assign(existingFonts, fonts)
  return app
}
