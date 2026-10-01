'use strict'

import path from 'path'
import fsPromises from 'fs/promises'
import fs from 'node:fs'
import querystring from 'node:querystring'
import clone from 'clone'
import { combine } from '@jsse/pbfont'
import { existsP } from './promises.js'
import { getPMtilesTile, isThrottleError } from './pmtiles_adapter.js'

export const allowedSpriteFormats = allowedOptions(['png', 'json'])
export const allowedTileSizes = allowedOptions(['256', '512'])
export const httpTester = /^https?:\/\//i
export const s3Tester = /^s3:\/\//i // Plain AWS S3 format
export const s3HttpTester = /^s3\+https?:\/\//i // S3-compatible with custom endpoint
export const pmtilesTester = /^pmtiles:\/\//i
export const mbtilesTester = /^mbtiles:\/\//i

/**
 * Restrict user input to an allowed set of options.
 * @param {string[]} opts - An array of allowed option strings.
 * @param {object} [config] - Optional configuration object.
 * @param {string} [config.defaultValue] - The default value to return if input doesn't match.
 * @returns {(value: string) => string} - A function that takes a value and returns it if valid or a default.
 */
export function allowedOptions (opts, { defaultValue } = {}) {
  const values = Object.fromEntries(opts.map((key) => [key, key]))
  // eslint-disable-next-line security/detect-object-injection -- value is checked against allowed opts keys
  return (value) => values[value] || defaultValue
}

/**
 * Parses a scale string to a number.
 * @param {string} scale The scale string (e.g., '2x', '4x').
 * @param {number} maxScale Maximum allowed scale digit.
 * @returns {number|null} The parsed scale as a number or null if invalid.
 */
export function allowedScales (scale, maxScale = 9) {
  if (scale === undefined) {
    return 1
  }

  const regex = new RegExp(`^[2-${maxScale}]x$`)
  if (!regex.test(scale)) {
    return null
  }

  return parseInt(scale.slice(0, -1), 10)
}

/**
 * Checks if a string is a valid sprite scale and returns it if it is within the allowed range, and null if it does not conform.
 * @param {string} scale - The scale string to validate (e.g., '2x', '3x').
 * @param {number} [maxScale] - The maximum scale value. If no value is passed in, it defaults to a value of 3.
 * @returns {string|null} - The valid scale string or null if invalid.
 */
export function allowedSpriteScales (scale, maxScale = 3) {
  if (!scale) {
    return ''
  }
  const match = scale?.match(/^([2-9]\d*)x$/)
  if (!match) {
    return null
  }
  const parsedScale = parseInt(match[1], 10)
  if (parsedScale <= maxScale) {
    return `@${parsedScale}x`
  }
  return null
}

/**
 * Replaces local:// URLs with public http(s):// URLs.
 * @param {object} req - Express request object.
 * @param {string} url - The URL string to fix.
 * @param {string} publicUrl - The public URL prefix to use for replacements.
 * @param {string|string[]} allowedHosts - Allowed hosts for Host header poisoning mitigation.
 * @returns {string} - The fixed URL string.
 */
export function fixUrl (req, url, publicUrl, allowedHosts) {
  if (!url || typeof url !== 'string' || url.indexOf('local://') !== 0) {
    return url
  }
  const queryParams = []
  // Only a non-empty string key is embedded, matching the style cache key in serve_style.
  // A repeated ?key=a&key=b parses to an array; treating it as a key here (Array→"a,b") while the cache key treats it
  // as absent would poison the keyless cache entry with a stray ?key=a%2Cb.
  if (typeof req.query.key === 'string' && req.query.key !== '') {
    queryParams.unshift(`key=${encodeURIComponent(req.query.key)}`)
  }
  let query = ''
  if (queryParams.length) {
    query = `?${queryParams.join('&')}`
  }
  return (
    url.replace('local://', getPublicUrl(publicUrl, req, allowedHosts)) + query
  )
}

/**
 * Removes optional :port from a host string for comparison. Handles IPv6 [addr]:port.
 * @param {string} host - The input host.
 * @returns {string} - Host string with port removed.
 */
function stripPort (host) {
  if (!host || typeof host !== 'string') {
    return host
  }
  if (host.startsWith('[')) {
    const i = host.indexOf(']:')
    return i > 0 ? host.slice(0, i + 1) : host
  }
  const i = host.lastIndexOf(':')
  if (i > 0 && /^\d+$/.test(host.slice(i + 1))) return host.slice(0, i)
  return host
}

