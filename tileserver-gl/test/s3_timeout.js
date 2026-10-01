import http from 'node:http';
import { clearPMtilesCache, openPMtiles } from '../src/pmtiles_adapter.js';

const TIMEOUT_MS = 300;

/**
 * Serves every S3 range GET with the given handler on a loopback port.
 * @param {http.RequestListener} handler Request handler; it may leave the response unfinished to simulate a stall.
 * @returns {Promise<http.Server>} The listening server.
 */
async function stubS3(handler) {
  const stub = http.createServer(handler);
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  return stub;
}

describe('S3 request timeout', function () {
  const savedEnv = {};
  const envVars = {
    TILESERVER_GL_S3_REQUEST_TIMEOUT_MS: String(TIMEOUT_MS),
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test'
  };
  let stub;

  before(function () {
    for (const [name, value] of Object.entries(envVars)) {
      // eslint-disable-next-line security/detect-object-injection -- name is a key of the literal above
      savedEnv[name] = process.env[name];
      // eslint-disable-next-line security/detect-object-injection -- name is a key of the literal above
      process.env[name] = value;
    }
  });

  after(function () {
    for (const [name, value] of Object.entries(savedEnv)) {
      // eslint-disable-next-line security/detect-object-injection -- name is a key of the literal above
      if (value === undefined) delete process.env[name];
      // eslint-disable-next-line security/detect-object-injection -- name is a key of the literal above
      else process.env[name] = value;
    }
    clearPMtilesCache();
  });

  afterEach(function () {
    stub?.closeAllConnections();
    stub?.close();
    stub = undefined;
  });

  /**
   * Reads the first 100 bytes through an S3 source pointed at the stub.
   * @param {AbortSignal} [signal] Caller's abort signal.
   * @returns {Promise<object>} getBytes' result.
   */
  function read(signal) {
    const { port } = stub.address();
    const pmtiles = openPMtiles(
      `s3+http://127.0.0.1:${port}/bucket/archive.pmtiles`
    );
    return pmtiles.source.getBytes(0, 100, signal);
  }

  it('fails a read whose response headers never arrive', async function () {
    stub = await stubS3(() => {});
    const started = Date.now();
    const error = await read().catch((e) => e);
    expect(error).to.be.an('error');
    expect(error.name).to.equal('TimeoutError');
    expect(Date.now() - started).to.be.below(TIMEOUT_MS * 5);
  });

  it('fails a read whose body stalls after the headers', async function () {
    stub = await stubS3((req, res) => {
      res.writeHead(206, { 'Content-Length': '100', ETag: '"e"' });
      res.write(Buffer.alloc(10));
    });
    const started = Date.now();
    const error = await read().catch((e) => e);
    expect(error).to.be.an('error');
    expect(error.name).to.equal('TimeoutError');
    expect(Date.now() - started).to.be.below(TIMEOUT_MS * 5);
  });

  it('fails a read whose retry backoff outlasts the timeout', async function () {
    stub = await stubS3((req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/xml', 'Retry-After': '2' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>SlowDown</Code><Message>Slow down</Message></Error>');
    });
    const started = Date.now();
    const error = await read().catch((e) => e);
    expect(error).to.be.an('error');
    expect(error.name).to.equal('TimeoutError');
    expect(Date.now() - started).to.be.below(TIMEOUT_MS * 5);
  });

  it('returns the bytes of a read that answers in time', async function () {
    stub = await stubS3((req, res) => {
      res.writeHead(206, { 'Content-Length': '100', ETag: '"e"' });
      res.end(Buffer.alloc(100, 7));
    });
    const result = await read();
    expect(result.data.byteLength).to.equal(100);
    expect(result.etag).to.equal('"e"');
  });

  it("reports the caller's own abort as an abort, not a timeout", async function () {
    stub = await stubS3(() => {});
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const error = await read(controller.signal).catch((e) => e);
    expect(error).to.be.an('error');
    expect(error.name).to.equal('AbortError');
  });
});
