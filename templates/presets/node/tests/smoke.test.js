// 骨架自检:relay_init 交付即全绿,后续任何改动都不得让它变红
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/index.js';

test('骨架自检: main() 返回非空字符串', () => {
  assert.ok(typeof main() === 'string' && main().length > 0);
});