/**
 * Parses allowed-hosts config: "*" or comma-separated list or array. Default "*" means allow any host (no HNP mitigation).
 * Hosts are normalized to lowercase for case-insensitive matching (hostnames are case-insensitive per RFC).
 * @param {string|string[]|undefined} allowedHosts - Env TILESERVER_GL_ALLOWED_HOSTS or opts.allowedHosts.
 * @returns {string|string[]} - "*" or array of allowed host strings (port stripped, lowercased).
 */
export function parseAllowedHosts (allowedHosts) {
  if (allowedHosts == null || allowedHosts === '') {
    return '*'
  }
  const normalize = (h) => {
    const v = stripPort(String(h).trim())
    return v ? v.toLowerCase() : ''
  }
  if (Array.isArray(allowedHosts)) {
    return allowedHosts.map(normalize).filter(Boolean)
  }
  const s = typeof allowedHosts === 'string' ? allowedHosts.trim() : ''
  if (s === '*' || s === '') {
    return '*'
  }
  return s.split(',').map(normalize).filter(Boolean)
}

/**
 * Returns true if host is allowed (allowlist is "*" or host is in the list). Port stripped, comparison case-insensitive.
 * @param {string} host - Host to check (e.g. from request or X-Forwarded-Host).
 * @param {string|string[]} allowedHosts - Result of parseAllowedHosts().
 * @returns {boolean} - True if the host is allowed, false otherwise.
 */
export function isHostAllowed (host, allowedHosts) {
  if (!host || typeof host !== 'string') {
    return false
  }
  const h = stripPort(host.split(',')[0].trim()).toLowerCase()
  if (allowedHosts === '*') {
    return true
  }
  if (Array.isArray(allowedHosts)) {
    return allowedHosts.includes(h)
  }
  return false
}

/** Host header must not contain path or whitespace (sanity check for malformed headers). */
const BAD_HOST_RE = /[\s/]/

/**
 * Candidate host from request: X-Forwarded-Host or Host header.
 * Returns undefined if the value looks malformed (contains / or whitespace), so it is treated as not allowed.
 * @param {object} req - Express request.
 * @returns {string|undefined} - The candidate host string, or undefined if the value is malformed.
 */
export function getCandidateHost (req) {
  const check = (raw) => {
    if (!raw || typeof raw !== 'string') {
      return undefined
    }
    const s = raw.split(',')[0].trim()
    if (BAD_HOST_RE.test(s)) {
      return undefined
    }
    return s
  }
  const forwarded = req.get && req.get('X-Forwarded-Host')
  if (forwarded) {
    const v = check(forwarded)
    if (v !== undefined) {
      return v
    }
  }
  const host = req.get && req.get('host')
  if (host) {
    const v = check(host)
    if (v !== undefined) {
      return v
    }
  }
  if (req.hostname) {
    const v = check(req.hostname)
    if (v !== undefined) {
      return v
    }
  }
  return undefined
}

/**
 * Protocol for URL building: only http or https (mitigates scheme injection).
 * @param {object} req - Express request.
 * @returns {string} - 'http' or 'https'.
 */
export function getSafeProtocol (req) {
  const get = req.get && req.get.bind(req)
  const proto = (get && (get('X-Forwarded-Protocol') || get('X-Forwarded-Proto'))) || req.protocol || 'http'
  const p = (typeof proto === 'string' ? proto : '').toLowerCase()
  return p === 'https' ? 'https' : 'http'
}

/**
 * Generates a new URL object from the Express request.
 * @param {object} req - Express request object.
 * @returns {URL} - URL object with correct host and optionally path.
 */
function getUrlObject (req) {
  // getSafeProtocol clamps X-Forwarded-Proto/req.protocol to http|https so a header like `X-Forwarded-Proto: javascript`
  // cannot inject a scheme into the absolute URLs reflected into style.json / TileJSON bodies.
  const urlObject = new URL(`${getSafeProtocol(req)}://${req.headers.host}/`)
  // support overriding hostname by sending X-Forwarded-Host http header
  urlObject.hostname = req.hostname

  // support overriding port by sending X-Forwarded-Port http header
  const xForwardedPort = req.get('X-Forwarded-Port')
  if (xForwardedPort) {
    urlObject.port = xForwardedPort
  }

  // support add url prefix by sending X-Forwarded-Path http header
  const xForwardedPath = req.get('X-Forwarded-Path')
  if (xForwardedPath) {
    urlObject.pathname = path.posix.join(xForwardedPath, urlObject.pathname)
  }
  return urlObject
}

