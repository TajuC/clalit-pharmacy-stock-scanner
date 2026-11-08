#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const pLimit = require('p-limit').default;
const { launchSession, ScanAbortedError, STOCK_CAPTCHA_ACTION } = require('./browser');
const { loadCityIndex, saveCityIndex, planCities } = require('./city-index');

const DEFAULT_TARGET_URL = 'https://e-services.clalit.co.il/PharmacyStock/';
const ASHKELON_COORDS = { lat: 31.6693, lon: 34.5715 };
const DEFAULT_INTERVAL_MS = 1500;

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      result[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    i += 1;
  }
  return result;
}

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback) {
  if (value === true) return true;
  const text = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function encodeBase64Utf8(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}

function directionRelativeToAshkelon(lat) {
  if (!Number.isFinite(lat)) {
    return '';
  }
  if (Math.abs(lat - ASHKELON_COORDS.lat) < 0.01) {
    return 'same_lat_band';
  }
  return lat < ASHKELON_COORDS.lat ? 'south' : 'north';
}

function htmlToText(value) {
  if (Array.isArray(value)) {
    return value.map(htmlToText).filter(Boolean).join(' ');
  }
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractOpeningHours(instructionHtml, isOpenNow) {
  const text = htmlToText(instructionHtml);
  const ranges = text.match(/\b\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\b/g) || [];
  if (ranges.length > 0) {
    return ranges.join(', ');
  }
  const match = text.match(/(?:שעות|hours?)\s*[:\-]?\s*([^.,;]+)/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  if (isOpenNow === true) {
    return 'Open now';
  }
  return '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(operation, retries) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ScanAbortedError || !error.retryable || attempt >= retries) {
        throw error;
      }
      await sleep(600 * (attempt + 1) + Math.floor(Math.random() * 400));
    }
  }
}

function pickMedication(candidates, requestedName) {
  const target = normalize(requestedName);
  const scored = candidates
    .map((med) => {
      const name = normalize(med.omryName);
      let score = 0;
      if (name === target) score += 100;
      if (name.startsWith(target)) score += 70;
      if (name.includes(target)) score += 50;
      if (target.includes(name)) score += 20;
      score += Math.max(0, 20 - Math.abs(name.length - target.length));
      return { med, score };
    })
    .sort((a, b) => b.score - a.score);

  return {
    selected: scored[0]?.med,
    ranked: scored.slice(0, 10)
  };
}

function stockRequestBody(cityCode, medication) {
  return {
    medicationsList: [
      {
        catCode: medication.catCode,
        omryName: medication.omryName,
        isApprovalRequired: Boolean(medication.isApprovalRequired)
      }
    ],
    location: {
      latitude: 0,
      longitude: 0,
      isError: false
    },
    UserSystem: 3,
    isGPSActive: false,
    cityCode
  };
}

function statusFromCode(code) {
  if (code === 30) return 'in_stock';
  if (code === 20) return 'limited_stock';
  if (code === 10) return 'no_info';
  if (code === 0) return 'out_of_stock';
  return 'unknown';
}

