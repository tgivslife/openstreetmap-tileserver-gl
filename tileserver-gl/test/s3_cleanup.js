import http from 'node:http';
import { clearPMtilesCache, openPMtiles } from '../src/pmtiles_adapter.js';

describe('S3 source cleanup', function () {
  const envVars = { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' };
  const savedEnv = {};
  let stub;
  let sockets;

  before(async function () {
    for (const [name, value] of Object.entries(envVars)) {
      // eslint-disable-next-line security/detect-object-injection -- name is a key of the literal above
      savedEnv[name] = process.env[name];
      // eslint-disable-next-line security/detect-object-injection -- name is a key of the literal above
      process.env[name] = value;
    }
    sockets = new Set();
    stub = http.createServer((req, res) => {
      res.writeHead(206, { 'Content-Length': '100', ETag: '"e"' });
      res.end(Buffer.alloc(100));
    });
    stub.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  });

  after(async function () {
    for (const [name, value] of Object.entries(savedEnv)) {
      // eslint-disable-next-line security/detect-object-injection -- name is a key of the literal above
      if (value === undefined) delete process.env[name];
      // eslint-disable-next-line security/detect-object-injection -- name is a key of the literal above
      else process.env[name] = value;
    }
    clearPMtilesCache();
    stub.closeAllConnections();
    await new Promise((resolve) => stub.close(resolve));
  });

  it('clearing the cache closes the S3 client keep-alive connections', async function () {
    const { port } = stub.address();
    const pmtiles = openPMtiles(
      `s3+http://127.0.0.1:${port}/bucket/cleanup.pmtiles`
    );
    await pmtiles.source.getBytes(0, 100);
    // The finished request leaves its socket open in the client's keep-alive pool.
    expect(sockets.size).to.equal(1);

    clearPMtilesCache();

    const deadline = Date.now() + 2000;
    while (sockets.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(sockets.size).to.equal(0);
  });
});
