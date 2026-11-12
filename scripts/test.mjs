import assert from 'node:assert';
const { wantRoad, encodeWay, encodeOutline } = await import('./build.mjs');
assert.equal(wantRoad({ highway: 'residential' }), 0);
assert.equal(wantRoad({ highway: 'primary', surface: 'gravel' }), 3);
assert.equal(wantRoad({ highway: 'service' }), null, 'unnamed service road');
assert.equal(wantRoad({ highway: 'service', name: 'Williams Dr' }), 4);
assert.equal(wantRoad({ highway: 'service', name: 'X', service: 'parking_aisle' }), null);
assert.equal(wantRoad({ highway: 'residential', access: 'private' }), null);
assert.equal(wantRoad({ highway: 'footway' }), null);
const enc = [];
encodeWay(0, [[-91.77, 37.95], [-91.76, 37.951]], enc);
assert.deepEqual(enc, [0, 2, 37950000, -91770000, 1000, 10000]);
const o = encodeOutline([[[-92, 37], [-91, 37], [-91, 38], [-92, 38], [-92, 37]]]);
assert.equal(o[0], 5);
console.log('build script tests ok');
const { buildLocator, insideRings } = await import('./build.mjs');
// Two side-by-side square "counties" sharing a border at lon -91.6, with a notch cut out of the first.
const sq = (w, e) => [[w, 37.6], [e, 37.6], [e, 38.1], [w, 38.1], [w, 37.6]];
const counties = [{ id: 1, rings: [sq(-92, -91.6), [[-91.9, 37.7], [-91.8, 37.7], [-91.8, 37.8], [-91.9, 37.8], [-91.9, 37.7]]] }, { id: 2, rings: [sq(-91.6, -91.2)] }];
const locate = buildLocator(counties);
assert.deepEqual(locate(-91.95, 37.9), [0]);
assert.deepEqual(locate(-91.85, 37.75), [], 'inside the hole');
assert.deepEqual(locate(-91.3, 37.9), [1]);
assert.deepEqual(locate(-91.6001, 37.9), [0]);
assert.deepEqual(locate(-91.5999, 37.9), [1]);
assert.deepEqual(locate(-90.5, 37.9), [], 'outside the state');
assert.equal(insideRings([sq(-92, -91.6)], -91.7, 37.9), true);
// speed: a million lookups
const t0 = Date.now();
for (let i = 0; i < 1e6; i++) locate(-92 + (i % 800) / 1000, 37.6 + (i % 500) / 1000);
console.log(`locator ok, 1M lookups in ${Date.now() - t0} ms`);
// A huge county (like an Alaska borough, 15° x 8°) builds quickly.
const t1 = Date.now();
const big = buildLocator([{ id: 9, rings: [[[-160, 60], [-145, 60], [-145, 68], [-160, 68], [-160, 60]]] }]);
assert.deepEqual(big(-150, 64), [0]);
assert.deepEqual(big(-140, 64), []);
console.log(`huge county grid in ${Date.now() - t1} ms`);