/**
 * Gets the public URL, either from a provided publicUrl or generated from the request.
 * When publicUrl is not set, uses allowedHosts (default "*") to mitigate Host header poisoning:
 * if the request host is not in the allowlist, returns a path-only prefix (e.g. "/") so responses
 * do not contain attacker-controlled hosts.
 * @param {string} publicUrl - The optional public URL to use.
 * @param {object} req - The Express request object.
 * @param {string|string[]} [allowedHosts] - "*" or list of allowed hosts (e.g. from TILESERVER_GL_ALLOWED_HOSTS).
 * @returns {string} - The final public URL string (or path-only prefix if host not allowed).
 */
export function getPublicUrl (publicUrl, req, allowedHosts) {
  if (publicUrl) {
    try {
      return new URL(publicUrl).toString()
    } catch {
      return new URL(publicUrl, getUrlObject(req)).toString()
    }
  }
  const parsed = parseAllowedHosts(allowedHosts)
  const candidateHost = getCandidateHost(req)
  if (!isHostAllowed(candidateHost, parsed)) {
    const xForwardedPath = req.get && req.get('X-Forwarded-Path')
    const prefix = xForwardedPath ? `/${xForwardedPath.replace(/^\/+/, '')}` : ''
    return prefix ? (prefix.endsWith('/') ? prefix : `${prefix}/`) : '/'
  }
  return getUrlObject(req).toString()
}

/**
 * Generates an array of tile URLs based on given parameters.
 * When publicUrl is not set, uses allowedHosts to mitigate HNP: if request host is not allowed, returns path-only URLs.
 * @param {object} req - Express request object.
 * @param {string | string[]} domains - Domain(s) to use for tile URLs.
 * @param {string} path - The base path for the tiles.
 * @param {number} [tileSize] - The size of the tile (optional).
 * @param {string} format - The format of the tiles (e.g., 'png', 'jpg').
 * @param {string} publicUrl - The public URL to use (if not using domains).
 * @param {object} [aliases] - Aliases for format extensions.
 * @param {string|string[]} [allowedHosts] - "*" or list of allowed hosts for HNP mitigation.
 * @returns {string[]} An array of tile URL strings.
 */
export function getTileUrls (
  req,
  domains,
  path,
  tileSize,
  format,
  publicUrl,
  aliases,
  allowedHosts
) {
  const urlObject = getUrlObject(req)
  const parsedAllowed = parseAllowedHosts(allowedHosts)
  const candidateHost = getCandidateHost(req)
  const hostAllowed = isHostAllowed(candidateHost, parsedAllowed)
  const safeProtocol = getSafeProtocol(req)

  if (domains) {
    if (domains.constructor === String && domains.length > 0) {
      domains = domains.split(',')
    }
    const hostParts = urlObject.host.split('.')
    const relativeSubdomainsUsable = hostParts.length > 1 && !/^([0-9]{1,3}\.){3}[0-9]{1,3}(:[0-9]+)?$/.test(urlObject.host)
    const newDomains = []
    for (const domain of domains) {
      if (domain.indexOf('*') !== -1) {
        if (relativeSubdomainsUsable) {
          const newParts = hostParts.slice(1)
          newParts.unshift(domain.replace(/\*/g, hostParts[0]))
          newDomains.push(newParts.join('.'))
        }
      } else {
        newDomains.push(domain)
      }
    }
    domains = newDomains
  }
  if (!domains || domains.length === 0) {
    domains = [urlObject.host]
  }

  const queryParams = []
  // Embed only non-empty string values; a repeated param parses to an array,
  // which would otherwise be reflected as "a,b" (see fixUrl).
  if (typeof req.query.key === 'string' && req.query.key !== '') {
    queryParams.push(`key=${encodeURIComponent(req.query.key)}`)
  }
  if (typeof req.query.style === 'string' && req.query.style !== '') {
    queryParams.push(`style=${encodeURIComponent(req.query.style)}`)
  }
  const query = queryParams.length > 0 ? `?${queryParams.join('&')}` : ''

  // eslint-disable-next-line security/detect-object-injection -- format is validated format string from tileJSON
  if (aliases && aliases[format]) {
    // eslint-disable-next-line security/detect-object-injection -- format is validated format string from tileJSON
    format = aliases[format]
  }

  let tileParams = `{z}/{x}/{y}`
  if (tileSize && ['png', 'jpg', 'jpeg', 'webp'].includes(format)) {
    tileParams = `${tileSize}/{z}/{x}/{y}`
  }

  if (format && format !== '') {
    format = `.${format}`
  } else {
    format = ''
  }

  const xForwardedPath = `${req.get('X-Forwarded-Path') ? '/' + req.get('X-Forwarded-Path').replace(/^\/+/, '') : ''}`

  const uris = []
  if (!publicUrl) {
    if (!hostAllowed) {
      uris.push(`${xForwardedPath}/${path}/${tileParams}${format}${query}`)
    } else {
      for (const domain of domains) {
        uris.push(`${safeProtocol}://${domain}${xForwardedPath}/${path}/${tileParams}${format}${query}`)
      }
    }
  } else {
    uris.push(`${getPublicUrl(publicUrl, req, allowedHosts)}${path}/${tileParams}${format}${query}`)
  }

  return uris
}

