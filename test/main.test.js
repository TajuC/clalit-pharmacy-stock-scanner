'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, toBool, htmlToText, extractOpeningHours, pickMedication, cityRows, sanitizeCsv, withRetries } = require('../src/main');
const { RequestError, ScanAbortedError } = require('../src/browser');

const selected = { catCode: 1000107840, omryName: 'VYVANSE 30MG <><>CAP 30', isApprovalRequired: true };
const city = { cityCode: 7100, cityName: 'אשקלון' };

test('parseArgs supports spaced values, = values and bare flags', () => {
  assert.deepEqual(parseArgs(['--medicine', 'VYVANSE 30MG', '--slowMo=120', '--headed', '--full']), {
    medicine: 'VYVANSE 30MG',
    slowMo: '120',
    headed: true,
    full: true
  });
});

test('toBool understands env style values and falls back otherwise', () => {
  assert.equal(toBool('TRUE', false), true);
  assert.equal(toBool('0', true), false);
  assert.equal(toBool(true, false), true);
  assert.equal(toBool(undefined, true), true);
  assert.equal(toBool('maybe', false), false);
});

test('htmlToText flattens the instruction array the service now returns', () => {
  const text = htmlToText([' בשעות 9:00-16:00', ' <a href="https://example.test">למידע &amp; עזרה</a>']);
  assert.equal(text, 'בשעות 9:00-16:00 למידע & עזרה');
});

test('extractOpeningHours reads ranges from arrays and strings', () => {
  assert.equal(extractOpeningHours(['א-ה 8:00 - 17:00', 'ו 8:00-13:00'], false), '8:00 - 17:00, 8:00-13:00');
  assert.equal(extractOpeningHours('<p> </p>', true), 'Open now');
  assert.equal(extractOpeningHours(null, false), '');
});

test('pickMedication prefers the exact name', () => {
  const { selected: pick } = pickMedication(
    [
      { omryName: 'VYVANSE 50MG <><>CAP 30', catCode: 2 },
      { omryName: 'VYVANSE 30MG <><>CAP 30', catCode: 1 }
    ],
    'VYVANSE 30MG'
  );
  assert.equal(pick.catCode, 1);
});

test('cityRows emits one not_found row for cities without pharmacies', () => {
  const result = cityRows({ city, checkedAt: 'now', data: { isEmptyResult: true, pharmaciesList: [] }, selected });
  assert.equal(result.hasAnyResult, false);
  assert.equal(result.pharmaciesCount, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].availability, 'not_found');
});

test('cityRows maps live response fields into rows', () => {
  const data = {
    isWsError: false,
    isEmptyResult: false,
    pharmaciesList: [
      {
        pharmacyName: 'גלובוס מקס - בית מרקחת - אשקלון',
        pharmacyCode: 99093,
        pharmacyAdress: ' 150, אשקלון, מתחם גלובס סנטרנ',
        pharmacyPhone: '0778882690',
        ifOpenedNow: true,
        latCoord: 31.6657508356267,
        longCoord: 34.5589197661857,
        pharmacyInstruction: [' בשעות 9:00-16:00', ' <a href="x">למידע</a>'],
        medicationsList: [{ kodStatusMlay: 30, medicationName: 'VYVANSE 30MG <><>CAP 30', medicationCode: 1000107840 }]
      },
      {
        pharmacyName: 'ללא קואורדינטות',
        pharmacyCode: 1,
        latCoord: null,
        longCoord: null,
        medicationsList: [{ kodStatusMlay: 0, medicationName: 'VYVANSE 30MG <><>CAP 30', medicationCode: 1000107840 }]
      }
    ]
  };
  const result = cityRows({ city, checkedAt: 'now', data, selected });
  assert.equal(result.hasAnyResult, true);
  assert.equal(result.pharmaciesCount, 2);
  const [first, second] = result.rows;
  assert.equal(first.availability, 'in_stock');
  assert.equal(first.stockCode, 30);
  assert.equal(first.openingHours, '9:00-16:00');
  assert.equal(first.pharmacyAddress, '150, אשקלון, מתחם גלובס סנטרנ');
  assert.equal(first.distanceFromAshkelonKm, 1.25);
  assert.equal(first.directionRelativeToAshkelon, 'same_lat_band');
  assert.equal(second.availability, 'out_of_stock');
  assert.equal(second.latCoord, '');
  assert.equal(second.distanceFromAshkelonKm, '');
});

test('sanitizeCsv quotes separators, quotes and line breaks', () => {
  assert.equal(sanitizeCsv('plain'), 'plain');
  assert.equal(sanitizeCsv('a,b'), '"a,b"');
  assert.equal(sanitizeCsv('say "hi"'), '"say ""hi"""');
  assert.equal(sanitizeCsv('line\rbreak'), '"line\rbreak"');
  assert.equal(sanitizeCsv(null), '');
});

test('withRetries retries retryable errors only', async () => {
  let calls = 0;
  const value = await withRetries(async () => {
    calls += 1;
    if (calls < 2) throw new RequestError('flaky', { retryable: true });
    return 'done';
  }, 2);
  assert.equal(value, 'done');
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    withRetries(async () => {
      calls += 1;
      throw new RequestError('HTTP 400', { retryable: false });
    }, 3),
    /HTTP 400/
  );
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(
    withRetries(async () => {
      calls += 1;
      throw new ScanAbortedError('closed');
    }, 3),
    ScanAbortedError
  );
  assert.equal(calls, 1);
});
