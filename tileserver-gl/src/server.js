#!/usr/bin/env node
'use strict'

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'path'
import fnv1a from '@sindresorhus/fnv1a'
import chokidar from 'chokidar'
import clone from 'clone'
import cors from 'cors'
import enableShutdown from 'http-shutdown'
import express from 'express'
import handlebars from 'handlebars'
import { SphericalMercator } from '@mapbox/sphericalmercator'
import morgan from 'morgan'
import { serve_data } from './serve_data.js'
import { serve_style } from './serve_style.js'
import { serve_font } from './serve_font.js'
import { clearPMtilesCache } from './pmtiles_adapter.js'
import {
  allowedTileSizes,
  getCacheControl,
  getPublicUrl,
  getTileUrls,
  isValidHttpUrl,
  isValidRemoteUrl,
  setCacheControl,
  setHostDerivedCacheControl
} from './utils.js'

import { fileURLToPath } from 'url'

const mercator = new SphericalMercator()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(
  fs.readFileSync(__dirname + '/../package.json', 'utf8')
)
const isLight = packageJson.name.slice(-6) === '-light'

const { serve_rendered } = await import(
  `${!isLight ? `./serve_rendered.js` : `./serve_light.js`}`
  )

/**
 *  Starts the server.
 * @param {object} opts - Configuration options for the server.
 * @returns {Promise<object>} - A promise that resolves to the server object.
 */