/**
 * Fixes the center in the tileJSON if no center is available.
 * @param {object} tileJSON - The tileJSON object to process.
 * @returns {void}
 */
export function fixTileJSONCenter (tileJSON) {
  if (tileJSON.bounds && !tileJSON.center) {
    const fitWidth = 1024
    const tiles = fitWidth / 256
    tileJSON.center = [
      (tileJSON.bounds[0] + tileJSON.bounds[2]) / 2,
      (tileJSON.bounds[1] + tileJSON.bounds[3]) / 2,
      Math.round(-Math.log((tileJSON.bounds[2] - tileJSON.bounds[0]) / 360 / tiles) / Math.LN2)
    ]
  }
}

/**
 * Reads a file and returns a Promise with the file data.
 * @param {string} filename - Path to the file to read.
 * @returns {Promise<Buffer>} - A Promise that resolves with the file data as a Buffer or rejects with an error.
 */
export function readFile (filename) {
  return new Promise((resolve, reject) => {
    const sanitizedFilename = path.normalize(filename) // Normalize path, remove ..

    fs.readFile(String(sanitizedFilename), (err, data) => {
      if (err) {
        reject(err)
      } else {
        resolve(data)
      }
    })
  })
}

/**
 * Retrieves font data for a given font and range.
 * @param {object} allowedFonts - An object of allowed fonts.
 * @param {string} fontPath - The path to the font directory.
 * @param {string} name - The name of the font.
 * @param {string} range - The range (e.g., '0-255') of the font to load.
 * @param {object} [fallbacks] - Optional fallback font list.
 * @returns {Promise<Buffer>} A promise that resolves with the font data Buffer or rejects with an error.
 */
