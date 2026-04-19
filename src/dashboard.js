#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const ASHKELON_COORDS = { lat: 31.6693, lon: 34.5715 };

function parsePort(argv) {
  const idx = argv.findIndex((arg) => arg === '--port');
  if (idx === -1) return Number(process.env.DASHBOARD_PORT || 8787);
  const value = Number.parseInt(argv[idx + 1] || '', 10);
  return Number.isFinite(value) ? value : 8787;
}

async function getLatestScan(outputDir) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /^scan-.*\.json$/i.test(entry.name))
    .map((entry) => entry.name);

  if (files.length === 0) {
    return null;
  }

  const withStats = await Promise.all(
    files.map(async (name) => {
      const filePath = path.join(outputDir, name);
      const stat = await fs.stat(filePath);
      return { name, filePath, mtimeMs: stat.mtimeMs };
    })
  );

  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = withStats[0];
  const content = await fs.readFile(latest.filePath, 'utf8');
  const parsed = JSON.parse(content);
  return {
    fileName: latest.name,
    data: parsed
  };
}

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

function directionFromLat(lat) {
  if (!Number.isFinite(lat)) return '';
  if (Math.abs(lat - ASHKELON_COORDS.lat) < 0.01) return 'same_lat_band';
  return lat < ASHKELON_COORDS.lat ? 'south' : 'north';
}

function availabilityFromCode(stockCode, fallback) {
  const code = Number.parseInt(String(stockCode ?? ''), 10);
  if (Number.isFinite(code)) {
    if (code === 30) return 'in_stock';
    if (code === 20) return 'limited_stock';
    if (code === 10) return 'no_info';
    if (code === 0) return 'out_of_stock';
  }
  return String(fallback ?? 'unknown').toLowerCase();
}