function cityRows({ city, checkedAt, data, selected }) {
  const base = {
    checkedAt,
    cityCode: city.cityCode,
    cityName: city.cityName,
    hasAnyResult: false,
    pharmaciesInCity: 0,
    pharmacyName: '',
    pharmacyCode: '',
    pharmacyAddress: '',
    pharmacyPhone: '',
    isOpenNow: '',
    openingHours: '',
    latCoord: '',
    lonCoord: '',
    distanceFromAshkelonKm: '',
    directionRelativeToAshkelon: '',
    medicationName: selected.omryName,
    medicationCode: selected.catCode,
    stockCode: '',
    availability: 'not_found'
  };

  const pharmacies = Array.isArray(data?.pharmaciesList) ? data.pharmaciesList : [];
  const hasAnyResult = pharmacies.length > 0 && !data?.isEmptyResult;
  if (!hasAnyResult) {
    return { hasAnyResult, pharmaciesCount: pharmacies.length, rows: [base] };
  }

  const rows = [];
  for (const pharmacy of pharmacies) {
    const latCoord = toNumber(pharmacy.latCoord);
    const lonCoord = toNumber(pharmacy.longCoord);
    const hasCoords = Number.isFinite(latCoord) && Number.isFinite(lonCoord);
    const pharmacyRow = {
      ...base,
      hasAnyResult: true,
      pharmaciesInCity: pharmacies.length,
      pharmacyName: pharmacy.pharmacyName,
      pharmacyCode: pharmacy.pharmacyCode,
      pharmacyAddress: htmlToText(pharmacy.pharmacyAdress),
      pharmacyPhone: pharmacy.pharmacyPhone,
      isOpenNow: pharmacy.ifOpenedNow,
      openingHours: extractOpeningHours(pharmacy.pharmacyInstruction, pharmacy.ifOpenedNow),
      latCoord: latCoord ?? '',
      lonCoord: lonCoord ?? '',
      distanceFromAshkelonKm: hasCoords
        ? Number(haversineKm(ASHKELON_COORDS.lat, ASHKELON_COORDS.lon, latCoord, lonCoord).toFixed(2))
        : '',
      directionRelativeToAshkelon: directionRelativeToAshkelon(latCoord),
      availability: 'unknown'
    };

    const meds = Array.isArray(pharmacy.medicationsList) ? pharmacy.medicationsList : [];
    if (meds.length === 0) {
      rows.push(pharmacyRow);
      continue;
    }
    for (const med of meds) {
      rows.push({
        ...pharmacyRow,
        medicationName: med.medicationName,
        medicationCode: med.medicationCode,
        stockCode: med.kodStatusMlay,
        availability: statusFromCode(med.kodStatusMlay)
      });
    }
  }
  return { hasAnyResult, pharmaciesCount: pharmacies.length, rows };
}

function sanitizeCsv(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

const CSV_COLUMNS = [
  'checkedAt',
  'cityCode',
  'cityName',
  'hasAnyResult',
  'pharmaciesInCity',
  'pharmacyName',
  'pharmacyCode',
  'pharmacyAddress',
  'pharmacyPhone',
  'isOpenNow',
  'openingHours',
  'latCoord',
  'lonCoord',
  'distanceFromAshkelonKm',
  'directionRelativeToAshkelon',
  'medicationName',
  'medicationCode',
  'stockCode',
  'availability'
];

async function writeOutputs({ outputDir, medicine, selectedMedication, citySummaries, rows, citiesSkipped, partialReason }) {
  await fs.mkdir(outputDir, { recursive: true });

  const stamp = nowStamp();
  const safeMedicine = normalize(medicine).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'medicine';
  const jsonPath = path.join(outputDir, `scan-${safeMedicine}-${stamp}.json`);
  const csvPath = path.join(outputDir, `scan-${safeMedicine}-${stamp}.csv`);

  const payload = {
    generatedAt: new Date().toISOString(),
    medicineQuery: medicine,
    selectedMedication,
    partial: Boolean(partialReason),
    partialReason: partialReason || '',
    totals: {
      citiesChecked: citySummaries.length,
      citiesSkipped,
      citiesWithResults: citySummaries.filter((x) => x.hasAnyResult).length,
      citiesFailed: citySummaries.filter((x) => x.error).length,
      pharmacyRows: rows.filter((x) => x.pharmacyName).length
    },
    citySummaries,
    rows
  };

  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => sanitizeCsv(row[column])).join(','));
  }
  // Excel only detects UTF-8 (and renders Hebrew correctly) when the file starts with a BOM.
  await fs.writeFile(csvPath, `﻿${lines.join('\r\n')}\r\n`, 'utf8');
  return { jsonPath, csvPath, totals: payload.totals };
}

function recordCity(index, city, result, checkedAt) {
  const distances = result.rows.map((row) => row.distanceFromAshkelonKm).filter((d) => typeof d === 'number');
  index.set(city.cityCode, {
    cityName: city.cityName,
    pharmacies: result.pharmaciesCount,
    minDistanceKm: distances.length > 0 ? Math.min(...distances) : null,
    checkedAt
  });
}