async function getFontPbf (allowedFonts, fontPath, name, range, fallbacks) {
  // eslint-disable-next-line security/detect-object-injection -- name is validated font name from sanitizedName check
  if (!allowedFonts || (allowedFonts[name] && fallbacks)) {
    const fontMatch = name?.match(/^[\p{L}\p{N} \-_.~!*'()@&=+,#$[\]]+$/u)
    const sanitizedName = fontMatch?.[0] || 'invalid'
    if (!name || typeof name !== 'string' || name.trim() === '' || !fontMatch) {
      console.error('ERROR: Invalid font name: %s',
        sanitizedName.replace(/\n|\r/g, '')
      )
      throw new Error('Invalid font name')
    }

    const rangeMatch = range?.match(/^[\d-]+$/)
    const sanitizedRange = rangeMatch?.[0] || 'invalid'
    if (!/^\d+-\d+$/.test(range)) {
      console.error('ERROR: Invalid range: %s',
        sanitizedRange.replace(/\n|\r/g, '')
      )
      throw new Error('Invalid range')
    }
    const filename = path.join(fontPath, sanitizedName, `${sanitizedRange}.pbf`)

    // The charset above permits ".", so a fontstack of ".." (or any ".." segment) makes path.join climb out of the fonts directory.
    // "/" and "\" are rejected so only a lone ".." can traverse, but verify containment explicitly rather than rely on the regex.
    const fontRoot = path.resolve(fontPath)
    const resolved = path.resolve(filename)
    if (resolved !== fontRoot && !resolved.startsWith(fontRoot + path.sep)) {
      console.error('ERROR: Invalid font name: %s', sanitizedName.replace(/\n|\r/g, ''))
      throw new Error('Invalid font name')
    }

    if (!fallbacks) {
      fallbacks = clone(allowedFonts || {})
    }
    // eslint-disable-next-line security/detect-object-injection -- name is validated font name
    delete fallbacks[name]

    try {
      return await readFile(filename)
    } catch (err) {
      console.error('ERROR: Font not found: %s, Error: %s',
        filename.replace(/\n|\r/g, ''),
        String(err)
      )
      if (fallbacks && Object.keys(fallbacks).length) {
        let fallbackName

        let fontStyle = name.split(' ').pop()
        if (['Regular', 'Bold', 'Italic'].indexOf(fontStyle) < 0) {
          fontStyle = 'Regular'
        }
        fallbackName = `Noto Sans ${fontStyle}`
        // eslint-disable-next-line security/detect-object-injection -- fallbackName is constructed from validated font style
        if (!fallbacks[fallbackName]) {
          fallbackName = `Open Sans ${fontStyle}`
          // eslint-disable-next-line security/detect-object-injection -- fallbackName is constructed from validated font style
          if (!fallbacks[fallbackName]) {
            fallbackName = Object.keys(fallbacks)[0]
          }
        }
        console.error(`ERROR: Trying to use %s as a fallback for: %s`, fallbackName, sanitizedName)
        // eslint-disable-next-line security/detect-object-injection -- fallbackName is constructed from validated font style
        delete fallbacks[fallbackName]
        return getFontPbf(null, fontPath, fallbackName, range, fallbacks)
      } else {
        throw new Error('Font load error', { cause: err })
      }
    }
  } else {
    throw new Error('Font not allowed')
  }
}

/**
 * Combines multiple font pbf buffers into one.
 * @param {object} allowedFonts - An object of allowed fonts.
 * @param {string} fontPath - The path to the font directory.
 * @param {string} names - Comma-separated font names.
 * @param {string} range - The range of the font (e.g., '0-255').
 * @param {object} [fallbacks] - Fallback font list.
 * @returns {Promise<Buffer>} - A promise that resolves to the combined font data buffer.
 */
export async function getFontsPbf (
  allowedFonts,
  fontPath,
  names,
  range,
  fallbacks
) {
  const fonts = names.split(',')
  const queue = []
  for (const font of fonts) {
    queue.push(
      getFontPbf(allowedFonts, fontPath, font, range, clone(allowedFonts || fallbacks))
    )
  }

  const combined = combine(await Promise.all(queue), names)
  return Buffer.from(combined.buffer, 0, combined.buffer.length)
}

/**
 * Lists available fonts in a given font directory.
 * @param {string} fontPath - The path to the font directory.
 * @returns {Promise<object>} - Promise that resolves with an object where keys are the font names.
 */
export async function listFonts (fontPath) {
  const existingFonts = {}

  const files = await fsPromises.readdir(fontPath)
  for (const file of files) {
    const stats = await fsPromises.stat(path.join(fontPath, file))
    if (stats.isDirectory() && (await existsP(path.join(fontPath, file, '0-255.pbf')))) {
      existingFonts[path.basename(file)] = true
    }
  }

  return existingFonts
}

/**
 * Checks if a string is a valid HTTP/HTTPS URL.
 * @param {string} string - The string to check.
 * @returns {boolean} - True if the string is a valid HTTP/HTTPS URL.
 */
export function isValidHttpUrl (string) {
  try {
    return httpTester.test(string)
  } catch {
    return false
  }
}

/**
 * Checks if a string is a valid S3 URL.
 * @param {string} string - The string to check.
 * @returns {boolean} - True if the string is a valid S3 URL.
 */
export function isS3Url (string) {
  try {
    return s3Tester.test(string) || s3HttpTester.test(string)
  } catch {
    return false
  }
}

/**
 * Checks if a string is a valid remote URL (HTTP, HTTPS, or S3).
 * @param {string} string - The string to check.
 * @returns {boolean} - True if the string is a valid remote URL.
 */
export function isValidRemoteUrl (string) {
  try {
    return (
      httpTester.test(string) ||
      s3Tester.test(string) ||
      s3HttpTester.test(string)
    )
  } catch {
    return false
  }
}

/**
 * Checks if a string uses the pmtiles:// protocol.
 * @param {string} string - The string to check.
 * @returns {boolean} - True if the string uses pmtiles:// protocol.
 */
export function isPMTilesProtocol (string) {
  try {
    return pmtilesTester.test(string)
  } catch {
    return false
  }
}

/**
 * Checks if a string uses the mbtiles:// protocol.
 * @param {string} string - The string to check.
 * @returns {boolean} - True if the string uses mbtiles:// protocol.
 */
export function isMBTilesProtocol (string) {
  try {
    return mbtilesTester.test(string)
  } catch {
    return false
  }
}

/**
 * Converts a longitude/latitude point to tile and pixel coordinates at a given zoom level.
 * @param {number} lon - Longitude in degrees.
 * @param {number} lat - Latitude in degrees.
 * @param {number} zoom - Zoom level.
 * @param {number} tileSize - Size of the tile in pixels (e.g., 256 or 512).
 * @returns {{tileX: number, tileY: number, pixelX: number, pixelY: number}} - Tile and pixel coordinates.
 */
export function lonLatToTilePixel (lon, lat, zoom, tileSize) {
  let siny = Math.sin((lat * Math.PI) / 180)
  // Truncating to 0.9999 effectively limits latitude to 89.189. This is
  // about a third of a tile past the edge of the world tile.
  siny = Math.min(Math.max(siny, -0.9999), 0.9999)

  const xWorld = tileSize * (0.5 + lon / 360)
  const yWorld = tileSize * (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI))

  const scale = 1 << zoom

  const tileX = Math.floor((xWorld * scale) / tileSize)
  const tileY = Math.floor((yWorld * scale) / tileSize)

  const pixelX = Math.floor(xWorld * scale) - tileX * tileSize
  const pixelY = Math.floor(yWorld * scale) - tileY * tileSize

  return { tileX, tileY, pixelX, pixelY }
}

/**
 * A tile read that failed for a reason other than the tile being absent: storage denied, unreachable, throttled, timed out
 * or unreadable. Kept apart from an absent tile so an outage is answered as an error, not as empty geography.
 */
export class TileSourceError extends Error {
  /**
   * Creates a TileSourceError.
   * @param {string} message - What failed, for the server log.
   * @param {object} details - Error details.
   * @param {Error} details.cause - The underlying error.
   * @param {number} details.status - HTTP status to answer with: 504 when remote storage timed out, 503 when it is throttling,
   *   502 for another remote failure, 500 for a local archive.
   */
  constructor (message, { cause, status }) {
    super(message, { cause })
    this.name = 'TileSourceError'
    this.status = status
  }
}

/**
 * Fetches tile data from either PMTiles or MBTiles source.
 * @param {object} source - The source object, which may contain a mbtiles object, or pmtiles object.
 * @param {string} sourceType - The source type, which should be `pmtiles` or `mbtiles`
 * @param {number} z - The zoom level.
 * @param {number} x - The x coordinate of the tile.
 * @param {number} y - The y coordinate of the tile.
 * @returns {Promise<object | null>} - A promise that resolves to an object with data and headers, or null if the archive has no such tile.
 * @throws {TileSourceError} - When the archive could not be read.
 */
export async function fetchTileData (source, sourceType, z, x, y) {
  if (sourceType === 'pmtiles') {
    let tileInfo
    try {
      tileInfo = await getPMtilesTile(source, z, x, y)
    } catch (error) {
      let status = 502
      if (error?.name === 'TimeoutError') {
        status = 504
      } else if (isThrottleError(error)) {
        status = 503
      }
      throw new TileSourceError(`PMTiles read failed for tile ${z}/${x}/${y}`, { cause: error, status })
    }
    if (!tileInfo?.data) {
      return null
    }
    return { data: tileInfo.data, headers: tileInfo.header }
  } else if (sourceType === 'mbtiles') {
    return new Promise((resolve, reject) => {
      source.getTile(z, x, y, (err, tileData, tileHeader) => {
        // @mapbox/mbtiles reports an absent row as this error; anything else is the archive failing to read.
        if (err?.message === 'Tile does not exist' || (!err && tileData == null)) {
          return resolve(null)
        }
        if (err) {
          return reject(new TileSourceError(`MBTiles read failed for tile ${z}/${x}/${y}`, { cause: err, status: 500 }))
        }
        resolve({ data: tileData, headers: tileHeader })
      })
    })
  }
}

/**
 * Answers a request whose tile could not be read, with no-store so neither the browser nor a shared cache keeps the failure.
 * The body is generic: the cause can name filesystem paths or S3 buckets and keys, so it goes to the server log only.
 * @param {object} res - Express response object.
 * @param {Error} error - The error from fetchTileData.
 * @param {string} what - The request, for the log.
 * @returns {object} - The response.
 */
export function sendTileSourceError (res, error, what) {
  console.error(`Tile source error for ${what}:`, error?.cause ?? error)
  return res
    .status(error instanceof TileSourceError ? error.status : 500)
    .set('Cache-Control', 'no-store')
    .type('text/plain')
    .send('Tile source unavailable')
}

/**
 * Reads a flag that may arrive as a boolean or as text.
 *
 * MBTiles metadata is a table of strings, so a `sparse` row arrives as "false" - truthy at face value. PMTiles metadata is JSON and
 * can hold a real boolean. Anything unrecognised is treated as absent, so a typo falls through to the next level of precedence
 * instead of silently meaning true.
 * @param {unknown} value - The raw value.
 * @returns {boolean|undefined} The boolean, or undefined if absent or unrecognised.
 */
export function parseOptionalBoolean (value) {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') {
      return true
    }
    if (normalized === 'false' || normalized === '0') {
      return false
    }
  }
  return undefined
}

