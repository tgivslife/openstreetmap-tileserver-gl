process.env.NODE_ENV = 'test';

import http from 'node:http';
import { expect } from 'chai';
import supertest from 'supertest';
import { server } from '../src/server.js';

/**
 * A supertest request whose throwaway server listens on 127.0.0.1 only.
 *
 * supertest starts an app with listen(0), which binds every interface ("::"), and then requests 127.0.0.1. On macOS another
 * process may hold that same port on 127.0.0.1 alone - an IDE's built-in web server, Postman - and the more specific socket
 * takes the connection, so the test talks to the other process: a random test answers 404, 303 or never. Binding to
 * 127.0.0.1 lets the kernel pick a port that is free on the address actually requested.
 *
 * Binding to a host completes asynchronously, while supertest reads the address synchronously when the request is built.
 * So the request is built against a placeholder URL, and end() - which .end(cb), .then() and await all go through - starts
 * the server, points the request at it and hands it to supertest, which closes it once the response is in.
 */
class LoopbackTest extends supertest.Test {
  constructor(app, method, path) {
    super('http://127.0.0.1', method, path);
    this._loopback = http.createServer(app);
    this._loopbackPath = path;
  }

  end(fn) {
    this._loopback.once('error', (err) => fn(err));
    this._loopback.listen(0, '127.0.0.1', () => {
      this.url = `http://127.0.0.1:${this._loopback.address().port}${this._loopbackPath}`;
      this._server = this._loopback;
      super.end(fn);
    });
    return this;
  }
}

/**
 * supertest, with express apps served from a 127.0.0.1-only server (see LoopbackTest).
 * @param {((req: object, res: object) => void)|object|string} app - An express app, or a server or URL supertest accepts as is.
 * @returns {object} An object with one request builder per HTTP method, like supertest's.
 */
function supertestLoopback(app) {
  if (typeof app !== 'function') {
    return supertest(app);
  }
  const agent = {};
  for (const method of http.METHODS.map((m) => m.toLowerCase())) {
    // eslint-disable-next-line security/detect-object-injection -- method comes from Node's own list of HTTP methods
    agent[method] = (path) => new LoopbackTest(app, method, path);
  }
  agent.del = agent.delete;
  return agent;
}

global.expect = expect;
global.supertest = supertestLoopback;

before(async function () {
  console.log('global setup');
  process.chdir('test_data');
  const running = await server({
    configPath: 'config.json',
    port: 8888,
    publicUrl: '/test/'
  });
  global.app = running.app;
  global.server = running.server;
  return running.startupPromise;
});

after(function () {
  console.log('global teardown');
  global.server.close(function () {
    console.log('Done');
  });
});
