// Mint an expiring HMAC access token for the tileserver auth gate.
//
// Token format (see tileserver-gl/src/server.js): "<unix-expiry>.<signature>"
// where signature = hex( HMAC-SHA256( key = TILESERVER_GL_TOKEN_SECRET,
//                                     message = "<unix-expiry>" ) ).
// Stateless: nothing to store or revoke; a leaked token simply dies at expiry.
//
// Usage:
//   node gen-token.js            # token valid for 1 hour (default)
//   node gen-token.js 86400      # valid for 24 hours (seconds)
//
// The secret comes from TILESERVER_GL_TOKEN_SECRET so it can't drift from the
// server; it falls back to the dev value used in compose.s3.yml. The TTL must
// stay within the server's TILESERVER_GL_TOKEN_MAX_TTL (default 604800 = 7d) or
// the token is rejected as too-far-future.
//
// Then use it:  .../data/<id>/{z}/{x}/{y}.pbf?key=<token>

const crypto = require('crypto');

const secret = process.env.TILESERVER_GL_TOKEN_SECRET || 'dev-hmac-secret';
const ttl = Number(process.argv[2] || 3600);

if (!Number.isFinite(ttl) || ttl <= 0) {
  console.error(`Invalid TTL "${process.argv[2]}" — pass a positive number of seconds.`);
  process.exit(1);
}

const expiry = Math.floor(Date.now() / 1000) + ttl;
const signature = crypto
  .createHmac('sha256', secret)
  .update(String(expiry))
  .digest('hex');

console.log(`${expiry}.${signature}`);