/**
 * Resolves whether a source answers a missing tile sparsely.
 *
 * Precedence, highest first: the source's own config setting, the global config option, the archive's metadata, then the format:
 * raster sources are sparse so MapLibre overzooms from the parent, vector sources are not so an empty tile stops the overzoom.
 * Config outranks metadata because an operator can change their config but not always the archive. Nullish coalescing is deliberate:
 * an explicit false at any level wins over the levels below it. Named arguments, since two of the levels are often absent.
 * @param {object} levels - The values to resolve between.
 * @param {boolean} [levels.perSource] - The source's own `sparse` config setting.
 * @param {boolean} [levels.globalOption] - The top-level `sparse` option.
 * @param {boolean} [levels.metadata] - `sparse` from the archive's metadata, already parsed.
 * @param {boolean} levels.isVector - Whether the source serves vector tiles.
 * @returns {boolean} True when a missing tile answers 404 (overzoom) rather than 204 (empty tile).
 */
export function resolveSparse ({ perSource, globalOption, metadata, isVector }) {
  return perSource ?? globalOption ?? metadata ?? !isVector
}

/**
 * Replaces the value of every `key` query parameter in a URL with [REDACTED], for logging.
 * Names are decoded the way Express's query parser (node:querystring) decodes them before the key gate reads req.query.key,
 * so an encoded name such as `k%65y` is caught too; matching the raw text `key=` missed it.
 * @param {string} url - A request URL or path, or a Referer.
 * @returns {string} - The URL with key values redacted.
 */
