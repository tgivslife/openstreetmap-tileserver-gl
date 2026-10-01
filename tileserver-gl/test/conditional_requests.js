const resources = [
  ['a glyph range', '/fonts/Open Sans Bold/0-255.pbf'],
  ['a sprite', '/styles/test-style/sprite.png'],
  ['a rendered tile', '/styles/test-style/256/14/8581/5738.png']
];

describe('Conditional requests', function () {
  for (const [what, url] of resources) {
    describe(what, function () {
      let first;

      before(async function () {
        first = await supertest(app).get(url).expect(200);
        expect(first.headers['last-modified']).to.be.a('string');
        expect(first.headers['etag']).to.be.a('string');
      });

      it('answers 200 when If-None-Match differs, even though If-Modified-Since matches', async function () {
        const res = await supertest(app)
          .get(url)
          .set('If-Modified-Since', first.headers['last-modified'])
          .set('If-None-Match', 'W/"not-the-current-version"')
          .expect(200);
        expect(res.headers['etag']).to.equal(first.headers['etag']);
      });

      it('answers 304 to a matching If-None-Match, with the resource ETag', async function () {
        const res = await supertest(app)
          .get(url)
          .set('If-Modified-Since', first.headers['last-modified'])
          .set('If-None-Match', first.headers['etag'])
          .expect(304);
        expect(res.headers['etag']).to.equal(first.headers['etag']);
      });

      it('answers 304 to a matching If-Modified-Since alone, with no ETag rather than a wrong one', async function () {
        const res = await supertest(app)
          .get(url)
          .set('If-Modified-Since', first.headers['last-modified'])
          .expect(304);
        expect(res.headers['etag']).to.equal(undefined);
        expect(res.headers['cache-control']).to.be.a('string');
      });
    });
  }
});
