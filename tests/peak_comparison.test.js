const test = require('node:test');
const assert = require('node:assert/strict');
const { buildComparisonMatrix } = require('../peak_comparison');

const spectra = [
  { id: 'before', name: 'before', role: 'before' },
  { id: 'after', name: 'after', role: 'after' },
];

test('builds presence matrix and classifies before/after changes', () => {
  const comparison = buildComparisonMatrix(spectra, [
    { id: 'before-100', spectrumId: 'before', nu: 100, prominence: 1, fwhmCm1: 10 },
    { id: 'before-300', spectrumId: 'before', nu: 300, prominence: 2, fwhmCm1: 12 },
    { id: 'after-105', spectrumId: 'after', nu: 105, prominence: 1.5, fwhmCm1: 14 },
    { id: 'after-500', spectrumId: 'after', nu: 500, prominence: 3, fwhmCm1: 8 },
  ], { toleranceCm1: 8, shiftThresholdCm1: 2 });

  assert.equal(comparison.baselineSpectrumId, 'before');
  assert.deepEqual(comparison.comparisonSpectrumIds, ['after']);
  assert.equal(comparison.matrix.length, 3);
  assert.ok(comparison.changes.some((change) => change.type === 'shifted_peak' && change.deltaNu === 5));
  assert.ok(comparison.changes.some((change) => change.type === 'disappeared_peak' && change.fromNu === 300));
  assert.ok(comparison.changes.some((change) => change.type === 'appeared_peak' && change.toNu === 500));

  const shiftedRow = comparison.matrix.find((row) => row.presence.every((item) => item.present));
  assert.deepEqual(shiftedRow.presence.map((item) => item.nu), [100, 105]);
});

test('uses an explicit before role even when it is not first', () => {
  const comparison = buildComparisonMatrix([
    { id: 'after', role: 'after' },
    { id: 'before', role: 'before' },
  ], [
    { id: 'before-100', spectrumId: 'before', nu: 100 },
    { id: 'after-110', spectrumId: 'after', nu: 110 },
  ], { toleranceCm1: 15, shiftThresholdCm1: 2 });

  assert.equal(comparison.baselineSpectrumId, 'before');
  assert.equal(comparison.changes[0].fromSpectrumId, 'before');
  assert.equal(comparison.changes[0].toSpectrumId, 'after');
});

test('ignores metric noise below configured change thresholds', () => {
  const comparison = buildComparisonMatrix(spectra, [
    { id: 'before-100', spectrumId: 'before', nu: 100, prominence: 1, fwhmCm1: 10 },
    { id: 'after-100', spectrumId: 'after', nu: 100.2, prominence: 1.01, fwhmCm1: 10.2 },
  ], { toleranceCm1: 8, shiftThresholdCm1: 2, prominenceChangeThreshold: 0.05, widthChangeThreshold: 1 });

  assert.equal(comparison.changes.length, 0);
});
