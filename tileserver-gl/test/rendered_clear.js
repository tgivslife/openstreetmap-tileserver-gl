import { serve_rendered } from '../src/serve_rendered.js';

describe('serve_rendered.clear', function () {
  it('stops the metrics timer of every entry, as remove() does', async function () {
    let ticks = 0;
    const repo = {
      style: {
        map: {
          _metricsInterval: setInterval(() => ticks++, 5),
          sources: {},
          sourceTypes: {},
          renderers: [],
          renderersStatic: []
        }
      }
    };
    const timer = repo.style.map._metricsInterval;

    try {
      await serve_rendered.clear(repo);
      const afterClear = ticks;
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(repo).to.deep.equal({});
      expect(ticks).to.equal(afterClear);
    } finally {
      clearInterval(timer);
    }
  });
});
