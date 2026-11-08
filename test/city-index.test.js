'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadCityIndex, saveCityIndex, planCities } = require('../src/city-index');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-11-08T12:00:00Z');
const at = (daysAgo) => new Date(now - daysAgo * DAY).toISOString();

const cities = [
  { cityCode: 1, cityName: 'far with pharmacies' },
  { cityCode: 2, cityName: 'empty, fresh' },
  { cityCode: 3, cityName: 'unknown' },
  { cityCode: 4, cityName: 'near with pharmacies' },
  { cityCode: 5, cityName: 'empty, stale' }
];

const index = new Map([
  [1, { pharmacies: 3, minDistanceKm: 80, checkedAt: at(1) }],
  [2, { pharmacies: 0, minDistanceKm: null, checkedAt: at(1) }],
  [4, { pharmacies: 9, minDistanceKm: 0.6, checkedAt: at(1) }],
  [5, { pharmacies: 0, minDistanceKm: null, checkedAt: at(45) }]
]);

test('planCities skips fresh empty cities and orders by known distance', () => {
  const plan = planCities(cities, index, { full: false, maxAgeMs: 30 * DAY, now });
  assert.deepEqual(plan.toScan.map((c) => c.cityCode), [4, 1, 3, 5]);
  assert.deepEqual(plan.skipped.map((c) => c.cityCode), [2]);
});

test('planCities with full rescans everything', () => {
  const plan = planCities(cities, index, { full: true, maxAgeMs: 30 * DAY, now });
  assert.equal(plan.toScan.length, cities.length);
  assert.equal(plan.skipped.length, 0);
});

test('planCities with an empty index scans every city in the original order', () => {
  const plan = planCities(cities, new Map(), { full: false, maxAgeMs: 30 * DAY, now });
  assert.deepEqual(plan.toScan.map((c) => c.cityCode), [1, 2, 3, 4, 5]);
});

test('city index round trips and tolerates missing or corrupt files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'city-index-test-'));
  try {
    const file = path.join(dir, 'nested', 'city-index.json');
    assert.equal((await loadCityIndex(file)).size, 0);

    await saveCityIndex(file, index);
    const loaded = await loadCityIndex(file);
    assert.deepEqual([...loaded.keys()], [1, 2, 4, 5]);
    assert.deepEqual(loaded.get(4), index.get(4));

    await fs.writeFile(file, '{ not json', 'utf8');
    assert.equal((await loadCityIndex(file)).size, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
