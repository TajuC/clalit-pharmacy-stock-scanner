'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPacer, ScanAbortedError } = require('../src/browser');

test('pacer spaces concurrent acquisitions by the interval', async () => {
  const pacer = createPacer({ intervalMs: 60, stallMs: Number.POSITIVE_INFINITY });
  const started = Date.now();
  const times = await Promise.all([0, 1, 2].map(() => pacer.acquire().then(() => Date.now() - started)));
  assert.ok(times[1] - times[0] >= 55, `gap ${times[1] - times[0]}`);
  assert.ok(times[2] - times[1] >= 55, `gap ${times[2] - times[1]}`);
});

test('a rejection holds back a caller that is already waiting for its slot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-08T12:00:00Z') });
  const pacer = createPacer({ intervalMs: 1000, stallMs: Number.POSITIVE_INFINITY });
  await pacer.acquire();

  let released = false;
  const waiting = pacer.acquire().then(() => {
    released = true;
  });
  await Promise.resolve();
  const pause = pacer.rejected();
  assert.equal(pause, 15000);

  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  assert.equal(released, false);

  t.mock.timers.tick(14000);
  await new Promise(setImmediate);
  await waiting;
  assert.equal(released, true);
});

test('cooldown doubles on repeated rejections and resets on success', () => {
  const pacer = createPacer({ intervalMs: 0, stallMs: Number.POSITIVE_INFINITY });
  assert.deepEqual([pacer.rejected(), pacer.rejected(), pacer.rejected(), pacer.rejected(), pacer.rejected()], [15000, 30000, 60000, 120000, 120000]);
  pacer.succeeded();
  assert.equal(pacer.rejected(), 15000);
});

test('pacer aborts once nothing has succeeded within the stall window', async () => {
  const pacer = createPacer({ intervalMs: 0, stallMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await assert.rejects(pacer.acquire(), ScanAbortedError);
  await assert.rejects(pacer.acquire(), ScanAbortedError);
});