async function start (opts) {
  let metricsModule = null
  console.log('Starting server')

  const app = express().disable('x-powered-by')
  const serving = {
    styles: {},
    rendered: {},
    data: {},
    fonts: {}
  }
  let cleanup = async () => {}

  app.enable('trust proxy')

  // Import metrics module early if enabled, so middleware doesn't miss requests
  if (opts.metrics) {
    try {
      const m = await import('./metrics.js')
      metricsModule = m
    } catch (err) {
      console.warn(`[metrics] Failed to import metrics module: ${err.message}`)
    }
  }

  // Prometheus HTTP metrics middleware. Gated on metricsModule too: if the import above failed, registering it would deref null on every request.
  if (opts.metrics && metricsModule) {
    app.use((req, res, next) => {
      const start = process.hrtime.bigint()
      res.on('finish', () => {
        const route = req.route?.path ?? '<unknown>'
        const durationSec = Number(process.hrtime.bigint() - start) / 1e9
        metricsModule.httpRequestsTotal.inc({ method: req.method, route, status_code: String(res.statusCode) })
        metricsModule.httpRequestDuration.observe({
          method: req.method,
          route,
          status_code: String(res.statusCode)
        }, durationSec)
      })
      next()
    })
  }

  // Captured so reload() can close it; otherwise each restart opens a new file descriptor for --log_file and leaks the previous one.
  let accessLogStream = null
  if (process.env.NODE_ENV !== 'test') {
    // Redact ?key= / &key= from the logged URL so API keys and tokens, which travel in the query string, are not written to the access log.
    // Overriding the built-in :url token covers every format (tiny/dev/combined/custom).
    morgan.token('url', (req) =>
      (req.originalUrl || req.url).replace(
        /([?&]key=)[^&]*/gi,
        '$1[REDACTED]'
      )
    )
    const defaultLogFormat = process.env.NODE_ENV === 'production' ? 'tiny' : 'dev'
    const logFormat = opts.logFormat || defaultLogFormat
    if (opts.logFile) {
      accessLogStream = fs.createWriteStream(opts.logFile, { flags: 'a' })
    }
    app.use(
      morgan(logFormat, {
        stream: accessLogStream || process.stdout,
        skip: (req, res) =>
          opts.silent && (res.statusCode === 200 || res.statusCode === 304)
      })
    )
  }

  // Optional API-key / TTL-token gate, enabled by env; off (no middleware) when unset. See docs/2.USAGE.md for the env vars and token format.
  const apiKeys = (process.env.TILESERVER_GL_API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean)
  const tokenSecret = process.env.TILESERVER_GL_TOKEN_SECRET || ''
  const parsedMaxTtl = parseInt(process.env.TILESERVER_GL_TOKEN_MAX_TTL || '', 10)
  const tokenMaxTtl = Number.isFinite(parsedMaxTtl) && parsedMaxTtl > 0 ? parsedMaxTtl : 604800 // 7d
  const allowedOrigins = (process.env.TILESERVER_GL_ALLOWED_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean)

  // Mounted before the auth gate so 403s still carry CORS headers (browser can read the status) and keyless OPTIONS preflights are answered here.
  // An Origin allowlist reflects only those origins instead of the default *.
  if (opts.cors) {
    app.use(
      cors(allowedOrigins.length ? { origin: allowedOrigins } : undefined)
    )
  }

  if (apiKeys.length || tokenSecret) {
    // Constant-time compare. Hash both sides to a fixed 32-byte digest first: timingSafeEqual throws on unequal lengths,
    // and the candidate is arbitrary attacker-controlled bytes.
    // Hashing also drops the length-dependent early return that would leak via timing.
    const equal = (a, b) => {
      const ha = crypto.createHash('sha256').update(a, 'utf8').digest()
      const hb = crypto.createHash('sha256').update(b, 'utf8').digest()
      return crypto.timingSafeEqual(ha, hb)
    }

    // Exempt the static viewer chrome in public/resources (bundles, webfonts, images, favicon, index.css),
    // it's pulled by CSS url()/<img>/favicon requests that can't carry ?key=, so gating it breaks the viewer.
    const publicAssets = new Set()
    const assetRoot = path.join(__dirname, '../public/resources')
    const walkAssets = (dir, urlPrefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const url = `${urlPrefix}/${entry.name}`
        if (entry.isDirectory()) {
          walkAssets(path.join(dir, entry.name), url)
        } else {
          publicAssets.add(url)
        }
      }
    }
    try {
      walkAssets(assetRoot, '')
    } catch {
      // resources dir absent (e.g. `npm run prepare` not run): nothing to exempt
    }

    /**
     * Validates an expiring token of the form "<expiry>.<signature>".
     * @param {string} candidate - Value of the key query parameter.
     * @returns {boolean} - True when the signature matches and is not expired.
     */
    const isValidToken = (candidate) => {
      const dot = candidate.indexOf('.')
      if (dot < 1) {
        return false
      }
      const expiry = candidate.slice(0, dot)
      const signature = candidate.slice(dot + 1)
      if (!/^\d+$/.test(expiry)) {
        return false
      }
      // Reject expired tokens and — as a sanity ceiling — any expiry beyond the
      // max TTL. The finite check matters: a long digit string parses to
      // Infinity, which would otherwise never look expired (permanent token).
      const nowSec = Date.now() / 1000
      const expirySec = Number(expiry)
      if (!Number.isFinite(expirySec) ||
        expirySec < nowSec ||
        expirySec > nowSec + tokenMaxTtl
      ) {
        return false
      }
      const expected = crypto.createHmac('sha256', tokenSecret).update(expiry).digest('hex')
      return equal(signature, expected)
    }

    app.use((req, res, next) => {
      if (req.path === '/health') {
        return next()
      }
      if (publicAssets.has(req.path)) {
        return next()
      }
      const candidate = typeof req.query.key === 'string' ? req.query.key : ''
      const keyOk = (candidate !== '' && apiKeys.some((k) => equal(k, candidate))) ||
        (tokenSecret !== '' && candidate !== '' && isValidToken(candidate))
      if (!keyOk) {
        return res.status(403).send('Forbidden')
      }
      if (allowedOrigins.length) {
        // Hotlink deterrence (not auth). Use the unforgeable Origin, falling back to the Referer's origin since resource loads (<img>, CSS url()) send only Referer.
        // Neither header = non-browser client, passes on the key; a page with Referrer-Policy: no-referrer also sends neither.
        const originHeader = req.get('Origin')
        let claimed = null
        if (originHeader) {
          claimed = originHeader.replace(/\/$/, '')
        } else {
          const referer = req.get('Referer')
          if (referer) {
            try {
              claimed = new URL(referer).origin
            } catch {
              claimed = referer // unparseable → cannot match → rejected below
            }
          }
        }
        // Always allow the server's own origin: same-origin requests (the built-in viewer's style.json, tiles, sprites, glyphs) send a Referer
        // pointing here, which is not in the app-origin allowlist. Safe — a spoofed Host gets no more than sending no Referer already does.
        const selfOrigin = `${req.protocol}://${req.get('host')}`
        if (
          claimed &&
          claimed !== selfOrigin &&
          !allowedOrigins.includes(claimed)
        ) {
          return res.status(403).send('Forbidden')
        }
      }
      return next()
    })
  }

  // Expand ${VAR} / ${VAR:-default} from the environment in every string value, so a baked or committed config.json can point at per-deployment values
  // (e.g. an S3 URL or region) without editing the file. `:-` falls back when a variable is unset or empty (like the shell);
  // a ${VAR} with no default is required: an unset or empty one is collected in missingEnvVars and aborts startup below.
  const missingEnvVars = new Set()
  const interpolateEnv = (value) => {
    if (typeof value === 'string') {
      return value.replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
        (match, name, fallback) => {
          const v = process.env[name]
          if (v !== undefined && v !== '') {
            return v
          }
          if (fallback !== undefined) {
            return fallback
          }
          missingEnvVars.add(name)
          return match
        }
      )
    }
    if (Array.isArray(value)) {
      return value.map(interpolateEnv)
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v)]))
    }
    return value
  }

  let config = opts.config || null
  let configPath = null
  if (opts.configPath) {
    configPath = path.resolve(opts.configPath)
    try {
      config = interpolateEnv(JSON.parse(fs.readFileSync(configPath, 'utf8')))
    } catch {
      console.log('ERROR: Config file not found or invalid!')
      console.log('   See README.md for instructions and sample data.')
      process.exit(1)
    }
    // Fail here, naming the variables, rather than later with an error about a literal "${VAR}" path or URL.
    if (missingEnvVars.size > 0) {
      console.log(`ERROR: Config file references environment variable(s) that are not set: ${[...missingEnvVars].join(', ')}`)
      console.log('   Set them, or give each a default with ${VAR:-default}.')
      process.exit(1)
    }
  }
  if (!config) {
    console.log('ERROR: No config file not specified!')
    process.exit(1)
  }

  const options = config.options || {}
  const paths = options.paths || {}
  options.paths = paths
  paths.root = path.resolve(configPath ? path.dirname(configPath) : process.cwd(), paths.root || '')
  paths.styles = path.resolve(paths.root, paths.styles || '')
  paths.fonts = path.resolve(paths.root, paths.fonts || '')
  paths.sprites = path.resolve(paths.root, paths.sprites || '')
  paths.mbtiles = path.resolve(paths.root, paths.mbtiles || '')
  paths.pmtiles = path.resolve(paths.root, paths.pmtiles || '')
  paths.icons = paths.icons ? path.resolve(paths.root, paths.icons) : path.resolve(__dirname, '../public/resources/images')
  paths.files = paths.files ? path.resolve(paths.root, paths.files) : path.resolve(__dirname, '../public/files')

  const startupPromises = []

  for (const type of Object.keys(paths)) {
    // eslint-disable-next-line security/detect-object-injection -- paths[type] constructed from validated config paths
    if (!fs.existsSync(paths[type])) {
      // eslint-disable-next-line security/detect-object-injection -- type is from Object.keys of paths config
      console.error(`The specified path for "${type}" does not exist (${paths[type]}).`)
      process.exit(1)
    }
  }

  /**
   * Recursively get all files within a directory.
   * Inspired by https://stackoverflow.com/a/45130990/10133863
   * @param {string} directory Absolute path to a directory to get files from.
   * @returns {Promise<string[]>} - A promise that resolves to an array of file paths relative to the icon directory.
   */
  async function getFiles (directory) {
    // Fetch all entries of the directory and attach type information

    const dirEntries = await fs.promises.readdir(directory, {
      withFileTypes: true
    })

    // Iterate through entries and return the relative file-path to the icon directory if it is not a directory
    // otherwise initiate a recursive call
    const files = await Promise.all(
      dirEntries.map((dirEntry) => {
        const entryPath = path.resolve(directory, dirEntry.name)
        return dirEntry.isDirectory() ? getFiles(entryPath) : entryPath.replace(paths.icons + path.sep, '')
      })
    )

    // Flatten the list of files to a single array
    return files.flat()
  }

  // Load all available icons into a settings object
  startupPromises.push(
    getFiles(paths.icons).then((files) => {
      paths.availableIcons = files
    })
  )

  if (options.dataDecorator) {
    try {
      const dataDecoratorPath = path.resolve(paths.root, options.dataDecorator)

      const module = await import(dataDecoratorPath)
      options.dataDecoratorFunc = module.default
    } catch (e) {
      console.error(`Error loading data decorator: ${e}`)
      // Intentionally don't set options.dataDecoratorFunc - let it remain undefined
    }
  }

  const data = clone(config.data || {})

  // Shared by the two express.static mounts below.
  const staticCacheControl = getCacheControl(options, 'static')
  const staticOptions = staticCacheControl
    ? {
      setHeaders: (staticRes) =>
        staticRes.set('Cache-Control', staticCacheControl)
    }
    : {}

  app.use('/data/', serve_data.init(options, serving.data, opts))
  app.use('/files/', express.static(paths.files, staticOptions))
  app.use('/styles/', serve_style.init(options, serving.styles, opts))
  if (!isLight) {
    startupPromises.push(
      serve_rendered.init(options, serving.rendered, opts).then((sub) => {app.use('/styles/', sub)})
    )
  }

  /**
   * Adds a style to the server.
   * @param {string} id - The ID of the style.
   * @param {object} item - The style configuration object.
   * @param {boolean} allowMoreData - Whether to allow adding more data sources.
   * @param {boolean} reportFonts - Whether to report fonts.
   * @returns {Promise<boolean>} - Returns true if successful, false otherwise.
   */
  async function addStyle (id, item, allowMoreData, reportFonts) {
    let success = true

    let styleJSON
    try {
      // Style files should only be HTTP/HTTPS, not S3
      if (isValidHttpUrl(item.style)) {
        const res = await fetch(item.style)
        if (!res.ok) {
          throw new Error(`fetch error ${res.status}`)
        }
        styleJSON = await res.json()
      } else {
        const styleFile = path.resolve(options.paths.styles, item.style)

        const styleFileData = await fs.promises.readFile(styleFile)
        styleJSON = JSON.parse(styleFileData)
      }
    } catch (err) {
      console.log(`Error getting style file "${item.style}"`)
      console.error(err && err.stack ? err.stack : err)
      return false
    }

    if (item.serve_data !== false) {
      success = serve_style.add(
        options,
        serving.styles,
        item,
        id,
        opts,
        styleJSON,
        (styleSourceId, protocol) => {
          let dataItemId
          for (const id of Object.keys(data)) {
            if (id === styleSourceId) {
              // Style id was found in data ids, return that id
              dataItemId = id
              break
            } else {
              // eslint-disable-next-line security/detect-object-injection -- id is from Object.keys of data config
              const sourceData = data[id]

              if (
                (sourceData.pmtiles && sourceData.pmtiles === styleSourceId) ||
                (sourceData.mbtiles && sourceData.mbtiles === styleSourceId)
              ) {
                dataItemId = id
                break
              }
            }
          }
          if (dataItemId) {
            // Data source exists in config, now validate file exists
            // eslint-disable-next-line security/detect-object-injection -- dataItemId is validated above
            const dataSource = data[dataItemId]
            const fileType = dataSource.pmtiles ? 'pmtiles' : 'mbtiles'
            // eslint-disable-next-line security/detect-object-injection -- fileType is either 'pmtiles' or 'mbtiles'
            const fileName = dataSource[fileType]

            // Skip validation for remote URLs
            if (fileName && !isValidRemoteUrl(fileName)) {
              // eslint-disable-next-line security/detect-object-injection -- fileType is either 'pmtiles' or 'mbtiles'
              const filePath = path.resolve(options.paths[fileType], fileName)
              try {
                const stats = fs.statSync(filePath)
                if (!stats.isFile() || stats.size === 0) {
                  if (opts.ignoreMissingFiles) {
                    // File doesn't exist or is empty - return undefined to skip
                    return undefined
                  }
                  // File missing but flag not set - let it fail later
                  return dataItemId
                }
              } catch (_err) {
                // File doesn't exist
                if (opts.ignoreMissingFiles) {
                  return undefined
                }
                // File missing but flag not set - let it fail later
                return dataItemId
              }
            }

            // File exists or is remote URL, return the id
            return dataItemId
          } else {
            if (!allowMoreData) {
              console.log(`ERROR: style "${item.style}" using unknown file "${styleSourceId}"! Skipping...`)
              return undefined
            } else {
              let id =
                styleSourceId.substr(0, styleSourceId.lastIndexOf('.')) || styleSourceId
              // PMTiles can be remote URLs (HTTP or S3), generate unique ID for remote sources
              if (isValidRemoteUrl(styleSourceId)) {
                id = fnv1a(styleSourceId) + '_' + id.replace(/^.*\/(.*)$/, '$1')
              } else {
                try {
                  const stats = fs.statSync(styleSourceId)
                  if (!stats.isFile() || stats.size === 0) {
                    if (opts.ignoreMissingFiles) {
                      // File doesn't exist or is empty - return undefined to skip
                      return undefined
                    }
                  }
                } catch (_err) {
                  // File doesn't exist
                  if (opts.ignoreMissingFiles) {
                    return undefined
                  }
                }
              }
              // eslint-disable-next-line security/detect-object-injection -- id is being checked for existence before modification
              while (data[id]) {
                // if the data source id already exists, add a "_" untill it doesn't
                id += '_'
              }
              // Add the new data source to the data array.
              // eslint-disable-next-line security/detect-object-injection -- id is constructed above to be unique
              data[id] = { [protocol]: styleSourceId }

              return id
            }
          }
        },
        (font) => {
          if (reportFonts) {
            // eslint-disable-next-line security/detect-object-injection -- font is font name from style
            serving.fonts[font] = true
          }
        }
      )
    }
    if (success && item.serve_rendered !== false) {
      if (!isLight) {
        await serve_rendered.add(
          options,
          serving.rendered,
          item,
          id,
          opts,
          styleJSON,
          function dataResolver (styleSourceId) {
            let resolvedFileType
            let resolvedInputFile
            let resolvedS3Profile
            let resolvedRequestPayer
            let resolvedS3Region
            let resolvedS3UrlFormat
            let resolvedSparse

            // Debug logging to see what we're trying to match
            if (opts.verbose >= 3) {
              console.log(`[dataResolver] Looking for styleSourceId: ${styleSourceId}`)
              console.log(`[dataResolver] Available data keys: ${Object.keys(data).join(', ')}`)
            }

            for (const id of Object.keys(data)) {
              // eslint-disable-next-line security/detect-object-injection -- id is from Object.keys of data config
              const sourceData = data[id]
              let currentFileType
              let currentInputFileValue

              // Check for recognized file type keys
              if (Object.hasOwn(sourceData, 'pmtiles')) {
                currentFileType = 'pmtiles'
                currentInputFileValue = sourceData.pmtiles
              } else if (Object.hasOwn(sourceData, 'mbtiles')) {
                currentFileType = 'mbtiles'
                currentInputFileValue = sourceData.mbtiles
              }

              if (currentFileType && currentInputFileValue) {
                // Debug logging
                if (opts.verbose >= 3) {
                  console.log(`[dataResolver] Checking id="${id}", file="${currentInputFileValue}"`)
                }

                // Check if this source matches the styleSourceId
                // Match by ID, by file path, or by base filename
                const matchById = styleSourceId === id
                const matchByFile = styleSourceId === currentInputFileValue
                const matchByBasename = styleSourceId.includes(currentInputFileValue) || currentInputFileValue.includes(styleSourceId)

                if (matchById || matchByFile || matchByBasename) {
                  if (opts.verbose >= 2) {
                    console.log(`[dataResolver] Match found for styleSourceId: ${styleSourceId}. (byId=${matchById}, byFile=${matchByFile}, byBasename=${matchByBasename})`)
                  }

                  resolvedFileType = currentFileType
                  resolvedInputFile = currentInputFileValue

                  // Get s3Profile if present
                  if (Object.hasOwn(sourceData, 's3Profile')) {
                    resolvedS3Profile = sourceData.s3Profile
                  }

                  // Get s3UrlFormat if present
                  if (Object.hasOwn(sourceData, 's3UrlFormat')) {
                    resolvedS3UrlFormat = sourceData.s3UrlFormat
                  }

                  // Get requestPayer if present
                  if (Object.hasOwn(sourceData, 'requestPayer')) {
                    resolvedRequestPayer = !!sourceData.requestPayer
                  }

                  // Get s3Region if present
                  if (Object.hasOwn(sourceData, 's3Region')) {
                    resolvedS3Region = sourceData.s3Region
                  }

                  // Pass the source's own setting through untouched: resolveSparse() applies the global option, the archive metadata
                  // and the format default where the tile format is known. Defaulting here made the format default unreachable.
                  resolvedSparse = sourceData.sparse

                  break // Found our match, exit the outer loop
                }
              }
            }

            // If no match was found
            if (!resolvedInputFile || !resolvedFileType) {
              console.warn(`Data source not found for styleSourceId: ${styleSourceId}`)
              console.warn(`Available data sources: ${Object.keys(data).map((id) => {
                  // eslint-disable-next-line security/detect-object-injection
                  const src = data[id]
                  return `${id} -> ${src.pmtiles || src.mbtiles || 'unknown'}`
                }).join(', ')}`
              )
              return {
                inputFile: undefined,
                fileType: undefined,
                s3Profile: undefined,
                requestPayer: false,
                s3Region: undefined,
                s3UrlFormat: undefined,
                sparse: undefined
              }
            }

            // PMTiles supports remote URLs (HTTP and S3), skip path resolution for those
            if (!isValidRemoteUrl(resolvedInputFile)) {
              // Ensure options.paths and options.paths[resolvedFileType] exist before trying to use them
              if (
                options &&
                options.paths &&
                // eslint-disable-next-line security/detect-object-injection -- resolvedFileType is either 'pmtiles' or 'mbtiles'
                options.paths[resolvedFileType]
              ) {
                resolvedInputFile = path.resolve(
                  // eslint-disable-next-line security/detect-object-injection -- resolvedFileType is either 'pmtiles' or 'mbtiles'
                  options.paths[resolvedFileType],
                  resolvedInputFile
                )
              } else {
                console.warn(`Path configuration missing for fileType: ${resolvedFileType}. Using relative path for: ${resolvedInputFile}`)
              }
            }

            return {
              inputFile: resolvedInputFile,
              fileType: resolvedFileType,
              s3Profile: resolvedS3Profile,
              requestPayer: resolvedRequestPayer,
              s3Region: resolvedS3Region,
              s3UrlFormat: resolvedS3UrlFormat,
              sparse: resolvedSparse
            }
          }
        )
      } else {
        item.serve_rendered = false
      }
    }
    return success
  }

  // Collect style loading promises separately
  const stylePromises = []
  for (const id of Object.keys(config.styles || {})) {
    // eslint-disable-next-line security/detect-object-injection -- id is from Object.keys of config.styles
    const item = config.styles[id]
    if (!item.style || item.style.length === 0) {
      console.log(`Missing "style" property for ${id}`)
      continue
    }
    stylePromises.push(addStyle(id, item, true, true))
    // Pre-initialize error counter for this style so metric appears in output
    if (metricsModule) {
      metricsModule.tileErrorsTotal.inc({ type: 'rendered', name: id }, 0)
    }
  }

  // Wait for styles to finish loading, then load data sources
  // This ensures data sources added by styles are included
  startupPromises.push(
    Promise.all(stylePromises).then(() => {
      const dataLoadPromises = []
      for (const id of Object.keys(data)) {
        // eslint-disable-next-line security/detect-object-injection -- id is from Object.keys of data config
        const item = data[id]

        if (!item.pmtiles && !item.mbtiles) {
          console.log(`Missing "pmtiles" or "mbtiles" property for ${id} data source`)
          continue
        }

        dataLoadPromises.push(serve_data.add(options, serving.data, item, id, opts))
      }
      return Promise.all(dataLoadPromises)
    })
  )

  startupPromises.push(serve_font(options, serving.fonts, opts).then((sub) => {app.use('/', sub)}))
  if (options.serveAllStyles) {
    fs.readdir(options.paths.styles, { withFileTypes: true }, (err, files) => {
      if (err) {
        return
      }
      for (const file of files) {
        if (file.isFile() && path.extname(file.name).toLowerCase() == '.json') {
          const id = path.basename(file.name, '.json')
          const item = {
            style: file.name
          }
          // Fire-and-forget: addStyle now awaits serve_rendered.add internally, so a rendered-init failure here would otherwise be an unhandled rejection.
          // For dynamically discovered styles we log and continue rather than exit.
          addStyle(id, item, false, false).catch((err) => {
            console.error(`Error adding style "${id}":`, err && err.stack ? err.stack : err)
          })
        }
      }
    })

    const watcher = chokidar.watch(path.join(options.paths.styles, '*.json'), {})
    cleanup = async () => {
      await watcher.close()
    }
    watcher.on('all', (eventType, filename) => {
      if (filename) {
        const id = path.basename(filename, '.json')
        console.log(`Style "${id}" changed, updating...`)

        serve_style.remove(serving.styles, id)
        if (!isLight) {
          serve_rendered.remove(serving.rendered, id)
        }

        if (eventType == 'add' || eventType == 'change') {
          const item = { style: filename }
          // Fire-and-forget (see note above): swallow rejection with a log so a failed hot-reload of one style cannot bring the whole server down.
          addStyle(id, item, false, false).catch((err) => {
            console.error(`Error adding style "${id}":`, err && err.stack ? err.stack : err)
          })
        }
      }
    })
  }
  /**
   * Handles requests for a list of available styles.
   * @param {object} req - Express request object.
   * @param {object} res - Express response object.
   * @param {object} next - Express next middleware function.
   * @param {string} [req.query.key] - Optional API key.
   * @returns {void}
   */
  app.get('/styles.json', (req, res, next) => {
    const result = []
    const query = req.query.key ? `?key=${encodeURIComponent(req.query.key)}` : ''
    for (const id of Object.keys(serving.styles)) {
      // eslint-disable-next-line security/detect-object-injection -- id is from Object.keys of serving.styles
      const styleJSON = serving.styles[id].styleJSON
      result.push({
        version: styleJSON.version,
        name: styleJSON.name,
        id,
        url: `${getPublicUrl(
          opts.publicUrl,
          req,
          opts.allowedHosts
        )}styles/${id}/style.json${query}`
      })
    }
    setHostDerivedCacheControl(res, options, 'metadata', {
      publicUrl: opts.publicUrl,
      allowedHosts: opts.allowedHosts
    })
    res.send(result)
  })

  /**
   * Adds TileJSON metadata to an array.
   * @param {Array} arr - The array to add TileJSONs to
   * @param {object} req - The express request object.
   * @param {string} type - The type of resource
   * @param {number} tileSize - The tile size.
   * @returns {Array} - An array of TileJSON objects.
   */
  function addTileJSONs (arr, req, type, tileSize) {
    // eslint-disable-next-line security/detect-object-injection -- type is 'rendered' or 'data', validated by caller
    for (const id of Object.keys(serving[type])) {
      // eslint-disable-next-line security/detect-object-injection -- type is 'rendered' or 'data', id is from Object.keys
      const info = clone(serving[type][id].tileJSON)
      let path
      if (type === 'rendered') {
        path = `styles/${id}`
      } else {
        path = `${type}/${id}`
      }
      info.tiles = getTileUrls(
        req,
        info.tiles,
        path,
        tileSize,
        info.format,
        opts.publicUrl,
        {
          pbf: options.pbfAlias
        },
        opts.allowedHosts
      )
      arr.push(info)
    }
    return arr
  }

  /**
   * Handles requests for a rendered tilejson endpoint.
   * @param {object} req - Express request object.
   * @param {object} res - Express response object.
   * @param {object} next - Express next middleware function.
   * @param {string} req.params.tileSize - Optional tile size parameter.
   * @returns {void}
   */
  app.get('{/:tileSize}/rendered.json', (req, res, next) => {
    const tileSize = allowedTileSizes(req.params['tileSize'])
    setHostDerivedCacheControl(res, options, 'metadata', {
      publicUrl: opts.publicUrl,
      allowedHosts: opts.allowedHosts
    })
    res.send(addTileJSONs([], req, 'rendered', parseInt(tileSize, 10)))
  })

  /**
   * Handles requests for a data tilejson endpoint.
   * @param {object} req - Express request object.
   * @param {object} res - Express response object.
   * @returns {void}
   */
  app.get('/data.json', (req, res) => {
    setHostDerivedCacheControl(res, options, 'metadata', {
      publicUrl: opts.publicUrl,
      allowedHosts: opts.allowedHosts
    })
    res.send(addTileJSONs([], req, 'data', undefined))
  })

  /**
   * Handles requests for a combined rendered and data tilejson endpoint.
   * @param {object} req - Express request object.
   * @param {object} res - Express response object.
   * @param {object} next - Express next middleware function.
   * @param {string} req.params.tileSize - Optional tile size parameter.
   * @returns {void}
   */
  app.get('{/:tileSize}/index.json', (req, res, next) => {
    const tileSize = allowedTileSizes(req.params['tileSize'])
    setHostDerivedCacheControl(res, options, 'metadata', {
      publicUrl: opts.publicUrl,
      allowedHosts: opts.allowedHosts
    })
    res.send(
      addTileJSONs(
        addTileJSONs([], req, 'rendered', parseInt(tileSize, 10)),
        req,
        'data',
        undefined
      )
    )
  })

  // ------------------------------------
  // serve web presentations
  app.use('/', express.static(path.join(__dirname, '../public/resources'), staticOptions))

  const templates = path.join(__dirname, '../public/templates')

  /**
   * Serves a Handlebars template.
   * @param {string} urlPath - The URL path to serve the template at
   * @param {string} template - The name of the template file
   * @param {(req: object) => object|null} dataGetter - A function to get data to be passed to the template.
   * @returns {void}
   */
  function serveTemplate (urlPath, template, dataGetter) {
    let templateFile = `${templates}/${template}.tmpl`
    if (template === 'index') {
      if (options.frontPage === false) {
        return
      } else if (options.frontPage && options.frontPage.constructor === String) {
        templateFile = path.resolve(paths.root, options.frontPage)
      }
    }
    try {
      const content = fs.readFileSync(templateFile, 'utf-8')
      const compiled = handlebars.compile(content.toString())
      app.get(urlPath, (req, res, next) => {
        if (opts.verbose >= 1) {
          console.log(`Serving template at path: ${urlPath}`)
        }
        let data
        if (dataGetter) {
          data = dataGetter(req)
          if (data) {
            data['server_version'] = `${packageJson.name} v${packageJson.version}`
            data['public_url'] = opts.publicUrl || '/'
            data['is_light'] = isLight
            data['leaflet_retina'] = options.leafletRetina === true
            data['key_query_part'] = req.query.key ? `key=${encodeURIComponent(req.query.key)}&amp;` : ''
            data['key_query'] = req.query.key ? `?key=${encodeURIComponent(req.query.key)}` : ''
            if (template === 'wmts') {
              res.set('Content-Type', 'text/xml')
            }
            // Viewer markup is not versioned, so it must not be cached or a redeploy would keep serving the old page.
            setCacheControl(res, options, 'html')
            return res.status(200).send(compiled(data))
          } else {
            if (opts.verbose >= 1) {
              console.log(`Forwarding request for: ${urlPath} to next route`)
            }
            next('route')
          }
        }
      })
    } catch (err) {
      console.error(`Error reading template file: ${templateFile}`, err)
      //throw an error so that the server doesn't start
      throw new Error(`Template not found: ${err.message}`, { cause: err })
    }
  }

  /**
   * Handles requests for the index page, providing a list of available styles and data.
   * @param {object} req - Express request object.
   * @returns {object|null} Template data object or null
   */
  serveTemplate('/', 'index', (req) => {
    let styles = {}
    for (const id of Object.keys(serving.styles || {})) {
      let style = {
        // eslint-disable-next-line security/detect-object-injection -- id is from Object.keys of serving.styles
        ...serving.styles[id],
        // eslint-disable-next-line security/detect-object-injection -- id is from Object.keys of serving.styles
        serving_data: serving.styles[id],
        // eslint-disable-next-line security/detect-object-injection -- id is from Object.keys of serving.styles
        serving_rendered: serving.rendered[id]
      }

      if (style.serving_rendered) {
        const { center } = style.serving_rendered.tileJSON
        if (center) {
          style.viewer_hash = `#${center[2]}/${center[1].toFixed(5)}/${center[0].toFixed(5)}`

          const centerPx = mercator.px([center[0], center[1]], center[2])
          // Set thumbnail default size to be 256px x 256px
          style.thumbnail = `${Math.floor(center[2])}/${Math.floor(centerPx[0] / 256)}/${Math.floor(centerPx[1] / 256)}.png`
        }

        const tileSize = 512
        style.xyz_link = getTileUrls(
          req,
          style.serving_rendered.tileJSON.tiles,
          `styles/${id}`,
          tileSize,
          style.serving_rendered.tileJSON.format,
          opts.publicUrl,
          undefined,
          opts.allowedHosts
        )[0]
      }

      // eslint-disable-next-line security/detect-object-injection -- id is from Object.keys of serving.styles
      styles[id] = style
    }
    let datas = {}
    for (const id of Object.keys(serving.data || {})) {
      // eslint-disable-next-line security/detect-object-injection -- id is from Object.keys of serving.data
      let data = Object.assign({}, serving.data[id])

      // eslint-disable-next-line security/detect-object-injection -- id is from Object.keys of serving.data
      const { tileJSON } = serving.data[id]
      const { center } = tileJSON

      if (center) {
        data.viewer_hash = `#${center[2]}/${center[1].toFixed(5)}/${center[0].toFixed(5)}`
      }

      const tileSize = undefined
      data.xyz_link = getTileUrls(
        req,
        tileJSON.tiles,
        `data/${id}`,
        tileSize,
        tileJSON.format,
        opts.publicUrl,
        {
          pbf: options.pbfAlias
        },
        opts.allowedHosts
      )[0]

      data.is_vector = tileJSON.format === 'pbf'
      if (!data.is_vector) {
        if (tileJSON.encoding === 'terrarium' || tileJSON.encoding === 'mapbox') {
          if (!isLight) {
            data.elevation_link = getTileUrls(
              req,
              tileJSON.tiles,
              `data/${id}/elevation`,
              undefined,
              undefined,
              opts.publicUrl,
              undefined,
              opts.allowedHosts
            )[0]
          }
          data.is_terrain = true
        }
        if (center) {
          const centerPx = mercator.px([center[0], center[1]], center[2])
          data.thumbnail = `${Math.floor(center[2])}/${Math.floor(centerPx[0] / 256)}/${Math.floor(centerPx[1] / 256)}.${tileJSON.format}`
        }
      }

      // eslint-disable-next-line security/detect-object-injection -- id is from Object.keys of serving.data
      datas[id] = data
    }
    return {
      styles: Object.keys(styles).length ? styles : null,
      data: Object.keys(datas).length ? datas : null
    }
  })

  /**
   * Handles requests for a map viewer template for a specific style.
   * @param {object} req - Express request object.
   * @returns {object|null} Template data object or null
   */
  serveTemplate('/styles/:id/', 'viewer', (req) => {
    const { id } = req.params
    // eslint-disable-next-line security/detect-object-injection -- id is route parameter from URL
    const style = clone(((serving.styles || {})[id] || {}).styleJSON)

    if (!style) {
      return null
    }
    return {
      ...style,
      id,
      // eslint-disable-next-line security/detect-object-injection -- id is route parameter from URL
      name: (serving.styles[id] || serving.rendered[id]).name,
      // eslint-disable-next-line security/detect-object-injection -- id is route parameter from URL
      serving_data: serving.styles[id],
      // eslint-disable-next-line security/detect-object-injection -- id is route parameter from URL
      serving_rendered: serving.rendered[id]
    }
  })

  /**
   * Handles requests for a Web Map Tile Service (WMTS) XML template.
   * @param {object} req - Express request object.
   * @returns {object|null} Template data object or null
   */
  serveTemplate('/styles/:id/wmts.xml', 'wmts', (req) => {
    const { id } = req.params
    // Own-property check so 'constructor'/'__proto__' don't resolve to a
    // prototype member and render a garbage WMTS document.
    if (!Object.hasOwn(serving.styles || {}, id)) {
      return null
    }
    // eslint-disable-next-line security/detect-object-injection -- id checked via Object.hasOwn above
    const wmts = clone(serving.styles[id])

    if (!wmts) {
      return null
    }

    if (Object.hasOwn(wmts, 'serve_rendered') && !wmts.serve_rendered) {
      return null
    }

    return {
      ...wmts,
      id,
      // eslint-disable-next-line security/detect-object-injection -- id is route parameter from URL
      name: (serving.styles[id] || serving.rendered[id]).name,
      baseUrl: getPublicUrl(opts.publicUrl, req, opts.allowedHosts)
    }
  })

  /**
   * Handles requests for a data view template for a specific data source.
   * @param {object} req - Express request object.
   * @returns {object|null} Template data object or null
   */
  serveTemplate('/data{/:view}/:id/', 'data', (req) => {
    const { id, view } = req.params
    // 'constructor'/'__proto__' resolve on Object.prototype, so a plain lookup
    // returns a truthy value that then crashes on data.tileJSON below. Require an own property.
    if (!Object.hasOwn(serving.data, id)) {
      return null
    }
    // eslint-disable-next-line security/detect-object-injection -- id checked via Object.hasOwn above
    const data = serving.data[id]

    if (!data) {
      return null
    }
    const is_terrain = (data.tileJSON.encoding === 'terrarium' || data.tileJSON.encoding === 'mapbox') && view === 'preview'

    return {
      ...data,
      id,
      use_maplibre: data.tileJSON.format === 'pbf' || is_terrain,
      is_terrain: is_terrain,
      is_terrainrgb: data.tileJSON.encoding === 'mapbox',
      terrain_encoding: data.tileJSON.encoding,
      is_light: isLight
    }
  })

  let startupComplete = false
  const startupPromise = Promise.all(startupPromises).then(() => {
    console.log('Startup complete')
    startupComplete = true
  })

  /**
   * Handles requests to see the health of the server.
   * @param {object} req - Express request object.
   * @param {object} res - Express response object.
   * @returns {void}
   */
  app.get('/health', (req, res) => {
    // Never cache: a probe must see the current state, not a stored answer.
    res.set('Cache-Control', 'no-store')
    if (startupComplete) {
      return res.status(200).send('OK')
    } else {
      return res.status(503).send('Starting')
    }
  })

  const server = app.listen(
    process.env.PORT || opts.port,
    process.env.BIND || opts.bind,
    function () {
      const addressInfo = this.address()

      if (!addressInfo) {
        console.error('Failed to bind to port')
        return
      }

      let address = addressInfo.address
      if (address.indexOf('::') === 0) {
        address = `[${address}]` // literal IPv6 address
      }
      console.log(`Listening at http://${address}:${addressInfo.port}/`)
    }
  )

  // Handle server errors
  server.on('error', (err) => {
    const port = process.env.PORT || opts.port
    if (err.code === 'EADDRINUSE') {
      console.error(`ERROR: Port ${port} is already in use.`)
      console.error(`Please choose a different port with -p or --port option.`)
      process.exit(1)
    } else if (err.code === 'EACCES') {
      console.error(`ERROR: Permission denied to bind to port ${port}.`)
      console.error(`Try using a port number above 1024 or run with appropriate permissions.`)
      process.exit(1)
    } else {
      console.error('Server error:', err.message)
      process.exit(1)
    }
  })

  // add server.shutdown() to gracefully stop serving
  enableShutdown(server)

  // Prometheus metrics server (separate port, opt-in)
  let metricsServer = null
  if (opts.metrics && metricsModule) {
    try {
      const metricsApp = express()
      metricsApp.get('/metrics', async (_req, res) => {
        res.set('Content-Type', metricsModule.registry.contentType)
        res.end(await metricsModule.registry.metrics())
      })
      await new Promise((resolve) => {
        metricsServer = metricsApp.listen(opts.metricsPort, '127.0.0.1')
        metricsServer.once('error', (err) => {
          console.warn(`[metrics] Failed to start metrics server: ${err.message}`)
          resolve() // don't crash — metrics are non-critical
        })
        metricsServer.once('listening', resolve)
      })
      console.log(`Prometheus metrics available at http://localhost:${opts.metricsPort}/metrics`)
    } catch (err) {
      console.warn(`[metrics] Failed to initialize metrics: ${err.message}`)
    }
  }

  return {
    app,
    server,
    startupPromise,
    serving,
    cleanup,
    metricsServer,
    accessLogStream
  }
}

