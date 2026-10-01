import assert from 'assert';
import polyline from '@mapbox/polyline';
import { getSecureMergedParams } from '../src/serve_rendered.js';

const testStatic = function (prefix, q, format, status, scale, type, query) {
  if (scale) q += '@' + scale + 'x';
  let path = '/styles/' + prefix + '/static/' + q + '.' + format;
  if (query) {
    path += query;
  }
  it(path + ' returns ' + status, function (done) {
    const test = supertest(app).get(path);
    if (status) test.expect(status);
    if (type) test.expect('Content-Type', type);
    test.end(done);
  });
};

const prefix = 'test-style';

describe('Static endpoints', function () {
  describe('center-based', function () {
    describe('valid requests', function () {
      describe('various formats', function () {
        testStatic(
          prefix,
          '0,0,0/256x256',
          'png',
          200,
          undefined,
          /image\/png/
        );
        testStatic(
          prefix,
          '0,0,0/256x256',
          'jpg',
          200,
          undefined,
          /image\/jpeg/
        );
        testStatic(
          prefix,
          '0,0,0/256x256',
          'jpeg',
          200,
          undefined,
          /image\/jpeg/
        );
        testStatic(
          prefix,
          '0,0,0/256x256',
          'webp',
          200,
          undefined,
          /image\/webp/
        );
      });

      describe('different parameters', function () {
        testStatic(prefix, '0,0,0/300x300', 'png', 200, 2);
        testStatic(prefix, '0,0,0/300x300', 'png', 200, 3);

        testStatic(prefix, '0,0,1.5/256x256', 'png', 200);

        testStatic(prefix, '80,40,20/600x300', 'png', 200, 3);
        testStatic(prefix, '8.5,40.5,20/300x150', 'png', 200, 3);
        testStatic(prefix, '-8.5,-40.5,20/300x150', 'png', 200, 3);

        testStatic(prefix, '8,40,2@0,0/300x150', 'png', 200);
        testStatic(prefix, '8,40,2@180,45/300x150', 'png', 200, 2);
        testStatic(prefix, '8,40,2@10/300x150', 'png', 200, 3);
        testStatic(prefix, '8,40,2@10.3,20.4/300x300', 'png', 200);
        testStatic(prefix, '0,0,2@390,120/300x300', 'png', 200);
      });
    });

    describe('invalid requests return 4xx', function () {
      testStatic(prefix, '190,0,0/256x256', 'png', 400);
      testStatic(prefix, '0,86,0/256x256', 'png', 400);
      testStatic(prefix, '80,40,20/0x0', 'png', 400);
      testStatic(prefix, '0,0,0/256x256', 'gif', 400);
      testStatic(prefix, '0,0,0/256x256', 'png', 404, 1);

      testStatic(prefix, '0,0,-1/256x256', 'png', 404);
      testStatic(prefix, '0,0,0/256.5x256.5', 'png', 400);

      testStatic(prefix, '0,0,0,/256x256', 'png', 404);
      testStatic(prefix, '0,0,0,0,/256x256', 'png', 404);
    });
  });

  describe('area-based', function () {
    describe('valid requests', function () {
      describe('various formats', function () {
        testStatic(
          prefix,
          '-180,-80,180,80/10x10',
          'png',
          200,
          undefined,
          /image\/png/
        );
        testStatic(
          prefix,
          '-180,-80,180,80/10x10',
          'jpg',
          200,
          undefined,
          /image\/jpeg/
        );
        testStatic(
          prefix,
          '-180,-80,180,80/10x10',
          'jpeg',
          200,
          undefined,
          /image\/jpeg/
        );
        testStatic(
          prefix,
          '-180,-80,180,80/10x10',
          'webp',
          200,
          undefined,
          /image\/webp/
        );
      });

      describe('different parameters', function () {
        testStatic(prefix, '-180,-90,180,90/20x20', 'png', 200, 2);
        testStatic(prefix, '0,0,1,1/200x200', 'png', 200, 3);

        testStatic(prefix, '-280,-80,0,80/280x160', 'png', 200);
      });
    });

    describe('invalid requests return 4xx', function () {
      testStatic(prefix, '0,87,1,88/5x2', 'png', 400);

      testStatic(prefix, '0,0,1,1/1x1', 'gif', 400);

      testStatic(prefix, '-180,-80,180,80/0.5x2.6', 'png', 400);
    });
  });

  describe('autofit path', function () {
    describe('valid requests', function () {
      testStatic(
        prefix,
        'auto/256x256',
        'png',
        200,
        undefined,
        /image\/png/,
        '?path=10,10|20,20'
      );

      describe('different parameters', function () {
        testStatic(
          prefix,
          'auto/20x20',
          'png',
          200,
          2,
          /image\/png/,
          '?path=10,10|20,20'
        );
        testStatic(
          prefix,
          'auto/200x200',
          'png',
          200,
          3,
          /image\/png/,
          '?path=-10,-10|-20,-20'
        );
      });

      describe('encoded path', function () {
        testStatic(
          prefix,
          'auto/20x20',
          'png',
          200,
          2,
          /image\/png/,
          '?path=' + encodeURIComponent('enc:{{biGwvyGoUi@s_A|{@')
        );
      });
    });

    describe('invalid requests return 4xx', function () {
      testStatic(prefix, 'auto/256x256', 'png', 400);
      testStatic(
        prefix,
        'auto/256x256',
        'png',
        400,
        undefined,
        undefined,
        '?path=invalid'
      );
      testStatic(
        prefix,
        'auto/2560x2560',
        'png',
        400,
        undefined,
        undefined,
        '?path=10,10|20,20'
      );
    });
  });

  const staticAutoPath = '/styles/' + prefix + '/static/auto/256x256.png';

  describe('POST static (path in body, issue #408)', function () {
    describe('valid requests', function () {
      it('POST with path in JSON body returns 200 and image/png', function (done) {
        supertest(app)
          .post(staticAutoPath)
          .set('Content-Type', 'application/json')
          .send({ path: '10,10|20,20' })
          .expect(200)
          .expect('Content-Type', /image\/png/)
          .end(done);
      });

      it('POST with long path in body succeeds (avoids URL length limit)', function (done) {
        const manyCoords = Array.from(
          { length: 200 },
          (_, i) => `${10 + i * 0.1},${20 + i * 0.1}`
        ).join('|');
        supertest(app)
          .post(staticAutoPath)
          .set('Content-Type', 'application/json')
          .send({ path: manyCoords })
          .expect(200)
          .expect('Content-Type', /image\/png/)
          .end(done);
      });

      it('POST with scale and path in body returns 200', function (done) {
        supertest(app)
          .post('/styles/' + prefix + '/static/auto/20x20@2x.png')
          .set('Content-Type', 'application/json')
          .send({ path: '10,10|20,20' })
          .expect(200)
          .expect('Content-Type', /image\/png/)
          .end(done);
      });
    });

    describe('invalid requests return 4xx', function () {
      it('POST with path array in body returns 200', function (done) {
        supertest(app)
          .post(staticAutoPath)
          .set('Content-Type', 'application/json')
          .send({ path: ['10,10|20,20', '-5,-5|5,5'] })
          .expect(200)
          .expect('Content-Type', /image\/png/)
          .end(done);
      });

      it('POST auto without path in body returns 400', function (done) {
        supertest(app)
          .post(staticAutoPath)
          .set('Content-Type', 'application/json')
          .send({})
          .expect(400, done);
      });

      it('POST with invalid JSON body returns 400 or 415', function (done) {
        supertest(app)
          .post(staticAutoPath)
          .set('Content-Type', 'application/json')
          .send('not json')
          .expect((res) => {
            expect([400, 415]).to.include(res.status);
          })
          .end(done);
      });
    });

    it('POST to tile URL returns 405 Method Not Allowed', function (done) {
      supertest(app)
        .post('/styles/' + prefix + '/0/0/0.png')
        .set('Content-Type', 'application/json')
        .send({})
        .expect(405, done);
    });

    it('POST to tile URL with invalid JSON returns 405', function (done) {
      supertest(app)
        .post('/styles/' + prefix + '/0/0/0.png')
        .set('Content-Type', 'application/json')
        // Intentionally send invalid JSON string
        .send('not json')
        .expect(405, done);
    });

    it('POST to tile URL with oversized JSON body returns 405', function (done) {
      // Construct a JSON body that exceeds the configured 5 MB JSON parser limit
      const largeString = 'x'.repeat(6 * 1024 * 1024); // ~6 MB
      supertest(app)
        .post(staticAutoPath)
        .set('Content-Type', 'application/json')
        .send({ data: largeString })
        .expect(413, done);
    });
  });

  describe('overlay limits', function () {
    const centerPath = '/styles/' + prefix + '/static/8.54,47.37,14/64x64.png';
    const markers = (n) =>
      Array.from({ length: n }, (_, i) => `8.54,${47.37 + i * 1e-5}|marker-icon.png`);
    const coords = (n) =>
      Array.from({ length: n }, (_, i) => `${8.5 + i * 1e-6},47.37`).join('|');

    /**
     * POSTs an overlay to a center-based static map.
     * @param {object} body The JSON body.
     * @returns {Promise<object>} The response.
     */
    const post = (body) =>
      supertest(app)
        .post(centerPath)
        .set('Content-Type', 'application/json')
        .send(body);

    it('renders 100 markers', async function () {
      const res = await post({ marker: markers(100) });
      expect(res.status).to.equal(200);
    });

    it('rejects 101 markers with 400', async function () {
      const res = await post({ marker: markers(101) });
      expect(res.status).to.equal(400);
      expect(res.text).to.equal('Too many markers: at most 100 allowed');
    });

    it('rejects 101 markers in the query string with 400', async function () {
      const query = markers(101)
        .map((m) => 'marker=' + encodeURIComponent(m))
        .join('&');
      const res = await supertest(app).get(centerPath + '?' + query);
      expect(res.status).to.equal(400);
    });

    it('rejects 101 paths with 400', async function () {
      const res = await post({ path: Array(101).fill('8.54,47.37|8.55,47.38') });
      expect(res.status).to.equal(400);
      expect(res.text).to.equal('Too many paths: at most 100 allowed');
    });

    it('renders a path of 20,000 coordinates', async function () {
      const res = await post({ path: coords(20000) });
      expect(res.status).to.equal(200);
    });

    it('rejects 20,001 coordinates across paths with 400', async function () {
      const res = await post({ path: [coords(10000), coords(10001)] });
      expect(res.status).to.equal(400);
      expect(res.text).to.equal(
        'Too many path coordinates: at most 20000 allowed'
      );
    });

    it('counts the coordinates of an encoded path', async function () {
      const encoded = polyline.encode(
        Array.from({ length: 20001 }, (_, i) => [47.37, 8.5 + i * 1e-5])
      );
      const res = await post({ path: 'enc:' + encoded });
      expect(res.status).to.equal(400);
    });

    describe('encoded paths are counted before decoding', function () {
      // serve_rendered.js calls decode on this same CommonJS module object, so wrapping it here sees its calls.
      const decode = polyline.decode;
      let decodes;

      beforeEach(function () {
        decodes = 0;
        polyline.decode = (...args) => {
          decodes++;
          return decode(...args);
        };
      });

      afterEach(function () {
        polyline.decode = decode;
      });

      it('rejects a 2 MB polyline of a million coordinates without decoding it', async function () {
        const res = await post({ path: 'enc:' + '??'.repeat(1_000_000) });
        expect(res.status).to.equal(400);
        expect(decodes).to.equal(0);
      });

      it('rejects a polyline that exceeds what earlier paths left of the budget, without decoding it', async function () {
        const res = await post({
          path: [coords(19999), 'enc:' + '??'.repeat(2)]
        });
        expect(res.status).to.equal(400);
        expect(decodes).to.equal(0);
      });

      it('decodes a polyline of exactly the remaining budget', async function () {
        const res = await post({
          path: [coords(19998), 'enc:' + '??'.repeat(2)]
        });
        expect(res.status).to.equal(200);
        expect(decodes).to.equal(1);
      });
    });
  });

  describe('getSecureMergedParams Logic & Security', function () {
    it('should maintain multiple values in query (Express array style)', () => {
      const query = {
        path: ['10,10|20,20', '10,20|20,10'],
        marker: ['10,15', '20,15'],
        latlng: ''
      };
      const result = getSecureMergedParams(query, {});

      assert.deepStrictEqual(result.path, ['10,10|20,20', '10,20|20,10']);
      assert.deepStrictEqual(result.marker, ['10,15', '20,15']);
      assert.strictEqual(result.latlng, '');
    });

    it('should maintain multiple values in body (Express array style)', () => {
      const body = {
        path: ['10,20|20,10', '10,10|20,20'],
        marker: ['20,15', '10,15'],
        latlng: ''
      };
      const result = getSecureMergedParams({}, body);

      assert.deepStrictEqual(result.path, ['10,20|20,10', '10,10|20,20']);
      assert.deepStrictEqual(result.marker, ['20,15', '10,15']);
      assert.strictEqual(result.latlng, '');
    });

    it('should merge a single value and a single value into an array', () => {
      const query = { path: '10,10|20,20' };
      const body = { path: '10,20|20,10' };
      const result = getSecureMergedParams(query, body);

      assert.deepStrictEqual(result.path, ['10,10|20,20', '10,20|20,10']);
    });

    it('should merge a single value and an array value', () => {
      const query = { path: '10,10|20,20' };
      const body = { path: ['10,20|20,10', '10,10|15,20|20,10'] };
      const result = getSecureMergedParams(query, body);

      assert.deepStrictEqual(result.path, [
        '10,10|20,20',
        '10,20|20,10',
        '10,10|15,20|20,10'
      ]);
    });

    it('should merge an array value and an array value', () => {
      const query = { path: ['10,10|20,20', '10,20|20,10'] };
      const body = { path: ['10,10|15,20|20,10', '5,5|10,10'] };
      const result = getSecureMergedParams(query, body);

      assert.deepStrictEqual(result.path, [
        '10,10|20,20',
        '10,20|20,10',
        '10,10|15,20|20,10',
        '5,5|10,10'
      ]);
    });

    it('should preserve empty strings (e.g. ?latlng&latlng)', () => {
      const query = { latlng: '' };
      const body = { latlng: '' };
      const result = getSecureMergedParams(query, body);

      assert.deepStrictEqual(result.latlng, ['', '']);
    });

    it('should throw 400 error on nested objects (Deep Object vulnerability)', () => {
      const body = { path: { lat: 10, lon: 10 } };
      assert.throws(
        () => getSecureMergedParams({}, body),
        /nested objects are not allowed/
      );
    });

    it('should ignore unallowed keys like "__proto__"', () => {
      const body = JSON.parse('{"__proto__": true, "path": "10,10|20,20"}');
      const result = getSecureMergedParams({}, body);

      assert.strictEqual(result.__proto__, undefined); // It is stripped
      assert.strictEqual(result.path, '10,10|20,20');
      assert.strictEqual(Object.getPrototypeOf(result), null);
    });

    it('POST with Prototype Pollution in JSON string returns 400', function (done) {
      const maliciousPayload = '{"__proto__": {"admin": true}, }';
      supertest(app)
        .post(staticAutoPath)
        .set('Content-Type', 'application/json')
        .send(maliciousPayload)
        .expect(400)
        .expect((res) => {
          // secure-json-parse error message usually contains these terms
          assert.ok(
            res.text.includes('Invalid JSON') || res.text.includes('forbidden')
          );
        })
        .end(done);
    });

    it('should throw 400 error if the input itself is an array', () => {
      const body = ['not', 'an', 'object'];
      assert.throws(() => getSecureMergedParams({}, body), /Invalid data/);
    });

    it('should ensure the result has no prototype', () => {
      const result = getSecureMergedParams({ a: 1 }, { b: 2 });
      assert.strictEqual(Object.getPrototypeOf(result), null);
      assert.strictEqual(result.toString, undefined);
    });
  });
});