export function redactKeyInUrl (url) {
  const queryStart = url.indexOf('?')
  if (queryStart === -1) {
    return url
  }
  const hashStart = url.indexOf('#', queryStart)
  const queryEnd = hashStart === -1 ? url.length : hashStart
  const pairs = url.slice(queryStart + 1, queryEnd).split('&').map((pair) => {
    const eq = pair.indexOf('=')
    const rawName = eq === -1 ? pair : pair.slice(0, eq)
    const name = querystring.unescape(rawName.replace(/\+/g, ' '))
    return name.toLowerCase() === 'key' ? `${rawName}=[REDACTED]` : pair
  })
  return url.slice(0, queryStart + 1) + pairs.join('&') + url.slice(queryEnd)
}

/**
 * Default Cache-Control values per response category.
 *
 * `tile` describes content that only changes when the archives are rebuilt, so it carries a day of freshness plus a week
 * of stale-while-revalidate. `metadata` (style.json, TileJSON, catalogs) gets an hour.
 * `asset` covers glyph ranges and sprite sheets. Their URLs carry no version, so they must not be `immutable`: a redeploy that
 * changes a sprite would otherwise be invisible for a year. They get the same hour as the style.json that references them,
 * so a client never pairs a new style with an old sprite for longer, and revalidating is a cheap 304 on the ETag.
 * Viewer HTML is never cached, so a redeployment is picked up immediately.
 */
const defaultCacheControl = {
  tile: 'public, max-age=86400, stale-while-revalidate=604800',
  asset: 'public, max-age=3600',
  metadata: 'public, max-age=3600',
  static: 'public, max-age=86400',
  html: 'no-cache'
}

/**
 * Resolves the Cache-Control header for a category of response.
 *
 * Set `options.cacheControl` to false in the config to suppress the headers
 * entirely, or to an object keyed by category to override individual values
 * (a per-category false suppresses just that one).
 * @param {object} options - The `options` block from the config file.
 * @param {string} category - One of tile, asset, metadata, static, html.
 * @returns {string|null} - Header value, or null when no header should be set.
 */
export function getCacheControl (options, category) {
  const configured = options?.cacheControl
  if (configured === false) {
    return null
  }
  // eslint-disable-next-line security/detect-object-injection -- category is an internal literal, not user input
  const override = configured?.[category]
  if (override === false || override === null) {
    return null
  }
  if (typeof override === 'string') {
    return override
  }
  // eslint-disable-next-line security/detect-object-injection -- category is an internal literal, not user input
  return defaultCacheControl[category] ?? null
}

/**
 * Caps a Cache-Control value to the lifetime left on the expiring token that authorised the request.
 * A cache keys on the token URL, so freshness beyond the token's expiry would let a shared cache keep answering a URL the
 * origin already rejects. max-age and s-maxage are cut to the seconds left, including a quoted value such as
 * s-maxage="86400", which caches accept; one whose value cannot be read is replaced by the seconds left.
 * stale-while-revalidate, stale-if-error and immutable are dropped, a value with no max-age gets one, and must-revalidate
 * is added: without it a client sending max-stale may still be served the response once stale (RFC 9111 §4.2.4).
 * Requests authorised by a static API key, or by none, set no expiry and are left as they are.
 * @param {string|null} value - The Cache-Control value.
 * @param {object} res - Express response object; the key gate stores the token's expiry, in epoch seconds, in res.locals.keyExpiresAt.
 * @param {number} [nowSec] - Current time in epoch seconds.
 * @returns {string|null} - The capped value.
 */