/**
 * Stop the server gracefully
 * @param {string} signal Name of the received signal
 * @returns {void}
 */
function stopGracefully (signal) {
  console.log(`Caught signal ${signal}, stopping gracefully`)
  process.exit()
}

/**
 * Registers a process signal handler once.
 * @param {string} signal Name of the process signal.
 * @returns {void}
 */
function registerSignalHandler (signal) {
  if (!process.listeners(signal).includes(stopGracefully)) {
    process.on(signal, stopGracefully)
  }
}

/**
 * Starts and manages the server
 * @param {object} opts - Configuration options for the server.
 * @returns {Promise<object>} - A promise that resolves to the running server
 */
export async function server (opts) {
  const running = await start(opts)
  let reloading = false
  let pendingReload = false

  running.startupPromise.catch((err) => {
    console.error(err.message)
    process.exit(1)
  })

  registerSignalHandler('SIGINT')
  registerSignalHandler('SIGTERM')

  const reload = async () => {
    if (reloading) {
      pendingReload = true
      console.log('Reload already in progress, queueing another refresh')
      return
    }

    reloading = true
    let reloadAgain = true

    try {
      while (reloadAgain) {
        reloadAgain = false
        pendingReload = false
        await new Promise((resolve, reject) => {
          running.server.shutdown((err) => {
            if (err) {
              reject(err)
              return
            }
            resolve()
          })
        })
        if (running.metricsServer) {
          await new Promise((resolve) => running.metricsServer.close(resolve))
        }
        // Close the previous access-log file descriptor before start() opens a fresh one, so a --log_file deployment doesn't leak a fd per reload.
        if (running.accessLogStream) {
          await new Promise((resolve) => running.accessLogStream.end(resolve))
        }
        await running.cleanup()
        await serve_data.clear(running.serving.data)
        if (!isLight) {
          await serve_rendered.clear(running.serving.rendered)
        }
        clearPMtilesCache()

        const restarted = await start(opts)
        running.server = restarted.server
        running.app = restarted.app
        running.startupPromise = restarted.startupPromise
        running.serving = restarted.serving
        running.cleanup = restarted.cleanup
        running.metricsServer = restarted.metricsServer
        running.accessLogStream = restarted.accessLogStream
        await running.startupPromise
        reloadAgain = pendingReload
      }
    } finally {
      reloading = false
    }
  }

  process.on('SIGHUP', (signal) => {
    console.log(`Caught signal ${signal}, refreshing`)
    console.log('Stopping server and reloading config')

    reload().catch((err) => {
      console.error(err.message)
      process.exit(1)
    })
  })
  return running
}
