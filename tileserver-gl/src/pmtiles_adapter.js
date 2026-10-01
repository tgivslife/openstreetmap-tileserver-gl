import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { EtagMismatch, FetchSource, PMTiles } from 'pmtiles'
import { isS3Url, isValidHttpUrl } from './utils.js'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { fromIni } from '@aws-sdk/credential-provider-ini'

/**
 * Reads a positive-integer env var, falling back to a default.
 * `min` guards the lower bound (timeouts allow 0 to disable; socket counts require >= 1).
 * @param {string} name - Environment variable name.
 * @param {number} def - Default when unset or invalid.
 * @param {number} [min] - Minimum accepted value.
 * @returns {number} - Parsed value or the default.
 */
function intEnv (name, def, min = 1) {
  // eslint-disable-next-line security/detect-object-injection -- name is an internal literal
  const v = parseInt(process.env[name], 10)
  return Number.isFinite(v) && v >= min ? v : def
}

/**
 * Reads a boolean env var (false/0/no/off => false), falling back to a default.
 * @param {string} name - Environment variable name.
 * @param {boolean} def - Default when unset or empty.
 * @returns {boolean} - Parsed boolean.
 */
function boolEnv (name, def) {
  // eslint-disable-next-line security/detect-object-injection -- name is an internal literal
  const v = process.env[name]
  if (v === undefined || v === '') return def
  return !/^(false|0|no|off)$/i.test(v.trim())
}

/**
 * Settles with a promise, or rejects with an AbortError as soon as the signal aborts, whichever comes first.
 * The promise is left running on abort (the signal is what cancels its work), and a later rejection from it is swallowed.
 * @param {Promise} promise - The operation to wait for.
 * @param {AbortSignal} [signal] - Signal that ends the wait early.
 * @returns {Promise} - The operation's result.
 */
