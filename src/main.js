#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const pLimit = require('p-limit').default;

const BASE_URL = 'https://e-services.clalit.co.il/PharmacyStockCoreAPI';
const SEARCH_BASE = `${BASE_URL}/Search`;
const API_BASE = `${BASE_URL}/api`;
const ASHKELON_COORDS = { lat: 31.6693, lon: 34.5715 };

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
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

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url, body, timeoutMs, retries) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          referer: 'https://e-services.clalit.co.il/PharmacyStock/'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const contentType = response.headers.get('content-type') || '';
      const text = await response.text();

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} at ${url}`);
      }

      if (!contentType.toLowerCase().includes('application/json')) {
        const snippet = text.slice(0, 120).replace(/\s+/g, ' ');
        throw new Error(`Non-JSON response at ${url}: ${snippet}`);
      }

      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt >= retries;
      if (isLastAttempt) {
        break;
      }

      const delay = 400 * (attempt + 1) + Math.floor(Math.random() * 250);
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

async function getAllCities(lang, timeoutMs, retries) {
  return postJson(`${SEARCH_BASE}/GetAllCitiesList?lang=${encodeURIComponent(lang)}`, {}, timeoutMs, retries);
}

async function searchMedications(query, lang, timeoutMs, retries) {
  return postJson(
    `${SEARCH_BASE}/GetFilterefMedicationsList?lang=${encodeURIComponent(lang)}`,
    { searchText: encodeBase64Utf8(query), isPrefix: true },
    timeoutMs,
    retries
  );
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

async function getStockByCity({ cityCode, medication, lang, timeoutMs, retries }) {
  const body = {
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

  return postJson(
    `${API_BASE}/PharmacyStock/GetPharmacyStockByCityCode?lang=${encodeURIComponent(lang)}`,
    body,
    timeoutMs,
    retries
  );
}

function statusFromCode(code) {
  if (code === 30) return 'in_stock';
  if (code === 20) return 'limited_stock';
  if (code === 10) return 'no_info';
  if (code === 0) return 'out_of_stock';
  return 'unknown';
}

function sanitizeCsv(value) {
  const text = String(value ?? '');
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

async function writeOutputs({ outputDir, medicine, selectedMedication, citySummaries, rows }) {
  await fs.mkdir(outputDir, { recursive: true });

  const stamp = nowStamp();
  const safeMedicine = normalize(medicine).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'medicine';
  const jsonPath = path.join(outputDir, `scan-${safeMedicine}-${stamp}.json`);
  const csvPath = path.join(outputDir, `scan-${safeMedicine}-${stamp}.csv`);

  const payload = {
    generatedAt: new Date().toISOString(),
    medicineQuery: medicine,
    selectedMedication,
    totals: {
      citiesChecked: citySummaries.length,
      citiesWithResults: citySummaries.filter((x) => x.hasAnyResult).length,
      pharmacyRows: rows.length
    },
    citySummaries,
    rows
  };

  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

  const header = [
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

  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.checkedAt,
        row.cityCode,
        row.cityName,
        row.hasAnyResult,
        row.pharmaciesInCity,
        row.pharmacyName,
        row.pharmacyCode,
        row.pharmacyAddress,
        row.pharmacyPhone,
        row.isOpenNow,
        row.openingHours,
        row.latCoord,
        row.lonCoord,
        row.distanceFromAshkelonKm,
        row.directionRelativeToAshkelon,
        row.medicationName,
        row.medicationCode,
        row.stockCode,
        row.availability
      ]
        .map(sanitizeCsv)
        .join(',')
    );
  }

  await fs.writeFile(csvPath, `${lines.join('\n')}\n`, 'utf8');
  return { jsonPath, csvPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const medicine = args.medicine || process.env.MEDICINE_QUERY;
  if (!medicine) {
    throw new Error('Missing medicine query. Set MEDICINE_QUERY in .env or pass --medicine "VYVANSE 30MG"');
  }

  const lang = args.lang || process.env.APP_LANG || 'he-il';
  const concurrency = Math.max(1, toInt(args.concurrency ?? process.env.CONCURRENCY, 6));
  const maxCities = Math.max(0, toInt(args.maxCities ?? process.env.MAX_CITIES, 0));
  const timeoutMs = Math.max(5000, toInt(args.timeoutMs ?? process.env.TIMEOUT_MS, 25000));
  const retries = Math.max(0, toInt(args.retries ?? process.env.RETRIES, 2));
  const cityCodeFilter = args.cityCode ? toInt(args.cityCode, -1) : -1;
  const outputDir = path.resolve(process.cwd(), 'output');

  console.log(`Scanning medicine: ${medicine}`);
  console.log(`Config -> lang=${lang}, concurrency=${concurrency}, maxCities=${maxCities || 'all'}, timeoutMs=${timeoutMs}, retries=${retries}`);

  const [cities, medCandidates] = await Promise.all([
    getAllCities(lang, timeoutMs, retries),
    searchMedications(medicine, lang, timeoutMs, retries)
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

  let checkedCities = cityCodeFilter > -1 ? cities.filter((c) => c.cityCode === cityCodeFilter) : cities;
  if (maxCities > 0) {
    checkedCities = checkedCities.slice(0, maxCities);
  }
  if (checkedCities.length === 0) {
    throw new Error(`No cities matched filters (cityCode=${cityCodeFilter > -1 ? cityCodeFilter : 'any'}, maxCities=${maxCities})`);
  }
  console.log(`Cities to scan: ${checkedCities.length}`);

  const limit = pLimit(concurrency);
  const citySummaries = [];
  const rows = [];
  let completed = 0;

  await Promise.all(
    checkedCities.map((city) =>
      limit(async () => {
        const checkedAt = new Date().toISOString();
        let data;
        try {
          data = await getStockByCity({
            cityCode: city.cityCode,
            medication: selected,
            lang,
            timeoutMs,
            retries
          });
        } catch (error) {
          citySummaries.push({
            cityCode: city.cityCode,
            cityName: city.cityName,
            hasAnyResult: false,
            pharmaciesCount: 0,
            error: error.message
          });
          completed += 1;
          if (completed % 25 === 0 || completed === checkedCities.length) {
            console.log(`Progress: ${completed}/${checkedCities.length}`);
          }
          return;
        }

        const pharmacies = Array.isArray(data?.pharmaciesList) ? data.pharmaciesList : [];
        const hasAnyResult = pharmacies.length > 0 && !data?.isEmptyResult;
        citySummaries.push({
          cityCode: city.cityCode,
          cityName: city.cityName,
          hasAnyResult,
          pharmaciesCount: pharmacies.length,
          isWsError: Boolean(data?.isWsError)
        });

        if (!hasAnyResult) {
          rows.push({
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
          });
        } else {
          for (const pharmacy of pharmacies) {
            const latCoord = toNumber(pharmacy.latCoord);
            const lonCoord = toNumber(pharmacy.longCoord);
            const distanceFromAshkelonKm =
              Number.isFinite(latCoord) && Number.isFinite(lonCoord)
                ? Number(haversineKm(ASHKELON_COORDS.lat, ASHKELON_COORDS.lon, latCoord, lonCoord).toFixed(2))
                : '';
            const direction = directionRelativeToAshkelon(latCoord);
            const openingHours = extractOpeningHours(pharmacy.pharmacyInstruction, pharmacy.ifOpenedNow);
            const meds = Array.isArray(pharmacy.medicationsList) ? pharmacy.medicationsList : [];
            if (meds.length === 0) {
              rows.push({
                checkedAt,
                cityCode: city.cityCode,
                cityName: city.cityName,
                hasAnyResult: true,
                pharmaciesInCity: pharmacies.length,
                pharmacyName: pharmacy.pharmacyName,
                pharmacyCode: pharmacy.pharmacyCode,
                pharmacyAddress: pharmacy.pharmacyAdress,
                pharmacyPhone: pharmacy.pharmacyPhone,
                isOpenNow: pharmacy.ifOpenedNow,
                openingHours,
                latCoord,
                lonCoord,
                distanceFromAshkelonKm,
                directionRelativeToAshkelon: direction,
                medicationName: selected.omryName,
                medicationCode: selected.catCode,
                stockCode: '',
                availability: 'unknown'
              });
              continue;
            }

            for (const med of meds) {
              rows.push({
                checkedAt,
                cityCode: city.cityCode,
                cityName: city.cityName,
                hasAnyResult: true,
                pharmaciesInCity: pharmacies.length,
                pharmacyName: pharmacy.pharmacyName,
                pharmacyCode: pharmacy.pharmacyCode,
                pharmacyAddress: pharmacy.pharmacyAdress,
                pharmacyPhone: pharmacy.pharmacyPhone,
                isOpenNow: pharmacy.ifOpenedNow,
                openingHours,
                latCoord,
                lonCoord,
                distanceFromAshkelonKm,
                directionRelativeToAshkelon: direction,
                medicationName: med.medicationName,
                medicationCode: med.medicationCode,
                stockCode: med.kodStatusMlay,
                availability: statusFromCode(med.kodStatusMlay)
              });
            }
          }
        }

        completed += 1;
        if (completed % 25 === 0 || completed === checkedCities.length) {
          console.log(`Progress: ${completed}/${checkedCities.length}`);
        }
      })
    )
  );

  citySummaries.sort((a, b) => a.cityCode - b.cityCode);

  const { jsonPath, csvPath } = await writeOutputs({
    outputDir,
    medicine,
    selectedMedication: selected,
    citySummaries,
    rows
  });

  const citiesWithResults = citySummaries.filter((x) => x.hasAnyResult).length;
  console.log('--- Scan Completed ---');
  console.log(`Cities checked: ${citySummaries.length}`);
  console.log(`Cities with results: ${citiesWithResults}`);
  console.log(`Rows written: ${rows.length}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV: ${csvPath}`);
}

main().catch((error) => {
  console.error('Scan failed:', error.message);
  process.exit(1);
});
