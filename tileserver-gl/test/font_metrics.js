import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { server } from '../src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const METRICS_PORT = 9997;

/**
 * Reads the Prometheus scrape output.
 * @returns {Promise<string>} The metrics text.
 */
function scrape() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${METRICS_PORT}/metrics`, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

describe('Font metrics labels', function () {
  this.timeout(15000);

  const signals = ['SIGHUP', 'SIGINT', 'SIGTERM'];
  let listenerCounts;
  let running;
  let request;

  before(async function () {
    listenerCounts = signals.map((name) => process.listeners(name).length);
    running = await server({
      configPath: path.join(__dirname, 'fixtures/font-metrics-config.json'),
      port: 0,
      metrics: true,
      metricsPort: METRICS_PORT
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
      await new Promise((resolve) => running.metricsServer?.close(resolve) ?? resolve());
    }
    signals.forEach((name, i) => {
      // eslint-disable-next-line security/detect-object-injection -- i indexes the counts recorded for signals above
      const added = process.listeners(name).slice(listenerCounts[i]);
      for (const listener of added) {
        process.removeListener(name, listener);
      }
    });
  });

  it('made-up font stacks are served through fallback but share one "other" series', async function () {
    for (let i = 0; i < 10; i++) {
      await request.get(`/fonts/ReviewUnique${i}/0-255.pbf`).expect(200);
    }
    const body = await scrape();
    expect(body).to.not.contain('ReviewUnique');
    expect(body).to.match(
      /tileserver_tiles_served_total\{type="font",name="other"\} \d+/
    );
  });

  it('a known font is labelled by its name, and a stack by its first font', async function () {
    await request.get('/fonts/Open Sans Bold/0-255.pbf').expect(200);
    await request
      .get('/fonts/Open Sans Regular,Open Sans Bold/0-255.pbf')
      .expect(200);
    const body = await scrape();
    expect(body).to.contain('type="font",name="Open Sans Bold"');
    expect(body).to.contain('type="font",name="Open Sans Regular"');
    expect(body).to.not.contain('name="Open Sans Regular,Open Sans Bold"');
  });
});