function renderHtml(payload) {
  const hasData = Boolean(payload);
  const allRows = hasData ? payload.data.rows || [] : [];
  const rows = allRows
    .map((row) => ({
      ...row,
      effectiveAvailability: availabilityFromCode(row.stockCode, row.availability),
      effectiveLat: toNumber(row.latCoord),
      effectiveLon: toNumber(row.lonCoord),
      effectiveDistance:
        toNumber(row.distanceFromAshkelonKm) ??
        (Number.isFinite(toNumber(row.latCoord)) && Number.isFinite(toNumber(row.lonCoord))
          ? Number(haversineKm(ASHKELON_COORDS.lat, ASHKELON_COORDS.lon, toNumber(row.latCoord), toNumber(row.lonCoord)).toFixed(2))
          : Number.POSITIVE_INFINITY),
      effectiveDirection: row.directionRelativeToAshkelon || directionFromLat(toNumber(row.latCoord))
    }))
    .filter((row) => Boolean(row.pharmacyName));

  const cityMinDistance = new Map();
  for (const row of rows) {
    const current = cityMinDistance.get(row.cityName);
    if (!current || row.effectiveDistance < current) {
      cityMinDistance.set(row.cityName, row.effectiveDistance);
    }
  }

  const hometownNames = new Set(['אשקלון', 'ashkelon']);
  rows.sort((a, b) => {
    const aHome = hometownNames.has(String(a.cityName || '').toLowerCase()) ? 0 : 1;
    const bHome = hometownNames.has(String(b.cityName || '').toLowerCase()) ? 0 : 1;
    if (aHome !== bHome) return aHome - bHome;

    const aCityDist = cityMinDistance.get(a.cityName) ?? Number.POSITIVE_INFINITY;
    const bCityDist = cityMinDistance.get(b.cityName) ?? Number.POSITIVE_INFINITY;
    if (aCityDist !== bCityDist) return aCityDist - bCityDist;

    const aSouth = a.effectiveDirection === 'south' ? 0 : 1;
    const bSouth = b.effectiveDirection === 'south' ? 0 : 1;
    if (aSouth !== bSouth) return aSouth - bSouth;

    if (a.cityName !== b.cityName) return String(a.cityName).localeCompare(String(b.cityName), 'he');
    if (a.effectiveDistance !== b.effectiveDistance) return a.effectiveDistance - b.effectiveDistance;
    return String(a.pharmacyName).localeCompare(String(b.pharmacyName), 'he');
  });
  const totals = hasData ? payload.data.totals || {} : {};
  const generatedAt = hasData ? payload.data.generatedAt : '';
  const medicine = hasData ? payload.data.medicineQuery : '';
  const fileName = hasData ? payload.fileName : '';

  const rowHtml = rows
    .slice(0, 3000)
    .map((row) => {
      const availability = escapeHtml(row.effectiveAvailability);
      const availabilityClass = availability === 'in_stock' ? 'ok' : availability === 'limited_stock' ? 'warn' : 'na';
      return `
      <tr>
        <td class="city-cell">${escapeHtml(row.cityName)}</td>
        <td>${escapeHtml(row.pharmacyName)}</td>
        <td>${escapeHtml(row.pharmacyAddress)}</td>
        <td>${escapeHtml(row.pharmacyPhone)}</td>
        <td>${escapeHtml(row.openingHours || row.isOpenNow || '')}</td>
        <td>${escapeHtml(Number.isFinite(row.effectiveDistance) ? row.effectiveDistance.toFixed(2) : '')}</td>
        <td>${escapeHtml(row.effectiveDirection)}</td>
        <td>${escapeHtml(row.medicationName)}</td>
        <td class="availability-cell"><span class="pill ${availabilityClass}">${availability}</span></td>
        <td>${escapeHtml(row.stockCode)}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pharmacy Stock Dashboard</title>
  <style>
    :root {
      --bg: #eef4f5;
      --card: #ffffff;
      --ink: #17202b;
      --muted: #5e6f82;
      --line: #d4dee4;
      --ok: #0f8f6f;
      --warn: #b46908;
      --na: #6b7f93;
      --accent: #0b7d88;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Segoe UI, Tahoma, sans-serif;
      background: radial-gradient(circle at top right, #dceff1 0%, var(--bg) 46%, #ecf3f8 100%);
      color: var(--ink);
    }
    .wrap { max-width: 1500px; margin: 0 auto; padding: 20px; }
    .head {
      background: linear-gradient(135deg, #086e8f, #1f8e97);
      color: #fff;
      border-radius: 16px;
      padding: 18px 22px;
      box-shadow: 0 12px 30px rgba(10, 66, 84, 0.2);
    }
    .title { margin: 0; font-size: 42px; font-weight: 800; letter-spacing: 0.01em; }
    .meta { margin-top: 8px; opacity: 0.95; font-size: 14px; line-height: 1.4; }
    .cards {
      margin-top: 16px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 10px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px 14px;
    }
    .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
    .value { margin-top: 5px; font-size: 34px; font-weight: 800; }
    .toolbar {
      margin-top: 16px;
      display: grid;
      grid-template-columns: 1.2fr 1.2fr auto auto auto auto;
      gap: 10px;
      align-items: center;
    }
    .input {
      width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: #fff;
    }
    .toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      background: #fff;
      border: 1px solid var(--line);
      padding: 10px 12px;
      border-radius: 10px;
      font-size: 14px;
      white-space: nowrap;
    }
    .btn {
      border: 0;
      border-radius: 10px;
      background: var(--accent);
      color: #fff;
      padding: 10px 14px;
      cursor: pointer;
      font-weight: 700;
      white-space: nowrap;
    }
    .btn.secondary {
      background: #5a7182;
    }
    .table-status {
      margin-top: 10px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 600;
    }
    .table-wrap {
      margin-top: 10px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #fff;
      max-height: 68vh;
      overflow: auto;
      box-shadow: 0 8px 22px rgba(30, 60, 75, 0.06);
    }
    table {
      width: max-content;
      min-width: 100%;
      border-collapse: collapse;
    }
    thead th {
      position: sticky;
      top: 0;
      background: #f6fafc;
      border-bottom: 1px solid var(--line);
      z-index: 2;
    }
    th, td {
      text-align: left;
      font-size: 12.5px;
      padding: 9px 10px;
      border-bottom: 1px solid #ecf2f4;
      white-space: nowrap;
    }
    tbody tr:nth-child(even) { background: #fbfdfe; }
    tbody tr:hover { background: #eef6f8; }
    th:first-child, td:first-child {
      position: sticky;
      left: 0;
      background: inherit;
      z-index: 1;
      box-shadow: 1px 0 0 #e4edf2;
    }
    thead th:first-child { z-index: 3; }
    .table-wrap::-webkit-scrollbar {
      width: 12px;
      height: 12px;
    }
    .table-wrap::-webkit-scrollbar-thumb {
      background: #b5c7d3;
      border-radius: 999px;
      border: 3px solid #eef4f8;
    }
    .pill { display: inline-block; border-radius: 999px; padding: 4px 9px; font-size: 12px; color: #fff; }
    .pill.ok { background: var(--ok); }
    .pill.warn { background: var(--warn); }
    .pill.na { background: var(--na); }
    .empty {
      margin-top: 18px;
      padding: 16px;
      border-radius: 10px;
      border: 1px dashed #8aa8b0;
      background: rgba(255,255,255,.6);
    }
    @media (max-width: 1200px) {
      .toolbar {
        grid-template-columns: 1fr 1fr;
      }
    }
    @media (max-width: 780px) {
      .title { font-size: 30px; }
      .toolbar {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h1 class="title">Pharmacy Stock Dashboard</h1>
      <div class="meta">Medicine: ${escapeHtml(medicine)} | Generated: ${escapeHtml(generatedAt)} | File: ${escapeHtml(fileName)}</div>
    </div>

    ${hasData ? `
    <div class="cards">
      <div class="card"><div class="label">Cities Checked</div><div class="value">${escapeHtml(totals.citiesChecked)}</div></div>
      <div class="card"><div class="label">Cities With Results</div><div class="value">${escapeHtml(totals.citiesWithResults)}</div></div>
      <div class="card"><div class="label">Rows With Medicine</div><div class="value">${escapeHtml(rows.length)}</div></div>
      <div class="card"><div class="label">Sorted From Hometown</div><div class="value">Ashkelon</div></div>
    </div>

    <div class="toolbar">
      <input id="cityFilter" class="input" placeholder="Filter by city" />
      <input id="availabilityFilter" class="input" placeholder="Filter by availability (in_stock / limited_stock / out_of_stock / no_info)" />
      <label class="toggle">
        <input id="existsOnly" type="checkbox" checked />
        Show only branches with real stock
      </label>
      <button class="btn" onclick="applyFilter()">Apply Filter</button>
      <button class="btn secondary" onclick="resetFilters()">Reset</button>
      <button class="btn" onclick="location.reload()">Reload</button>
    </div>

    <div class="table-status" id="tableStatus">Visible 0 / 0 rows</div>

    <div class="table-wrap">
      <table id="resultsTable">
        <thead>
          <tr>
            <th>City</th>
            <th>Pharmacy</th>
            <th>Address</th>
            <th>Phone</th>
            <th>Opening / Closing Hours</th>
            <th>Distance From Ashkelon (km)</th>
            <th>Direction</th>
            <th>Medication</th>
            <th>Availability</th>
            <th>Stock Code</th>
          </tr>
        </thead>
        <tbody>
          ${rowHtml}
        </tbody>
      </table>
    </div>
    ` : `<div class="empty">No scan files found in output folder. Run a scan first with npm.cmd run scan</div>`}
  </div>
  <script>
    function updateVisibleCount() {
      const rows = document.querySelectorAll('#resultsTable tbody tr');
      let visible = 0;
      rows.forEach((row) => {
        if (row.style.display !== 'none') {
          visible += 1;
        }
      });
      const status = document.getElementById('tableStatus');
      if (status) {
        status.innerText = 'Visible ' + visible + ' / ' + rows.length + ' rows';
      }
    }

    function applyFilter() {
      const city = (document.getElementById('cityFilter').value || '').toLowerCase().trim();
      const availability = (document.getElementById('availabilityFilter').value || '').toLowerCase().trim();
      const existsOnly = document.getElementById('existsOnly').checked;
      const rows = document.querySelectorAll('#resultsTable tbody tr');
      rows.forEach((row) => {
        const cityCell = row.querySelector('.city-cell');
        const availabilityCell = row.querySelector('.availability-cell');
        const cityText = (cityCell ? cityCell.innerText : '').toLowerCase();
        const availText = (availabilityCell ? availabilityCell.innerText : '').toLowerCase();
        const cityOk = !city || cityText.includes(city);
        const availOk = !availability || availText.includes(availability);
        const existsOk = !existsOnly || availText === 'in_stock' || availText === 'limited_stock';
        row.style.display = cityOk && availOk && existsOk ? '' : 'none';
      });

      updateVisibleCount();
    }

    function resetFilters() {
      document.getElementById('cityFilter').value = '';
      document.getElementById('availabilityFilter').value = '';
      document.getElementById('existsOnly').checked = true;
      applyFilter();
    }

    document.getElementById('cityFilter').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        applyFilter();
      }
    });
    document.getElementById('availabilityFilter').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        applyFilter();
      }
    });

    applyFilter();
  </script>
</body>
</html>`;
}

async function startServer() {
  const port = parsePort(process.argv.slice(2));
  const outputDir = path.resolve(process.cwd(), 'output');

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url || req.url === '/' || req.url.startsWith('/?')) {
        const latest = await getLatestScan(outputDir);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderHtml(latest));
        return;
      }

      if (req.url === '/api/latest') {
        const latest = await getLatestScan(outputDir);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(latest || { message: 'No scan files found in output folder.' }, null, 2));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Server error: ${error.message}`);
    }
  });

  server.listen(port, () => {
    console.log(`Dashboard running at http://localhost:${port}`);
    console.log('Press Ctrl+C to stop.');
  });
}

startServer().catch((error) => {
  console.error('Failed to start dashboard:', error.message);
  process.exit(1);
});
