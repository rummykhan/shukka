import { test } from 'node:test';
import assert from 'node:assert/strict';

test('shu-5ze: the lib barrel loads as an ES module through tsx', async () => {
  const lib: Record<string, unknown> = await import('../lib/index.js');
  assert.equal(typeof lib, 'object');
  assert.equal(Object.prototype.toString.call(lib), '[object Module]');
});