function untilAborted (promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    // An Error named AbortError, as the AWS SDK rejects with, rather than the signal's DOMException reason.
    const onAbort = () => reject(Object.assign(new Error('Request aborted', { cause: signal.reason }), { name: 'AbortError' }))
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/**
 * S3 Source for PMTiles
 * Supports:
 * - AWS S3: s3://bucket-name/path/to/file.pmtiles
 * - S3-compatible with endpoint: s3://endpoint-url/bucket/path/to/file.pmtiles
 */
class S3Source {
  /**
   * Creates an S3Source instance.
   * @param {string} s3Url - The S3 URL in one of the supported formats.
   * @param {string} [s3Profile] - Optional AWS credential profile name from config.
   * @param {boolean} [configRequestPayer] - Optional flag from config for requester pays buckets.
   * @param {string} [configRegion] - Optional AWS region from config.
   * @param {string} [s3UrlFormat] - Optional S3 URL format from config: 'aws' or 'custom'.
   * @param {number} [verbose] - Verbosity level (1-3). 1=important, 2=detailed, 3=debug/all requests.
   */
  constructor (
    s3Url,
    s3Profile,
    configRequestPayer,
    configRegion,
    s3UrlFormat,
    verbose = false
  ) {
    const parsed = this.parseS3Url(s3Url, s3UrlFormat)
    this.bucket = parsed.bucket
    this.key = parsed.key
    this.endpoint = parsed.endpoint
    this.url = s3Url
    this.verbose = verbose

    // Apply configuration precedence: Config > URL > Default
    // Using || for strings (empty string = not set)
    // Using ?? for booleans (false is valid value)
    const profile = s3Profile || parsed.profile
    this.requestPayer = configRequestPayer ?? parsed.requestPayer
    this.region = configRegion || parsed.region

    // Log precedence decisions for debugging
    if (verbose >= 3) {
      console.log(`S3 config precedence for ${s3Url}:`)
      console.log(`  Profile: ${s3Profile ? 'config' : parsed.profile ? 'url' : 'default'} = ${profile || 'none'}`)
      console.log(`  Region: ${configRegion ? 'config' : parsed.region !== (process.env.AWS_REGION || 'us-east-1')
        ? 'url'
        : 'env/default'} = ${this.region}`)
      console.log(`  RequestPayer: ${configRequestPayer !== undefined ? 'config' : parsed.requestPayer
        ? 'url'
        : 'default'} = ${this.requestPayer}`)
    }

    // A deadline for each whole range read, enforced in getBytes rather than by the request handler: the handler's
    // requestTimeout only logs a warning (unless throwOnRequestTimeout) and stops at the response headers, so a
    // stalled endpoint or body would leave the tile request pending for good.
    this.requestTimeout = intEnv('TILESERVER_GL_S3_REQUEST_TIMEOUT_MS', 5000, 0)

    this.s3Client = this.createS3Client(parsed.endpoint, this.region, profile, this.verbose)
  }

  /**
   * Parses various S3 URL formats into bucket, key, endpoint, region, and profile.
   * @param {string} url - The S3 URL to parse.
   * @param {string} [s3UrlFormat] - Optional format override: 'aws' or 'custom'.
   * @returns {object} - An object containing bucket, key, endpoint, region, and profile.
   * @throws {Error} - Throws an error if the URL format is invalid.
   */
  parseS3Url (url, s3UrlFormat) {
    // Validate s3UrlFormat if provided
    if (s3UrlFormat && s3UrlFormat !== 'aws' && s3UrlFormat !== 'custom') {
      console.warn(`Invalid s3UrlFormat: "${s3UrlFormat}". Must be "aws" or "custom". Using auto-detection.`)
      s3UrlFormat = undefined
    }

    let region = process.env.AWS_REGION || 'us-east-1'
    let profile = null
    let requestPayer = false

    // s3+http:// and s3+https:// name a custom (S3-compatible) endpoint and pin its protocol; plain s3:// is AWS S3 over https.
    // Strip the prefix down to the s3:// the patterns below expect, keep the protocol for the endpoint URL, and treat it
    // as a custom endpoint (its host may carry a port and no dot, which auto-detection would otherwise mistake for a bucket name).
    let endpointProtocol = 'https'
    const schemeMatch = url.match(/^s3\+(https?):\/\//i)
    if (schemeMatch) {
      endpointProtocol = schemeMatch[1].toLowerCase()
      url = 's3://' + url.slice(schemeMatch[0].length)
      s3UrlFormat = 'custom'
    }

    // Parse URL parameters
    const [cleanUrl, queryString] = url.split('?')
    if (queryString) {
      const params = new URLSearchParams(queryString)
      // URL parameters override defaults
      profile = params.get('profile') ?? profile
      region = params.get('region') ?? region
      s3UrlFormat = s3UrlFormat ?? params.get('s3UrlFormat') // Config overrides URL

      const payerVal = params.get('requestPayer')
      requestPayer = payerVal === 'true' || payerVal === '1'
    }

    // Helper to build result object
    const buildResult = (endpoint, bucket, key) => ({
      endpoint: endpoint ? `${endpointProtocol}://${endpoint}` : null,
      bucket,
      key,
      region,
      profile,
      requestPayer
    })

    // Define patterns based on format
    const patterns = {
      customWithDot: /^s3:\/\/([^/]*\.[^/]+)\/([^/]+)\/(.+)$/, // Auto-detect: requires dot
      customForced: /^s3:\/\/([^/]+)\/([^/]+)\/(.+)$/, // Explicit: no dot required
      aws: /^s3:\/\/([^/]+)\/(.+)$/
    }

    // Match based on s3UrlFormat or auto-detect
    let match

    if (s3UrlFormat === 'custom') {
      match = cleanUrl.match(patterns.customForced)
      if (match) {
        return buildResult(match[1], match[2], match[3])
      }
    } else if (s3UrlFormat === 'aws') {
      match = cleanUrl.match(patterns.aws)
      if (match) {
        return buildResult(null, match[1], match[2])
      }
    } else {
      // Auto-detection: try custom (with dot) first, then AWS
      match = cleanUrl.match(patterns.customWithDot)
      if (match) {
        return buildResult(match[1], match[2], match[3])
      }

      match = cleanUrl.match(patterns.aws)
      if (match) {
        return buildResult(null, match[1], match[2])
      }
    }

    throw new Error(
      `Invalid S3 URL format: ${url}\n` +
      `Expected formats:\n` +
      `  AWS S3: s3://bucket-name/path/to/file.pmtiles\n` +
      `  Custom endpoint: s3://endpoint.com/bucket/path/to/file.pmtiles\n` +
      `Use s3UrlFormat parameter to override auto-detection if needed.`
    )
  }

  /**
   * Creates an S3 client with optional custom endpoint and AWS profile support.
   * @param {string|null} endpoint - The custom endpoint URL, or null for default AWS S3.
   * @param {string} region - The AWS region.
   * @param {string} [profile] - Optional AWS credential profile name.
   * @param {number} [verbose] - Verbosity level (1-3). 1=important, 2=detailed, 3=debug/all requests.
   * @returns {S3Client} - Configured S3Client instance.
   */
  createS3Client (endpoint, region, profile, verbose) {
    // Connection pool + timeouts, all env-tunable.
    // The AWS SDK's default agent caps concurrent connections at 50 sockets, which throttles many parallel
    // tile range-GETs under load; raise TILESERVER_GL_S3_MAX_SOCKETS to widen it.
    const maxSockets = intEnv('TILESERVER_GL_S3_MAX_SOCKETS', 256)
    const keepAlive = boolEnv('TILESERVER_GL_S3_KEEP_ALIVE', true)
    const connectionTimeout = intEnv(
      'TILESERVER_GL_S3_CONNECTION_TIMEOUT_MS',
      5000,
      0
    )

    if (verbose >= 2) {
      console.log(
        `S3 client pool: maxSockets=${maxSockets} keepAlive=${keepAlive} ` +
        `connectionTimeout=${connectionTimeout}ms requestTimeout=${this.requestTimeout}ms`
      )
    }

    const config = {
      region: region,
      requestHandler: {
        connectionTimeout,
        httpAgent: new http.Agent({ keepAlive, maxSockets }),
        httpsAgent: new https.Agent({ keepAlive, maxSockets })
      },
      forcePathStyle: !!endpoint
    }

    if (endpoint) {
      config.endpoint = endpoint
      if (verbose >= 2) {
        console.log(`Using custom S3 endpoint: ${endpoint}`)
      }
    }

    if (profile) {
      config.credentials = fromIni({ profile })
      if (verbose >= 2) {
        console.log(`Using AWS profile: ${profile}`)
      }
    }

    return new S3Client(config)
  }

  /**
   * Returns the unique key for this S3 source.
   * @returns {string} - The S3 URL.
   */
  getKey () {
    return this.url
  }

  /**
   * Destroys the S3 client, closing its keep-alive sockets. Called by clearPMtilesCache on reload, once the old server has
   * finished its requests; without it every reload left the previous client's connection pool open.
   * @returns {void}
   */
  close () {
    this.s3Client.destroy()
  }

  /**
   * Fetches a byte range from the S3 object.
   * @param {number} offset - The starting byte offset.
   * @param {number} length - The number of bytes to fetch.
   * @param {AbortSignal} [signal] - Optional abort signal for cancelling the request.
   * @param {string} [etag] - Optional ETag for conditional requests.
   * @returns {Promise<object>} - A promise that resolves to an object containing data, etag, expires, and cacheControl.
   * @throws {EtagMismatch} - Throws if ETag doesn't match.
   * @throws {Error} - Throws on S3 errors like NoSuchKey, AccessDenied, NoSuchBucket.
   */
  async getBytes (offset, length, signal, etag) {
    // Covers connect, headers, SDK retries and the body read alike; aborting also destroys a body mid-stream.
    const deadline = this.requestTimeout ? AbortSignal.timeout(this.requestTimeout) : undefined
    const abortSignal = signal && deadline ? AbortSignal.any([signal, deadline]) : signal ?? deadline

    try {
      const commandParams = {
        Bucket: this.bucket,
        Key: this.key,
        Range: `bytes=${offset}-${offset + length - 1}`,
        IfMatch: etag
      }

      if (this.requestPayer) {
        commandParams.RequestPayer = 'requester'
      }

      const command = new GetObjectCommand(commandParams)

      // The signal cancels the network activity, but not the SDK's retry backoff (a Retry-After can outlast the deadline),
      // so the whole send and body read is also raced against it.
      const { response, arr } = await untilAborted(
        (async () => {
          const response = await this.s3Client.send(command, { abortSignal })
          return { response, arr: await response.Body.transformToByteArray() }
        })(),
        abortSignal
      )

      if (!arr) {
        throw new Error('Failed to read S3 response body')
      }

      return {
        // Slice to the view's own range: arr is a Uint8Array that may be a view into a larger pooled buffer,
        // so arr.buffer alone could carry extra bytes and misparse the archive. Mirrors PMTilesFileSource.getBytes.
        data: arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength),
        etag: response.ETag,
        expires: response.Expires?.toISOString(),
        cacheControl: response.CacheControl
      }
    } catch (error) {
      if (deadline?.aborted && !signal?.aborted) {
        throw Object.assign(
          new Error(`S3 read of ${this.bucket}/${this.key} timed out after ${this.requestTimeout}ms`, { cause: error }),
          { name: 'TimeoutError' }
        )
      }

      // Handle AWS SDK errors
      if (error.name === 'PreconditionFailed') {
        throw new EtagMismatch()
      }

      if (error.name === 'NoSuchKey') {
        throw new Error(`PMTiles file not found: ${this.bucket}/${this.key}`, {
          cause: error
        })
      }

      if (error.name === 'AccessDenied') {
        throw new Error(
          `Access denied: ${this.bucket}/${this.key}. Check credentials and bucket permissions.`,
          { cause: error }
        )
      }

      if (error.name === 'NoSuchBucket') {
        throw new Error(
          `Bucket not found: ${this.bucket}. Check bucket name and endpoint.`,
          { cause: error }
        )
      }

      console.error(`S3 error for ${this.bucket}/${this.key}:`, error.message)
      throw error
    }
  }
}

/**
 * Local file source for PMTiles using Node.js file descriptors.
 */
class PMTilesFileSource {
  /**
   * Creates a PMTilesFileSource instance.
   * @param {number} fd - The file descriptor for the opened PMTiles file.
   */
  constructor (fd) {
    this.fd = fd
  }

  /**
   * Returns the unique key for this file source.
   * @returns {number} - The file descriptor.
   */
  getKey () {
    return this.fd
  }

  /**
   * Reads a byte range from the local file.
   * @param {number} offset - The starting byte offset.
   * @param {number} length - The number of bytes to read.
   * @returns {Promise<object>} - A promise that resolves to an object containing the data as an ArrayBuffer.
   */
  async getBytes (offset, length) {
    const buffer = Buffer.alloc(length)
    await readFileBytes(this.fd, buffer, offset)
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    )
    return { data: ab }
  }

  /**
   * Closes the underlying file descriptor for local PMTiles sources.
   * @returns {void}
   */
  close () {
    if (typeof this.fd === 'number') {
      const fd = this.fd
      try {
        fs.closeSync(fd)
      } catch (err) {
        console.warn(`Failed to close PMTiles file descriptor ${fd}:`, err)
      } finally {
        this.fd = null
      }
    }
  }
}

