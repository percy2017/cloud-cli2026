#!/opt/node22/bin/node
/**
 * One-shot verification of tree-cache behavior. Not part of the runtime.
 *
 * Usage: node scripts/verify-tree-cache.mjs
 */
import { treeCache } from '../server/modules/files/tree-cache.js';

console.log('--- Before any ops ---');
console.log('stats:', JSON.stringify(treeCache.stats));

console.log('\n--- Set and get ---');
treeCache.set('projA', 10, false, [{ name: 'a.js', type: 'file' }]);
treeCache.set('projA', 5, false, [{ name: 'b.js', type: 'file' }]);
treeCache.set('projB', 10, false, [{ name: 'c.js', type: 'file' }]);

const a = treeCache.get('projA', 10, false);
const a5 = treeCache.get('projA', 5, false);
const b = treeCache.get('projB', 10, false);
const none = treeCache.get('projZ', 10, false);

console.log('projA depth=10 →', JSON.stringify(a));
console.log('projA depth=5 →', JSON.stringify(a5));
console.log('projB depth=10 →', JSON.stringify(b));
console.log('projZ (missing) →', none);

console.log('\n--- Invalidate projA (should not affect projB) ---');
treeCache.invalidate('projA');
console.log('projA depth=10 after invalidate →', treeCache.get('projA', 10, false));
console.log('projB depth=10 after invalidate →', JSON.stringify(treeCache.get('projB', 10, false)));

console.log('\n--- Stats after ops ---');
console.log('stats:', JSON.stringify(treeCache.stats));

console.log('\n--- TTL expiration ---');
const cache = treeCache.constructor.prototype.constructor;
const fast = new (await import('../server/modules/files/tree-cache.js')).FileTreeCache({ ttlMs: 50, now: () => 100 });
fast.set('p', 10, false, 'payload');
console.log('immediate get →', fast.get('p', 10, false));
fast.now = () => 200; // simulate 100ms later, past TTL
console.log('after TTL →', fast.get('p', 10, false));
console.log('expired stats:', JSON.stringify(fast.stats));
