'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const INDEX_VERSION = 1;

async function loadCityIndex(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed?.version !== INDEX_VERSION || typeof parsed.cities !== 'object') {
      return new Map();
    }
    return new Map(Object.entries(parsed.cities).map(([code, entry]) => [Number(code), entry]));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return new Map();
    }
    throw error;
  }
}

async function saveCityIndex(file, index) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const cities = Object.fromEntries([...index.entries()].sort(([a], [b]) => a - b));
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ version: INDEX_VERSION, updatedAt: new Date().toISOString(), cities }, null, 2), 'utf8');
  await fs.rename(temp, file);
}

function planCities(cities, index, { full, maxAgeMs, now = Date.now() }) {
  const toScan = [];
  const skipped = [];
  for (const city of cities) {
    const entry = index.get(city.cityCode);
    const fresh = entry && now - Date.parse(entry.checkedAt) <= maxAgeMs;
    if (!full && fresh && entry.pharmacies === 0) {
      skipped.push(city);
    } else {
      toScan.push(city);
    }
  }

  const distance = (city) => index.get(city.cityCode)?.minDistanceKm ?? Number.POSITIVE_INFINITY;
  toScan.sort((a, b) => distance(a) - distance(b));
  return { toScan, skipped };
}

module.exports = { loadCityIndex, saveCityIndex, planCities };
