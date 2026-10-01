import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { server } from '../src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const signals = ['SIGHUP', 'SIGINT', 'SIGTERM'];

/**
 * Starts a server from a config file the way `--config` does, with TILESERVER_GL_ALLOWED_HOSTS set as given for the start.
 * @param {string} configPath Config file.
 * @param {string} [envHosts] Value for TILESERVER_GL_ALLOWED_HOSTS, if any.
 * @returns {Promise<{running: object, stop: () => Promise<void>}>} The server and a function that stops it.
 */
async function start(configPath, envHosts) {
  const savedEnv = process.env.TILESERVER_GL_ALLOWED_HOSTS;
  const listenerCounts = signals.map((name) => process.listeners(name).length);
  if (envHosts === undefined) delete process.env.TILESERVER_GL_ALLOWED_HOSTS;
  else process.env.TILESERVER_GL_ALLOWED_HOSTS = envHosts;
  let running;
  try {
    running = await server({ configPath, port: 0 });
    await running.startupPromise;
  } finally {
    if (savedEnv === undefined) delete process.env.TILESERVER_GL_ALLOWED_HOSTS;
    else process.env.TILESERVER_GL_ALLOWED_HOSTS = savedEnv;
  }
  const stop = async () => {
    await running.cleanup();
    if (running.server.listening) {
      await new Promise((resolve) => running.server.close(resolve));
    }
    signals.forEach((name, i) => {
      // eslint-disable-next-line security/detect-object-injection -- i indexes the counts recorded for signals above
      const added = process.listeners(name).slice(listenerCounts[i]);
      for (const listener of added) {
        process.removeListener(name, listener);
      }
    });
  };
  return { running, stop };
}

/**
 * Fetches /styles.json with the given Host header and returns its style URLs.
 * @param {object} running The server.
 * @param {string} host Host header.
 * @returns {Promise<string[]>} The url of every style listed.
 */
async function styleUrls(running, host) {
  const res = await supertest(running.app)
    .get('/styles.json')
    .set('Host', host)
    .expect(200);
  return res.body.map((style) => style.url);
}

describe('allowedHosts', function () {
  this.timeout(30000);

  describe('from options.allowedHosts in a --config file', function () {
    let server_;

    before(async function () {
      server_ = await start(
        path.join(__dirname, 'fixtures/allowed-hosts-config.json')
      );
    });

    after(async function () {
      await server_?.stop();
    });

    it('does not reflect a Host outside the list', async function () {
      const urls = await styleUrls(server_.running, 'attacker.example');
      expect(urls.length).to.be.above(0);
      for (const url of urls) {
        expect(url).to.not.contain('attacker.example');
      }
    });

    it('builds URLs from a Host on the list', async function () {
      const urls = await styleUrls(server_.running, 'tiles.example');
      expect(urls.length).to.be.above(0);
      for (const url of urls) {
        expect(url).to.contain('://tiles.example/');
      }
    });
  });

  describe('precedence', function () {
    it('TILESERVER_GL_ALLOWED_HOSTS applies when the config sets none', async function () {
      const { running, stop } = await start('config.json', 'tiles.example');
      try {
        for (const url of await styleUrls(running, 'attacker.example')) {
          expect(url).to.not.contain('attacker.example');
        }
      } finally {
        await stop();
      }
    });

    it('options.allowedHosts wins over TILESERVER_GL_ALLOWED_HOSTS', async function () {
      const { running, stop } = await start(
        path.join(__dirname, 'fixtures/allowed-hosts-config.json'),
        'attacker.example'
      );
      try {
        for (const url of await styleUrls(running, 'attacker.example')) {
          expect(url).to.not.contain('attacker.example');
        }
      } finally {
        await stop();
      }
    });
  });
});