async function scan(session, config) {
  const { medicine, concurrency, maxCities, retries, cityCodeFilter, indexFile, full, indexMaxAgeDays } = config;

  const [cities, medCandidates] = await Promise.all([
    withRetries(() => session.request('Search/GetAllCitiesList', {}), retries),
    withRetries(
      () => session.request('Search/GetFilterefMedicationsList', { searchText: encodeBase64Utf8(medicine), isPrefix: true }),
      retries
    )
  ]);

  if (!Array.isArray(cities) || cities.length === 0) {
    throw new Error('No cities returned from API.');
  }
  if (!Array.isArray(medCandidates) || medCandidates.length === 0) {
    throw new Error(`No medication suggestions found for query: ${medicine}`);
  }

  const { selected, ranked } = pickMedication(medCandidates, medicine);
  if (!selected) {
    throw new Error('Unable to select a medication candidate.');
  }

  console.log('Selected medication:', `${selected.omryName} (catCode=${selected.catCode})`);
  console.log('Top candidates:');
  ranked.slice(0, 5).forEach((entry, idx) => {
    console.log(`  ${idx + 1}. score=${entry.score} | ${entry.med.omryName} | catCode=${entry.med.catCode}`);
  });

  const index = await loadCityIndex(indexFile);
  const filtered = cityCodeFilter > -1 ? cities.filter((c) => c.cityCode === cityCodeFilter) : cities;
  const plan = planCities(filtered, index, {
    full: full || cityCodeFilter > -1,
    maxAgeMs: indexMaxAgeDays * 24 * 60 * 60 * 1000
  });
  const checkedCities = maxCities > 0 ? plan.toScan.slice(0, maxCities) : plan.toScan;
  if (checkedCities.length === 0) {
    throw new Error(`No cities matched filters (cityCode=${cityCodeFilter > -1 ? cityCodeFilter : 'any'}, maxCities=${maxCities})`);
  }
  const unknown = checkedCities.filter((c) => !index.has(c.cityCode)).length;
  console.log(
    `Cities to scan: ${checkedCities.length}` +
      (plan.skipped.length ? ` (skipping ${plan.skipped.length} known to have no pharmacies; --full rescans them)` : '') +
      (unknown ? `, ${unknown} not yet in the city index` : '')
  );

  const limit = pLimit(concurrency);
  const citySummaries = [];
  const rows = [];
  let abortError = null;
  let completed = 0;
  let unsaved = 0;

  const persistIndex = () => saveCityIndex(indexFile, index).catch((error) => console.warn(`Could not save city index: ${error.message}`));

  const reportProgress = () => {
    completed += 1;
    if (completed % 25 === 0 || completed === checkedCities.length) {
      const failed = citySummaries.filter((x) => x.error).length;
      console.log(`Progress: ${completed}/${checkedCities.length}${failed ? ` (${failed} failed)` : ''}`);
    }
  };

  await Promise.all(
    checkedCities.map((city) =>
      limit(async () => {
        if (abortError) {
          return;
        }
        const checkedAt = new Date().toISOString();
        let data;
        try {
          data = await withRetries(
            () =>
              session.request('api/PharmacyStock/GetPharmacyStockByCityCode', stockRequestBody(city.cityCode, selected), {
                captchaAction: STOCK_CAPTCHA_ACTION
              }),
            retries
          );
        } catch (error) {
          if (error instanceof ScanAbortedError) {
            abortError ??= error;
            return;
          }
          citySummaries.push({
            cityCode: city.cityCode,
            cityName: city.cityName,
            hasAnyResult: false,
            pharmaciesCount: 0,
            error: error.message
          });
          reportProgress();
          return;
        }

        const result = cityRows({ city, checkedAt, data, selected });
        recordCity(index, city, result, checkedAt);
        unsaved += 1;
        if (unsaved >= 25) {
          unsaved = 0;
          await persistIndex();
        }
        citySummaries.push({
          cityCode: city.cityCode,
          cityName: city.cityName,
          hasAnyResult: result.hasAnyResult,
          pharmaciesCount: result.pharmaciesCount,
          isWsError: Boolean(data?.isWsError)
        });
        rows.push(...result.rows);
        reportProgress();
      })
    )
  );

  await persistIndex();
  citySummaries.sort((a, b) => a.cityCode - b.cityCode);
  return {
    selected,
    citySummaries,
    rows,
    citiesSkipped: plan.skipped.length,
    partialReason: abortError ? `${abortError.message} Stopped after ${completed} of ${checkedCities.length} cities.` : ''
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const medicine = args.medicine || process.env.MEDICINE_QUERY;
  if (!medicine || medicine === true) {
    throw new Error('Missing medicine query. Set MEDICINE_QUERY in .env or pass --medicine "VYVANSE 30MG"');
  }

  const config = {
    medicine,
    lang: args.lang || process.env.APP_LANG || 'he-il',
    targetUrl: process.env.TARGET_URL || DEFAULT_TARGET_URL,
    concurrency: Math.max(1, toInt(args.concurrency ?? process.env.CONCURRENCY, 2)),
    maxCities: Math.max(0, toInt(args.maxCities ?? process.env.MAX_CITIES, 0)),
    timeoutMs: Math.max(5000, toInt(args.timeoutMs ?? process.env.TIMEOUT_MS, 25000)),
    retries: Math.max(0, toInt(args.retries ?? process.env.RETRIES, 2)),
    cityCodeFilter: args.cityCode ? toInt(args.cityCode, -1) : -1,
    headed: toBool(args.headed ?? process.env.SHOW_BROWSER, false),
    slowMo: Math.max(0, toInt(args.slowMo ?? process.env.SLOW_MO, 0)),
    browserPath: (typeof args.browserPath === 'string' && args.browserPath) || process.env.BROWSER_PATH || '',
    intervalMs: Math.max(0, toInt(args.intervalMs ?? process.env.REQUEST_INTERVAL_MS, DEFAULT_INTERVAL_MS)),
    stallMs: Math.max(1, toInt(args.stallMinutes ?? process.env.STALL_MINUTES, 5)) * 60 * 1000,
    full: toBool(args.full, false),
    indexMaxAgeDays: Math.max(0, toInt(args.indexMaxAgeDays ?? process.env.INDEX_MAX_AGE_DAYS, 30)),
    onCooldown: (pauseMs) => console.warn(`The service rejected a request; pausing verified requests for ${Math.round(pauseMs / 1000)}s.`)
  };
  const outputDir = path.resolve(process.cwd(), 'output');
  config.indexFile = path.join(outputDir, 'city-index.json');

  console.log(`Scanning medicine: ${medicine}`);
  console.log(
    `Config -> lang=${config.lang}, concurrency=${config.concurrency}, intervalMs=${config.intervalMs}, maxCities=${config.maxCities || 'all'}, timeoutMs=${config.timeoutMs}, retries=${config.retries}`
  );

  const session = await launchSession(config);
  console.log(`Browser: ${session.executable}${config.headed ? '' : ' (minimized)'}`);
  if (session.recaptchaActive) {
    console.log('Stock requests are verified by reCAPTCHA; keep the browser window open until the scan finishes.');
  }

  const onSignal = () => {
    console.error('Interrupted, closing browser...');
    session.close().finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let result;
  try {
    result = await scan(session, config);
  } finally {
    await session.close();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  const { selected, citySummaries, rows, citiesSkipped, partialReason } = result;
  const failed = citySummaries.filter((x) => x.error);
  if (failed.length === citySummaries.length) {
    const reason = partialReason || (failed[0] ? `First error: ${failed[0].error}` : '');
    throw new Error(`No city could be checked; no output written. ${reason}`.trim());
  }

  const { jsonPath, csvPath, totals } = await writeOutputs({
    outputDir,
    medicine,
    selectedMedication: selected,
    citySummaries,
    rows,
    citiesSkipped,
    partialReason
  });

  console.log(partialReason ? '--- Scan Stopped Early ---' : '--- Scan Completed ---');
  console.log(`Cities checked: ${totals.citiesChecked}${citiesSkipped ? ` (${citiesSkipped} skipped via city index)` : ''}`);
  console.log(`Cities with results: ${totals.citiesWithResults}`);
  console.log(`Pharmacy rows: ${totals.pharmacyRows}`);
  if (totals.citiesFailed > 0) {
    console.warn(`Cities failed: ${totals.citiesFailed} (see citySummaries[].error in the JSON). First error: ${failed[0].error}`);
  }
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV: ${csvPath}`);
  if (partialReason) {
    console.warn(`PARTIAL SCAN: ${partialReason} Run the scan again later; cities already indexed are scanned first.`);
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Scan failed:', error.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, toBool, htmlToText, extractOpeningHours, pickMedication, cityRows, sanitizeCsv, withRetries };
