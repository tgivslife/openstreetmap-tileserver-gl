import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { server } from '../src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Well under the 30 s render timeout: a renderer whose resource request is never answered only
// fails once that timeout fires, so a slow answer here means the request handler left it waiting.
const PROMPT_MS = 5000;

describe('Renderer resource failures', function () {
  this.timeout(15000);

  const signals = ['SIGHUP', 'SIGINT', 'SIGTERM'];
  let listenerCounts;
  let running;
  let request;

  before(async function () {
    listenerCounts = signals.map((name) => process.listeners(name).length);
    running = await server({
      configPath: path.join(__dirname, 'fixtures/renderer-failures-config.json'),
      port: 0,
      publicUrl: '/test/'
    });
    await running.startupPromise;
    request = supertest(running.app);
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
      for (const listener of process.listeners(name).slice(listenerCounts[i])) {
        process.removeListener(name, listener);
      }
    });
  });

  /**
   * Requests a rendered tile and records how long the answer took.
   * @param {string} url Tile path.
   * @returns {Promise<{status: number, ms: number}>} Response status and elapsed milliseconds.
   */
  async function timedGet(url) {
    const started = Date.now();
    const res = await request.get(url);
    return { status: res.status, ms: Date.now() - started };
  }

  it('answers a tile whose raster source uses an unknown protocol', async function () {
    const { status, ms } = await timedGet('/styles/unknown-protocol/256/2/1/0.png');
    expect(status).to.equal(500);
    expect(ms).to.be.below(PROMPT_MS);
  });

  it('answers a tile whose raster source points at a missing file', async function () {
    const { status, ms } = await timedGet('/styles/missing-file/256/2/1/0.png');
    expect(status).to.equal(500);
    expect(ms).to.be.below(PROMPT_MS);
  });

  it('replaces a renderer after three consecutive failures, not on the first', async function () {
    // The fixture pins every pool to one renderer, so consecutive requests reach the same one.
    // missing-file failed once in the previous test; two more make three.
    const logged = [];
    const originalError = console.error;
    console.error = (...args) => {
      logged.push(args.map(String).join(' '));
    };
    const discards = () =>
      logged.filter((line) => line.startsWith('Discarding renderer:'));
    try {
      await timedGet('/styles/missing-file/256/2/1/1.png');
      expect(discards()).to.have.lengthOf(0);
      await timedGet('/styles/missing-file/256/2/1/2.png');
      expect(discards()).to.deep.equal([
        'Discarding renderer: 3 consecutive render failures'
      ]);
      // The replacement renderer starts from zero.
      await timedGet('/styles/missing-file/256/2/1/3.png');
      expect(discards()).to.have.lengthOf(1);
    } finally {
      console.error = originalError;
    }

    const again = await timedGet('/styles/missing-file/256/2/2/0.png');
    expect(again.status).to.equal(500);
    expect(again.ms).to.be.below(PROMPT_MS);
  });

  it('keeps serving a healthy style alongside the failing ones', async function () {
    const res = await request.get('/styles/ok/256/2/1/0.png');
    expect(res.status).to.equal(200);
    expect(res.headers['content-type']).to.equal('image/png');
  });
});