/**
 * Reads bytes from a file descriptor into a buffer.
 * @param {number} fd - The file descriptor.
 * @param {Buffer} buffer - The buffer to read data into.
 * @param {number} offset - The file offset to start reading from.
 * @returns {Promise<void>} - A promise that resolves when the read operation completes.
 */
async function readFileBytes (fd, buffer, offset) {
  return new Promise((resolve, reject) => {
    fs.read(fd, buffer, 0, buffer.length, offset, (err) => {
      if (err) {
        return reject(err)
      }
      resolve()
    })
  })
}

// Cache for PMTiles objects to avoid creating multiple instances for the same URL
const pmtilesCache = new Map()

/**
 * Closes a PMTiles instance if it owns a closeable local file source.
 * @param {PMTiles} pmtiles - The PMTiles instance to close.
 * @returns {void}
 */
function closePMTiles (pmtiles) {
  if (!pmtiles) {
    return
  }

  const source = pmtiles.source
  if (source && typeof source.close === 'function') {
    source.close()
  }
}

/**
 * Opens a PMTiles file from local filesystem, HTTP URL, or S3 URL.
 * Uses caching to avoid creating multiple PMTiles instances for the same file.
 * @param {string} filePath - The path to the PMTiles file.
 * @param {string} [s3Profile] - Optional AWS credential profile name.
 * @param {boolean} [requestPayer] - Optional flag for requester pays buckets.
 * @param {string} [s3Region] - Optional AWS region.
 * @param {string} [s3UrlFormat] - Optional S3 URL format: 'aws' or 'custom'.
 * @param {number} [verbose] - Verbosity level (1-3). 1=important, 2=detailed, 3=debug/all requests.
 * @returns {PMTiles} - A PMTiles instance.
 */
