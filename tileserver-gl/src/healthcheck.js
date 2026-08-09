import * as http from 'http'

// Match how the server actually binds (server.js: `process.env.PORT || opts.port` and `process.env.BIND || opts.bind`).
const port = process.env.PORT || 8080
let host = process.env.BIND || 'localhost'
// A wildcard bind ('0.0.0.0'/'::') or empty value is not a valid connect target on every platform, so probe loopback instead.
if (host === '0.0.0.0' || host === '::' || host === '') {
  host = 'localhost'
}

const request = http.request(
  { host, port, path: '/health', timeout: 2000 },
  (res) => {
    console.log(`STATUS: ${res.statusCode}`)
    process.exit(res.statusCode === 200 ? 0 : 1)
  }
)

// Without a 'timeout' handler the request just idles on a hung server until Docker's own (default 30s) timeout fires, ~15x slower than the intended 2s.
request.on('timeout', () => {
  console.log('TIMEOUT')
  request.destroy()
  process.exit(1)
})

request.on('error', function () {
  console.log('ERROR')
  process.exit(1)
})

request.end()
