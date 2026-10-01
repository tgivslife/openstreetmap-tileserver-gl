import querystring from 'node:querystring';
import { redactKeyInUrl } from '../src/utils.js';

describe('Key redaction', function () {
  describe('redactKeyInUrl', function () {
    const cases = [
      ['/data/x/0/0/0.pbf?key=secret', '/data/x/0/0/0.pbf?key=[REDACTED]'],
      ['/a?b=1&key=secret&c=2', '/a?b=1&key=[REDACTED]&c=2'],
      ['/a?k%65y=secret', '/a?k%65y=[REDACTED]'],
      ['/a?%6B%65%79=secret', '/a?%6B%65%79=[REDACTED]'],
      ['/a?KEY=secret', '/a?KEY=[REDACTED]'],
      ['/a?key=one&key=two', '/a?key=[REDACTED]&key=[REDACTED]'],
      ['/a?key', '/a?key=[REDACTED]'],
      [
        'https://site.example/styles/s/?key=secret#14/47.3/8.5',
        'https://site.example/styles/s/?key=[REDACTED]#14/47.3/8.5'
      ],
      ['/a?monkey=1&keys=2', '/a?monkey=1&keys=2'],
      ['/a?b=%E0%A4%A&key=secret', '/a?b=%E0%A4%A&key=[REDACTED]'],
      ['/a', '/a']
    ];
    for (const [url, expected] of cases) {
      it(`${url} -> ${expected}`, function () {
        expect(redactKeyInUrl(url)).to.equal(expected);
      });
    }

    it('redacts every name the query parser reads as key', function () {
      // The key gate reads req.query.key, which Express parses with node:querystring.
      for (const name of ['key', 'k%65y', 'ke%79', '%6b%65%79', '%6B%45%59']) {
        const url = `/a?${name}=secret`;
        const parsed = querystring.parse(url.split('?')[1]);
        const readAsKey = Object.keys(parsed).some(
          (n) => n.toLowerCase() === 'key'
        );
        expect(readAsKey, name).to.equal(true);
        expect(redactKeyInUrl(url), name).to.not.contain('secret');
      }
    });
  });

  describe('viewer pages', function () {
    for (const url of ['/', '/styles/test-style/', '/data/openmaptiles/']) {
      it(`${url} sends Referrer-Policy: strict-origin`, async function () {
        const res = await supertest(app).get(url).expect(200);
        expect(res.headers['referrer-policy']).to.equal('strict-origin');
      });
    }
  });
});
