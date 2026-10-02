import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { server } from '../src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TILE = '/data/openmaptiles/14/8581/5738.pbf';

/**
 * Finds a free local port, so the server keeps the same one across a reload as it does in production (port 0 would rebind
 * to a new random port).
 * @returns {Promise<number>} The port.
 */
function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Requests a path on a local port, on a fresh connection each time.
 * @param {number} port Server port.
 * @param {string} urlPath Path to request.
 * @returns {Promise<{status: number, headers: object}>} Status and headers, or status 0 if the connection failed.
 */
function get(port, urlPath) {
  return new Promise((resolve) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath, agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      })
      .on('error', () => resolve({ status: 0, headers: {} }));
  });
}

/**
 * Requests TILE back to back until the given promise settles, and returns every answer.
 * @param {number} port Server port.
 * @param {Promise} until Stops requesting once this settles.
 * @returns {Promise<Array<{status: number, headers: object}>>} The answers.
 */
async function hammer(port, until) {
  let done = false;
  until.finally(() => (done = true));
  const answers = [];
  // At least one request, then keep going while startup is still running.
  do {
    answers.push(await get(port, TILE));
  } while (!done);
  answers.push(await get(port, TILE));
  return answers;
}

/**
 * Checks no answer is a 404 and every 503 is a retryable, uncached "Starting".
 * @param {Array<{status: number, headers: object}>} answers Answers from hammer().
 * @returns {void}
 */
function expectNoBlankTiles(answers) {
  const statuses = answers.map((a) => a.status);
  expect(statuses).to.not.include(404);
  for (const { status, headers } of answers) {
    expect([0, 200, 503], `status ${status}`).to.include(status);
    if (status === 503) {
      expect(headers['cache-control']).to.equal('no-store');
      expect(headers['retry-after']).to.equal('1');
    }
  }
  expect(statuses.at(-1)).to.equal(200);
}

describe('Requests before startup completes', function () {
  this.timeout(30000);

  const signals = ['SIGHUP', 'SIGINT', 'SIGTERM'];
  let listenerCounts;
  let running;
  let port;

  before(async function () {
    listenerCounts = signals.map((name) => process.listeners(name).length);
    port = await freePort();
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

  it('answers 503, not 404, while the server starts', async function () {
    running = await server({
      configPath: path.join(__dirname, '../test_data/config.json'),
      port
    });
    if (!running.server.listening) {
      await new Promise((resolve) => running.server.once('listening', resolve));
    }
    const answers = await hammer(port, running.startupPromise);
    expectNoBlankTiles(answers);
    expect(answers.map((a) => a.status)).to.include(503);
  });

  it('answers 503, not 404, while a SIGHUP reload restarts it', async function () {
    const reload = process.listeners('SIGHUP').at(-1);
    const before = running.startupPromise;
    reload('SIGHUP');
    // The reload swaps in a new server and startupPromise; wait for the swap, then for its startup.
    const swapped = (async () => {
      while (running.startupPromise === before) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await running.startupPromise;
    })();
    // Refused connections (status 0) are expected while the old listener is closed and the new one not yet bound.
    const answers = await hammer(port, swapped);
    expectNoBlankTiles(answers);
  });
});
