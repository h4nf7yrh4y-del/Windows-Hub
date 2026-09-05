'use strict';

/**
 * Tests for the GPU counter aggregation.
 *
 * The data below mirrors what Windows actually reports through
 * Win32_PerfFormattedData_GPUPerformanceCounters_* so the vendor-neutral path
 * can be verified without a Windows machine to hand.
 */

const assert = require('assert');
const gpu = require('../src/main/gpu');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('GPU counter aggregation');

/* ------------------------------------------------ single AMD discrete card */

// Radeon RX 6800 running a game: 3D engine busy across two processes,
// video decode idle-ish, 8.2 GB of 16 GB dedicated memory in use.
const AMD_ENGINES = [
  { Name: 'pid_5120_luid_0x00000000_0x0000C4B7_phys_0_eng_0_engtype_3D', UtilizationPercentage: 71.4 },
  { Name: 'pid_5120_luid_0x00000000_0x0000C4B7_phys_0_eng_1_engtype_3D', UtilizationPercentage: 12.1 },
  { Name: 'pid_9184_luid_0x00000000_0x0000C4B7_phys_0_eng_0_engtype_3D', UtilizationPercentage: 3.5 },
  { Name: 'pid_5120_luid_0x00000000_0x0000C4B7_phys_0_eng_2_engtype_Copy', UtilizationPercentage: 4.2 },
  { Name: 'pid_3312_luid_0x00000000_0x0000C4B7_phys_0_eng_4_engtype_VideoDecode', UtilizationPercentage: 9.8 }
];
const AMD_MEMORY = [
  { Name: 'luid_0x00000000_0x0000C4B7_phys_0', DedicatedUsage: 8804600000, SharedUsage: 412000000 }
];

test('AMD card yields one adapter with a load value', () => {
  const out = gpu.aggregate(AMD_ENGINES, AMD_MEMORY);
  assert.strictEqual(out.length, 1, 'expected exactly one LUID group');
  assert.strictEqual(out[0].luid, '0x00000000_0x0000C4B7');
});

test('processes on the same engine type are summed', () => {
  const out = gpu.aggregate(AMD_ENGINES, AMD_MEMORY);
  // 71.4 + 12.1 + 3.5 = 87.0 across the 3D engine
  assert.ok(Math.abs(out[0].breakdown['3D'] - 87.0) < 0.001,
    `3D should be 87.0, got ${out[0].breakdown['3D']}`);
});

test('load is the busiest engine, not the sum of all engines', () => {
  const out = gpu.aggregate(AMD_ENGINES, AMD_MEMORY);
  // Engines run in parallel; summing them would report 101% here.
  assert.ok(Math.abs(out[0].load - 87.0) < 0.001, `load should be 87.0, got ${out[0].load}`);
  assert.ok(out[0].load <= 100, 'load must never exceed 100');
});

test('engine types get readable labels', () => {
  const out = gpu.aggregate(AMD_ENGINES, AMD_MEMORY);
  const labels = Object.keys(out[0].breakdown).sort();
  assert.deepStrictEqual(labels, ['3D', 'Kopieren', 'Video-Dekodierung'].sort());
});

test('dedicated and shared memory are carried through', () => {
  const out = gpu.aggregate(AMD_ENGINES, AMD_MEMORY);
  assert.strictEqual(out[0].memUsedBytes, 8804600000);
  assert.strictEqual(out[0].memSharedBytes, 412000000);
});

/* ----------------------------------------------------- laptop: iGPU + dGPU */

const HYBRID_ENGINES = [
  // Intel iGPU driving the desktop
  { Name: 'pid_1044_luid_0x00000000_0x0000A11F_phys_0_eng_0_engtype_3D', UtilizationPercentage: 8.4 },
  // AMD dGPU running the game
  { Name: 'pid_7788_luid_0x00000000_0x0000B22E_phys_0_eng_0_engtype_3D', UtilizationPercentage: 94.2 }
];
const HYBRID_MEMORY = [
  { Name: 'luid_0x00000000_0x0000A11F_phys_0', DedicatedUsage: 130000000, SharedUsage: 900000000 },
  { Name: 'luid_0x00000000_0x0000B22E_phys_0', DedicatedUsage: 6100000000, SharedUsage: 200000 }
];

test('two GPUs stay separate instead of being summed', () => {
  const out = gpu.aggregate(HYBRID_ENGINES, HYBRID_MEMORY);
  assert.strictEqual(out.length, 2);
  const loads = out.map((a) => Math.round(a.load)).sort((a, b) => a - b);
  assert.deepStrictEqual(loads, [8, 94]);
});

