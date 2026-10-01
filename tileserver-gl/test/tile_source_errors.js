import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { server } from '../src/server.js';
import { fetchTileData, TileSourceError } from '../src/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Well under the 30 s render timeout: a renderer left unusable by a failed read only answers once that timeout fires.
const PROMPT_MS = 5000;

/**
 * A stand-in PMTiles archive whose tile read behaves as given.
 * @param {() => Promise<object|undefined>} getZxy The tile read.
 * @returns {object} An object with the PMTiles methods getPMtilesTile calls.
 */
function fakePMTiles(getZxy) {
  return { getHeader: async () => ({ tileType: 1 }), getZxy };
}

/**
 * An error shaped like the one the AWS SDK throws.
 * @param {string} name SDK error name.
 * @param {number} status HTTP status.
 * @returns {Error} The error.
 */
function sdkError(name, status) {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status }
  });
}

describe('Tile source errors', function () {
  describe('fetchTileData', function () {
    it('answers null for a PMTiles tile the archive does not have', async function () {
      const tile = await fetchTileData(
        fakePMTiles(async () => undefined),
        'pmtiles',
        1,
        0,
        0
      );
      expect(tile).to.equal(null);
    });

    it('throws a 502 TileSourceError when S3 denies the read', async function () {
      const error = await fetchTileData(
        fakePMTiles(async () => {
          throw sdkError('AccessDenied', 403);
        }),
        'pmtiles',
        1,
        0,
        0
      ).catch((e) => e);
      expect(error).to.be.instanceOf(TileSourceError);
      expect(error.status).to.equal(502);
      expect(error.cause.name).to.equal('AccessDenied');
    });

    it('throws a 502 TileSourceError when an HTTP archive answers an error status', async function () {
      const error = await fetchTileData(
        fakePMTiles(async () => {
          throw new Error('Bad response code: 500');
        }),
        'pmtiles',
        1,
        0,
        0
      ).catch((e) => e);
      expect(error).to.be.instanceOf(TileSourceError);
      expect(error.status).to.equal(502);
    });

    it('throws a 504 TileSourceError when the read times out', async function () {
      const timeout = Object.assign(new Error('timed out'), {
        name: 'TimeoutError'
      });
      const error = await fetchTileData(
        fakePMTiles(async () => {
          throw timeout;
        }),
        'pmtiles',
        1,
        0,
        0
      ).catch((e) => e);
      expect(error).to.be.instanceOf(TileSourceError);
      expect(error.status).to.equal(504);
    });

    it('answers null for an MBTiles tile the archive does not have', async function () {
      const mbtiles = {
        getTile: (z, x, y, cb) => cb(new Error('Tile does not exist'))
      };
      expect(await fetchTileData(mbtiles, 'mbtiles', 1, 0, 0)).to.equal(null);
    });

    it('throws a 500 TileSourceError when an MBTiles read fails', async function () {
      const mbtiles = {
        getTile: (z, x, y, cb) =>
          cb(new Error('SQLITE_IOERR: disk I/O error'))
      };
      const error = await fetchTileData(mbtiles, 'mbtiles', 1, 0, 0).catch(
        (e) => e
      );
      expect(error).to.be.instanceOf(TileSourceError);
      expect(error.status).to.equal(500);
    });
  });

  describe('routes', function () {
    // Long enough for a stalled render to reach its 30 s timeout, so a regression fails on PROMPT_MS rather than on the test timeout.
    this.timeout(45000);

    const signals = ['SIGHUP', 'SIGINT', 'SIGTERM'];
    let restores = [];
    let listenerCounts;
    let running;
    let request;

    before(async function () {
      listenerCounts = signals.map((name) => process.listeners(name).length);
      // One renderer per pool, so consecutive requests reach the renderer the previous one used.
      running = await server({
        configPath: path.join(__dirname, 'fixtures/tile-source-errors-config.json'),
        port: 0
      });
      await running.startupPromise;
      request = supertest(running.app);
    });

    afterEach(function () {
      restores.forEach((restore) => restore());
      restores = [];
    });

    after(async function () {
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

    /**
     * Makes every MBTiles read the data and rendered routes do fail with the given error, until the test ends.
     * @param {Error} error The read error.
     * @returns {void}
     */
    function failMBTilesReads(error) {
      const sources = [
        running.serving.data.openmaptiles.source,
        ...Object.values(running.serving.rendered).flatMap((item) =>
          Object.values(item.map.sources)
        )
      ];
      for (const source of sources) {
        const getTile = source.getTile;
        source.getTile = (z, x, y, cb) => cb(error);
        restores.push(() => {
          source.getTile = getTile;
        });
      }
    }

    /**
     * Replaces every archive the data and rendered routes read from with a PMTiles one whose tile reads throw, until the test ends.
     * @param {Error} error The read error.
     * @returns {void}
     */
    function failPMTilesReads(error) {
      const replace = (holder, sourceKey, typeHolder, typeKey) => {
        // eslint-disable-next-line security/detect-object-injection -- keys come from the server's own repo
        const [source, type] = [holder[sourceKey], typeHolder[typeKey]];
        // eslint-disable-next-line security/detect-object-injection -- keys come from the server's own repo
        holder[sourceKey] = fakePMTiles(async () => {
          throw error;
        });
        // eslint-disable-next-line security/detect-object-injection -- keys come from the server's own repo
        typeHolder[typeKey] = 'pmtiles';
        restores.push(() => {
          // eslint-disable-next-line security/detect-object-injection -- keys come from the server's own repo
          holder[sourceKey] = source;
          // eslint-disable-next-line security/detect-object-injection -- keys come from the server's own repo
          typeHolder[typeKey] = type;
        });
      };
      const data = running.serving.data.openmaptiles;
      replace(data, 'source', data, 'sourceType');
      for (const item of Object.values(running.serving.rendered)) {
        for (const name of Object.keys(item.map.sources)) {
          replace(item.map.sources, name, item.map.sourceTypes, name);
        }
      }
    }

    it('answers a data tile whose MBTiles read fails with an uncached 500, not an empty tile', async function () {
      failMBTilesReads(new Error('SQLITE_IOERR: disk I/O error'));
      const res = await request.get('/data/openmaptiles/14/8581/5738.pbf');
      expect(res.status).to.equal(500);
      expect(res.headers['cache-control']).to.equal('no-store');
      expect(res.text).to.equal('Tile source unavailable');
    });

    it('answers a data tile whose S3 read times out with an uncached 504', async function () {
      failPMTilesReads(
        Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      );
      const res = await request.get('/data/openmaptiles/14/8581/5738.pbf');
      expect(res.status).to.equal(504);
      expect(res.headers['cache-control']).to.equal('no-store');
    });

    it('answers a rendered tile whose S3 read is denied with an uncached 502, not a blank image', async function () {
      failPMTilesReads(sdkError('AccessDenied', 403));
      const res = await request.get('/styles/test-style/256/14/8581/5738.png');
      expect(res.status).to.equal(502);
      expect(res.headers['cache-control']).to.equal('no-store');
      expect(res.text).to.equal('Tile source unavailable');
    });

    it('answers a rendered tile whose S3 read times out with a 504', async function () {
      failPMTilesReads(
        Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      );
      const res = await request.get('/styles/test-style/256/14/8581/5738.png');
      expect(res.status).to.equal(504);
    });

    it('answers a rendered tile whose MBTiles read fails with a 500', async function () {
      failMBTilesReads(new Error('SQLITE_IOERR: disk I/O error'));
      const res = await request.get('/styles/test-style/256/14/8581/5738.png');
      expect(res.status).to.equal(500);
      expect(res.headers['cache-control']).to.equal('no-store');
    });

    it('renders promptly with the same pool once reads recover after repeated failures', async function () {
      const tileUrl = '/styles/test-style/256/14/8581/5738.png';
      const staticUrl = '/styles/test-style/static/8.54,47.37,14/256x256.png';
      failMBTilesReads(new Error('SQLITE_IOERR: disk I/O error'));
      for (const url of [tileUrl, tileUrl, staticUrl, staticUrl]) {
        expect((await request.get(url)).status).to.equal(500);
      }
      restores.forEach((restore) => restore());
      restores = [];

      for (const url of [tileUrl, staticUrl]) {
        const started = Date.now();
        const res = await request.get(url);
        expect(res.status, url).to.equal(200);
        expect(res.headers['content-type']).to.match(/^image\/png/);
        expect(Date.now() - started, url).to.be.below(PROMPT_MS);
      }
    });
  });
});
