import crypto from 'node:crypto';
import { server } from '../src/server.js';
import { capCacheControlToKeyExpiry } from '../src/utils.js';

const SECRET = 'token-caching-secret';
const STATIC_KEY = 'token-caching-static-key';

/**
 * Signs a token that expires the given number of seconds from now.
 * @param {number} ttl Seconds until expiry.
 * @returns {string} The token, "<expiry>.<signature>".
 */
function token(ttl) {
  const expiry = String(Math.floor(Date.now() / 1000) + ttl);
  const signature = crypto
    .createHmac('sha256', SECRET)
    .update(expiry)
    .digest('hex');
  return `${expiry}.${signature}`;
}

/**
 * Reads max-age from a Cache-Control value.
 * @param {string} value The header value.
 * @returns {number|undefined} max-age in seconds, if present.
 */
function maxAge(value) {
  const match = /\bmax-age=(\d+)/.exec(value);
  return match ? Number(match[1]) : undefined;
}

describe('Cache-Control under expiring tokens', function () {
  describe('capCacheControlToKeyExpiry', function () {
    const now = 1_000_000;
    const res = (ttl) => ({ locals: { keyExpiresAt: now + ttl } });
    const cases = [
      [
        'cuts max-age and drops stale-while-revalidate',
        'public, max-age=86400, stale-while-revalidate=604800',
        2,
        'public, max-age=2, must-revalidate'
      ],
      [
        'drops immutable and stale-if-error',
        'public, max-age=31536000, immutable, stale-if-error=60',
        60,
        'public, max-age=60, must-revalidate'
      ],
      ['cuts s-maxage too', 'public, max-age=60, s-maxage=600', 30, 'public, max-age=30, s-maxage=30, must-revalidate'],
      ['cuts a quoted s-maxage', 'public, max-age=60, s-maxage="86400"', 2, 'public, max-age=2, s-maxage=2, must-revalidate'],
      ['cuts a quoted, spaced max-age', 'public, Max-Age = " 86400 "', 2, 'public, max-age=2, must-revalidate'],
      ['replaces an unreadable max-age', 'public, max-age=soon', 2, 'public, max-age=2, must-revalidate'],
      ['drops quoted stale directives', 'public, max-age=60, stale-while-revalidate="604800"', 2, 'public, max-age=2, must-revalidate'],
      ['keeps a max-age already shorter', 'public, max-age=60', 3600, 'public, max-age=60, must-revalidate'],
      ['adds max-age when there is none', 'public', 120, 'public, max-age=120, must-revalidate'],
      ['adds must-revalidate only once', 'public, max-age=60, must-revalidate', 120, 'public, max-age=60, must-revalidate'],
      ['leaves no-cache revalidation in place', 'no-cache', 120, 'no-cache, must-revalidate'],
      ['leaves no-store as it is', 'no-store', 120, 'no-store'],
      ['answers no-store once the token has expired', 'public, max-age=3600', 0, 'no-store']
    ];
    for (const [name, value, ttl, expected] of cases) {
      it(name, function () {
        expect(capCacheControlToKeyExpiry(value, res(ttl), now)).to.equal(
          expected
        );
      });
    }

    it('leaves a request with no token expiry as it is', function () {
      const value = 'public, max-age=86400, stale-while-revalidate=604800';
      expect(capCacheControlToKeyExpiry(value, { locals: {} }, now)).to.equal(
        value
      );
    });
  });

  describe('routes', function () {
    this.timeout(30000);

    const signals = ['SIGHUP', 'SIGINT', 'SIGTERM'];
    const env = {
      TILESERVER_GL_API_KEYS: STATIC_KEY,
      TILESERVER_GL_TOKEN_SECRET: SECRET
    };
    const savedEnv = {};
    let listenerCounts;
    let running;
    let request;

    before(async function () {
      for (const [name, value] of Object.entries(env)) {
        // eslint-disable-next-line security/detect-object-injection -- name is a key of the literal above
        savedEnv[name] = process.env[name];
        // eslint-disable-next-line security/detect-object-injection -- name is a key of the literal above
        process.env[name] = value;
      }
      listenerCounts = signals.map((name) => process.listeners(name).length);
      running = await server({ configPath: 'config.json', port: 0 });
      await running.startupPromise;
      request = supertest(running.app);
    });

    after(async function () {
      for (const [name, value] of Object.entries(savedEnv)) {
        // eslint-disable-next-line security/detect-object-injection -- name is a key of the literal above
        if (value === undefined) delete process.env[name];
        // eslint-disable-next-line security/detect-object-injection -- name is a key of the literal above
        else process.env[name] = value;
      }
      if (running) {
        await running.cleanup();
        if (running.server.listening) {
          await new Promise((resolve) => running.server.close(resolve));
        }
      }
      signals.forEach((name, i) => {
        // eslint-disable-next-line security/detect-object-injection -- i indexes the counts recorded for signals above
        const added = process.listeners(name).slice(listenerCounts[i]);
        for (const listener of added) {
          process.removeListener(name, listener);
        }
      });
    });

    const urls = [
      '/data/openmaptiles/14/8581/5738.pbf',
      '/styles/test-style/style.json',
      '/fonts/Open Sans Bold/0-255.pbf',
      '/styles/test-style/sprite.png'
    ];

    for (const url of urls) {
      it(`${url} with a token expiring in 2 s is fresh for at most 2 s, with no stale serving`, async function () {
        const res = await request
          .get(url)
          .query({ key: token(2) })
          .expect(200);
        const value = res.headers['cache-control'];
        expect(maxAge(value), value).to.be.within(1, 2);
        expect(value).to.not.match(/stale-while-revalidate|immutable/);
        // Without it a client sending max-stale may still be served the response once the token has expired.
        expect(value).to.match(/\bmust-revalidate\b/);
      });
    }

    // Conditional requests answered 304 must carry the same Cache-Control, since a cache refreshes the stored headers from them.
    const conditional = [
      ['a glyph range', '/fonts/Open Sans Bold/0-255.pbf'],
      ['a sprite', '/styles/test-style/sprite.png'],
      ['a rendered tile', '/styles/test-style/256/14/8581/5738.png']
    ];
    for (const [what, url] of conditional) {
      it(`${what} answered 304 under a 2 s token carries the capped Cache-Control`, async function () {
        const first = await request
          .get(url)
          .query({ key: STATIC_KEY })
          .expect(200);
        const res = await request
          .get(url)
          .query({ key: token(2) })
          .set('If-Modified-Since', first.headers['last-modified'])
          .expect(304);
        const value = res.headers['cache-control'];
        expect(maxAge(value), value).to.be.within(1, 2);
        expect(value).to.match(/\bmust-revalidate\b/);
      });

      it(`${what} answered 304 under a static key carries its usual Cache-Control`, async function () {
        const first = await request
          .get(url)
          .query({ key: STATIC_KEY })
          .expect(200);
        const res = await request
          .get(url)
          .query({ key: STATIC_KEY })
          .set('If-Modified-Since', first.headers['last-modified'])
          .expect(304);
        expect(res.headers['cache-control']).to.equal(
          first.headers['cache-control']
        );
      });
    }

    it('a tile with a static API key keeps the full tile caching', async function () {
      const res = await request
        .get(urls[0])
        .query({ key: STATIC_KEY })
        .expect(200);
      expect(res.headers['cache-control']).to.equal(
        'public, max-age=86400, stale-while-revalidate=604800'
      );
    });

    it('a tile with a token expiring in a week keeps its own day of freshness', async function () {
      const res = await request
        .get(urls[0])
        .query({ key: token(604000) })
        .expect(200);
      expect(res.headers['cache-control']).to.equal(
        'public, max-age=86400, must-revalidate'
      );
    });
  });
});
