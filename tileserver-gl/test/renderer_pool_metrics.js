import advancedPool from 'advanced-pool';
import { rendererPoolCounts } from '../src/serve_rendered.js';

/**
 * A pool of one placeholder object, built the way serve_rendered builds its renderer pools.
 * @returns {object} The pool.
 */
function poolOfOne() {
  return new advancedPool.Pool({
    min: 1,
    max: 1,
    create: (callback) => callback(null, {}),
    destroy: () => {}
  });
}

/**
 * Acquires an object from a pool.
 * @param {object} pool The pool.
 * @returns {Promise<object>} The object.
 */
function acquire(pool) {
  return new Promise((resolve, reject) =>
    pool.acquire((err, object) => (err ? reject(err) : resolve(object)))
  );
}

describe('rendererPoolCounts', function () {
  let tilePool;
  let staticPool;

  afterEach(function () {
    tilePool?.close();
    staticPool?.close();
  });

  it('reports one busy renderer and one waiter, summed over the tile and static pools', async function () {
    tilePool = poolOfOne();
    staticPool = poolOfOne();
    const map = { renderers: [tilePool], renderersStatic: [staticPool] };

    const busy = await acquire(tilePool);
    // A second request for the tile pool's only renderer has to wait.
    const waiter = acquire(tilePool);
    await new Promise((resolve) => setImmediate(resolve));

    expect(rendererPoolCounts(map)).to.deep.equal({
      total: 2,
      active: 1,
      waiting: 1
    });

    tilePool.release(busy);
    tilePool.release(await waiter);
    expect(rendererPoolCounts(map)).to.deep.equal({
      total: 2,
      active: 0,
      waiting: 0
    });
  });

  it('skips missing pools', function () {
    expect(
      rendererPoolCounts({ renderers: [undefined], renderersStatic: [] })
    ).to.deep.equal({ total: 0, active: 0, waiting: 0 });
  });
});