export function openPMtiles (
  filePath,
  s3Profile,
  requestPayer,
  s3Region,
  s3UrlFormat,
  verbose = 0
) {
  // Create a cache key that includes all parameters that affect the source
  const cacheKey = JSON.stringify({
    filePath,
    s3Profile,
    requestPayer,
    s3Region,
    s3UrlFormat
  })

  if (pmtilesCache.has(cacheKey)) {
    if (verbose >= 2) {
      console.log(`Using cached PMTiles instance for: ${filePath}`)
    }
    return pmtilesCache.get(cacheKey)
  }

  let pmtiles

  if (isS3Url(filePath)) {
    if (verbose >= 2) {
      console.log(`Opening PMTiles from S3: ${filePath}`)
    }
    const source = new S3Source(
      filePath,
      s3Profile,
      requestPayer,
      s3Region,
      s3UrlFormat,
      verbose
    )
    pmtiles = new PMTiles(source)
  } else if (isValidHttpUrl(filePath)) {
    if (verbose >= 2) {
      console.log(`Opening PMTiles from HTTP: ${filePath}`)
    }
    const source = new FetchSource(filePath)
    pmtiles = new PMTiles(source)
  } else {
    if (verbose >= 2) {
      console.log(`Opening PMTiles from local file: ${filePath}`)
    }

    const fd = fs.openSync(filePath, 'r')
    const source = new PMTilesFileSource(fd)
    pmtiles = new PMTiles(source)
  }

  // Cache the PMTiles object
  pmtilesCache.set(cacheKey, pmtiles)

  return pmtiles
}