test('the busiest counter group pairs with the largest adapter', () => {
  const controllers = [
    { index: 0, model: 'Intel(R) Iris(R) Xe Graphics', vramTotal: 128 * 1024 * 1024 },
    { index: 1, model: 'AMD Radeon RX 7600M XT', vramTotal: 8 * 1024 * 1024 * 1024 }
  ];
  const paired = gpu.pairAdapters(controllers, gpu.aggregate(HYBRID_ENGINES, HYBRID_MEMORY));
  const radeon = paired.find((p) => p.model.includes('Radeon'));
  const intel = paired.find((p) => p.model.includes('Intel'));
  assert.ok(radeon.counters, 'Radeon should have counters attached');
  assert.ok(Math.abs(radeon.counters.load - 94.2) < 0.001,
    `Radeon should carry the 94.2% group, got ${radeon.counters.load}`);
  assert.ok(Math.abs(intel.counters.load - 8.4) < 0.001,
    `Intel should carry the 8.4% group, got ${intel.counters.load}`);
});

test('a single adapter always takes the only counter group', () => {
  const controllers = [{ index: 0, model: 'AMD Radeon RX 6800', vramTotal: 16 * 1024 * 1024 * 1024 }];
  const paired = gpu.pairAdapters(controllers, gpu.aggregate(AMD_ENGINES, AMD_MEMORY));
  assert.strictEqual(paired.length, 1);
  assert.ok(Math.abs(paired[0].counters.load - 87.0) < 0.001);
});

/* -------------------------------------------------------------- edge cases */

test('an idle GPU reports zero rather than throwing', () => {
  const out = gpu.aggregate([], AMD_MEMORY);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].load, 0);
  assert.deepStrictEqual(out[0].breakdown, {});
});

test('no counters at all yields an empty list', () => {
  assert.deepStrictEqual(gpu.aggregate([], []), []);
  assert.deepStrictEqual(gpu.aggregate(null, undefined), []);
});

test('a single WMI row arriving unwrapped is handled', () => {
  // ConvertTo-Json emits a bare object, not an array, for one-element results.
  const out = gpu.aggregate(AMD_ENGINES[0], AMD_MEMORY[0]);
  assert.strictEqual(out.length, 1);
  assert.ok(Math.abs(out[0].load - 71.4) < 0.001);
});

test('unparsable instance names are skipped, not fatal', () => {
  const out = gpu.aggregate(
    [{ Name: 'something_unexpected', UtilizationPercentage: 50 }].concat(AMD_ENGINES),
    AMD_MEMORY
  );
  assert.strictEqual(out.length, 1);
  assert.ok(Math.abs(out[0].load - 87.0) < 0.001);
});

test('a value above 100 from summed processes is clamped', () => {
  const out = gpu.aggregate([
    { Name: 'pid_1_luid_0x0_0x1_phys_0_eng_0_engtype_3D', UtilizationPercentage: 80 },
    { Name: 'pid_2_luid_0x0_0x1_phys_0_eng_1_engtype_3D', UtilizationPercentage: 70 }
  ], []);
  assert.strictEqual(out[0].load, 100);
  assert.strictEqual(out[0].breakdown['3D'], 100);
});

test('NVIDIA instance names parse identically', () => {
  const out = gpu.aggregate([
    { Name: 'pid_4020_luid_0x00000000_0x0000F1A2_phys_0_eng_0_engtype_Graphics_1', UtilizationPercentage: 63.7 }
  ], [{ Name: 'luid_0x00000000_0x0000F1A2_phys_0', DedicatedUsage: 4200000000, SharedUsage: 0 }]);
  assert.strictEqual(out.length, 1);
  // Graphics_1 is the NVIDIA spelling of the 3D engine.
  assert.ok(Math.abs(out[0].breakdown['3D'] - 63.7) < 0.001);
});

test('adapters without counters still come back from pairing', () => {
  const controllers = [{ index: 0, model: 'AMD Radeon RX 580', vramTotal: 8 * 1024 * 1024 * 1024 }];
  const paired = gpu.pairAdapters(controllers, []);
  assert.strictEqual(paired.length, 1);
  assert.strictEqual(paired[0].counters, null);
});

console.log(`\n${passed} assertions passed.`);
if (process.exitCode) console.error('Some GPU tests failed.');