export function capCacheControlToKeyExpiry (value, res, nowSec = Date.now() / 1000) {
  const expiresAt = res.locals?.keyExpiresAt
  if (!value || expiresAt === undefined || /\bno-store\b/i.test(value)) {
    return value
  }
  const remaining = Math.floor(expiresAt - nowSec)
  if (remaining <= 0) {
    return 'no-store'
  }
  const dropped = new Set(['stale-while-revalidate', 'stale-if-error', 'immutable', 'must-revalidate'])
  const directives = []
  for (const directive of value.split(',').map((d) => d.trim()).filter(Boolean)) {
    const name = directive.split('=')[0].trim().toLowerCase()
    if (dropped.has(name)) {
      continue
    }
    if (name === 'max-age' || name === 's-maxage') {
      const seconds = directive.match(/=\s*"?\s*(\d+)\s*"?\s*$/)
      directives.push(`${name}=${seconds ? Math.min(Number(seconds[1]), remaining) : remaining}`)
    } else {
      directives.push(directive)
    }
  }
  if (!directives.some((d) => d.startsWith('max-age=') || d.toLowerCase() === 'no-cache')) {
    directives.push(`max-age=${remaining}`)
  }
  directives.push('must-revalidate')
  return directives.join(', ')
}

/**
 * Sets the Cache-Control header for a category, unless it is suppressed.
 * @param {object} res - Express response object.
 * @param {object} options - The `options` block from the config file.
 * @param {string} category - One of tile, asset, metadata, static, html.
 * @returns {void}
 */
export function setCacheControl (res, options, category) {
  const value = capCacheControlToKeyExpiry(getCacheControl(options, category), res)
  if (value) {
    res.set('Cache-Control', value)
  }
}

/**
 * Request headers that change the absolute URLs embedded in a host-derived
 * response body (the tile/sprite/glyph links in style.json and TileJSON). A
 * shared cache keys on the URL alone, so unless it also keys on these headers a
 * response built from an attacker's X-Forwarded-* values can be stored under the
 * plain URL and served to every other client — redirecting their map (and
 * `?key=`) traffic to an attacker host.
 */
const HOST_DERIVED_VARY = [
  'X-Forwarded-Host',
  'X-Forwarded-Proto',
  'X-Forwarded-Protocol',
  'X-Forwarded-Port',
  'X-Forwarded-Path'
]

/**
 * Whether the public URLs embedded in a response are pinned to server config rather than derived from mutable request headers.
 * Pinned when an explicit publicUrl is configured, or when allowedHosts restricts the reflected host to a known allowlist (so it cannot be attacker-chosen).
 * @param {string} [publicUrl] - Configured public URL, if any.
 * @param {string|string[]} [allowedHosts] - allowedHosts config.
 * @returns {boolean} - True when the embedded host is not attacker-controllable.
 */
function hostUrlsArePinned (publicUrl, allowedHosts) {
  if (publicUrl) {
    return true
  }
  return parseAllowedHosts(allowedHosts) !== '*'
}

/**
 * Sets Cache-Control for a response whose body embeds request-host-derived absolute URLs.
 * Always adds a Vary on the forwarded headers so a compliant shared cache keys on them; and when the reflected host is
 * attacker-controllable (no publicUrl and allowedHosts is the default "*"), downgrades a shared-cacheable directive to
 * `private` so a shared cache cannot serve one client's (or an attacker's) host back to another.
 * Configuring publicUrl or TILESERVER_GL_ALLOWED_HOSTS pins the host and restores public caching.
 * @param {object} res - Express response object.
 * @param {object} options - The `options` block from the config file.
 * @param {string} category - Cache-Control category (e.g. 'metadata').
 * @param {object} [ctx] - Host-pinning context.
 * @param {string} [ctx.publicUrl] - Configured public URL, if any.
 * @param {string|string[]} [ctx.allowedHosts] - allowedHosts config.
 * @returns {void}
 */
export function setHostDerivedCacheControl (
  res,
  options,
  category,
  { publicUrl, allowedHosts } = {}
) {
  res.vary(HOST_DERIVED_VARY)
  let value = getCacheControl(options, category)
  if (value && !hostUrlsArePinned(publicUrl, allowedHosts)) {
    value = value.replace(/\bpublic\b/g, 'private')
    if (!/\b(private|no-store)\b/.test(value)) {
      value = `private, ${value}`
    }
  }
  value = capCacheControlToKeyExpiry(value, res)
  if (value) {
    res.set('Cache-Control', value)
  }
}