/**
 * Clears the PMTiles cache and closes what cached sources own: local file descriptors and S3 clients with their sockets.
 * @returns {void}
 */
export function clearPMtilesCache () {
  for (const pmtiles of pmtilesCache.values()) {
    closePMTiles(pmtiles)
  }
  pmtilesCache.clear()
}

/**
 * Whether an error represents throttling / transient overload that should be retried.
 * S3 throttling surfaces as HTTP 503 "SlowDown" or a ThrottlingException (and S3-compatible stores vary),
 * not only HTTP 429 — so match the SDK error name and status code as well as the message text, rather than just "429".
 * @param {Error} error - The caught error (raw AWS SDK error or a wrapped one).
 * @returns {boolean} - True if the request should be retried.
 */
export function isThrottleError (error) {
  if (!error) return false
  const status = error.$metadata?.httpStatusCode
  if (status === 429 || status === 503) return true
  const name = error.name || error.Code || error.code
  if (typeof name === 'string' &&
    /^(SlowDown|Throttling|ThrottlingException|RequestThrottled|RequestThrottledException|TooManyRequestsException|ProvisionedThroughputExceededException|RequestLimitExceeded|BandwidthLimitExceeded|PriorityConsumerQuotaExceeded|ServiceUnavailable)$/.test(name)) {
    return true
  }
  const msg = error.message || ''
  return (
    // Match 429/503 only where it reads as an HTTP status, not an arbitrary number that merely contains those digits
    // (e.g. a byte-range like "bytes=429-1000"). The status-code/name checks above are the primary path.
    /\b(?:http|status|code)\b[^0-9]{0,12}\b(?:429|503)\b/i.test(msg) ||
    /\b(?:429|503)\b\s+(?:too many|slow ?down|service unavailable)/i.test(msg) ||
    /Bad response code:\s*(?:429|503)/.test(msg) ||
    /SlowDown|Throttl|TooManyRequests|Rate exceeded|ServiceUnavailable/i.test(msg)
  )
}

/**
 * Retrieves metadata and header information from a PMTiles archive with retry logic for rate limiting.
 * @param {PMTiles} pmtiles - The PMTiles instance.
 * @param {string} inputFile - The input file path (used for error messages).
 * @param {number} [maxRetries] - Maximum number of retry attempts for rate-limited requests.
 * @returns {Promise<object>} - A promise that resolves to a metadata object containing format, bounds, zoom levels, and center.
 * @throws {Error} - Throws an error if metadata cannot be retrieved after all retry attempts.
 */
export async function getPMtilesInfo (pmtiles, inputFile, maxRetries = 3) {
  let lastError

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const header = await pmtiles.getHeader()
      const metadata = await pmtiles.getMetadata()

      metadata['format'] = getPmtilesTileType(header.tileType).type
      metadata['minzoom'] = header.minZoom
      metadata['maxzoom'] = header.maxZoom

      // Check if bounds are defined (handles null, undefined, but allows 0)
      const hasBounds =
        typeof header.minLon === 'number' &&
        typeof header.minLat === 'number' &&
        typeof header.maxLon === 'number' &&
        typeof header.maxLat === 'number' &&
        !(
          header.minLon === 0 &&
          header.minLat === 0 &&
          header.maxLon === 0 &&
          header.maxLat === 0
        )

      if (hasBounds) {
        metadata['bounds'] = [
          header.minLon,
          header.minLat,
          header.maxLon,
          header.maxLat
        ]
      } else {
        metadata['bounds'] = [-180, -85.05112877980659, 180, 85.0511287798066]
      }

      if (header.centerZoom) {
        metadata['center'] = [
          header.centerLon,
          header.centerLat,
          header.centerZoom
        ]
      } else {
        metadata['center'] = [
          header.centerLon,
          header.centerLat,
          parseInt(metadata['maxzoom']) / 2
        ]
      }

      return metadata
    } catch (error) {
      lastError = error

      if (isThrottleError(error) && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000
        console.warn(
          `Rate limited fetching metadata, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }

      // Not throttling, or the last retry: throw immediately.
      if (!isThrottleError(error) || attempt === maxRetries - 1) {
        const errorMessage = `${error.message} for file: ${inputFile}`
        throw new Error(errorMessage, { cause: error })
      }
    }
  }

  // This should never be reached, but just in case
  throw new Error(`Failed to get PMTiles info after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`)
}

/**
 * Fetches a tile from a PMTiles archive with retry logic for rate limiting and error handling.
 * @param {PMTiles} pmtiles - The PMTiles instance.
 * @param {number} z - The zoom level.
 * @param {number} x - The x coordinate of the tile.
 * @param {number} y - The y coordinate of the tile.
 * @param {number} [maxRetries] - Maximum number of retry attempts for rate-limited requests.
 * @returns {Promise<object>} - A promise that resolves to an object with data (Buffer or undefined) and header (content-type).
 */
export async function getPMtilesTile (pmtiles, z, x, y, maxRetries = 3) {
  // Declared outside the loop but fetched inside it, so a throttle on the header fetch is retried too (consistent with getPMtilesInfo).
  // The PMTiles library caches the header after the first read, so re-calling it is a no-op on retry.
  let tileType

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const header = await pmtiles.getHeader()
      tileType = getPmtilesTileType(header.tileType)

      let zxyTile = await pmtiles.getZxy(z, x, y)

      if (zxyTile && zxyTile.data) {
        zxyTile = Buffer.from(zxyTile.data)
      } else {
        zxyTile = undefined
      }

      return { data: zxyTile, header: tileType.header }
    } catch (error) {
      if (isThrottleError(error) && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000
        console.warn(`Rate limited for tile ${z}/${x}/${y}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`)
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }

      // Every failure is thrown, including an HTTP archive's "Bad response code:": an absent tile is getZxy returning no data,
      // so answering a failure as no data would serve a storage outage as empty geography.
      throw error
    }
  }

  // Unreachable while maxRetries >= 1: the last attempt returns or throws.
  throw new Error(`Failed to fetch tile ${z}/${x}/${y} after ${maxRetries} attempts`)
}

/**
 * Maps PMTiles tile type number to tile format string and Content-Type header.
 * @param {number} typenum - The PMTiles tile type number (0=Unknown, 1=MVT/PBF, 2=PNG, 3=JPEG, 4=WebP, 5=AVIF).
 * @returns {object} - An object containing type (string) and header (object with Content-Type).
 */
function getPmtilesTileType (typenum) {
  let head = {}
  let tileType
  switch (typenum) {
    case 0:
      tileType = 'Unknown'
      break
    case 1:
      tileType = 'pbf'
      head['Content-Type'] = 'application/x-protobuf'
      break
    case 2:
      tileType = 'png'
      head['Content-Type'] = 'image/png'
      break
    case 3:
      tileType = 'jpeg'
      head['Content-Type'] = 'image/jpeg'
      break
    case 4:
      tileType = 'webp'
      head['Content-Type'] = 'image/webp'
      break
    case 5:
      tileType = 'avif'
      head['Content-Type'] = 'image/avif'
      break
  }
  return { type: tileType, header: head }
}
