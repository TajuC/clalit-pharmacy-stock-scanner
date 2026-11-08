'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');

const STOCK_CAPTCHA_ACTION = 'SEARCH_PHARMACY_STOCK';
const COOLDOWN_START_MS = 15000;
const COOLDOWN_MAX_MS = 120000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPacer({ intervalMs, stallMs }) {
  let lastSentAt = 0;
  let blockedUntil = 0;
  let cooldownMs = COOLDOWN_START_MS;
  let lastSuccessAt = Date.now();
  let queue = Promise.resolve();

  return {
    acquire() {
      const turn = queue.then(async () => {
        for (;;) {
          const wait = Math.max(lastSentAt + intervalMs, blockedUntil) - Date.now();
          if (wait <= 0) break;
          await sleep(wait);
        }
        if (Date.now() - lastSuccessAt > stallMs) {
          throw new ScanAbortedError(`The service has rejected every verified request for ${Math.round(stallMs / 60000)} minutes; try again later.`);
        }
        lastSentAt = Date.now();
      });
      queue = turn.catch(() => {});
      return turn;
    },
    succeeded() {
      lastSuccessAt = Date.now();
      cooldownMs = COOLDOWN_START_MS;
    },
    rejected() {
      const pause = cooldownMs;
      blockedUntil = Math.max(blockedUntil, Date.now() + pause);
      cooldownMs = Math.min(cooldownMs * 2, COOLDOWN_MAX_MS);
      return pause;
    }
  };
}

class ScanAbortedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScanAbortedError';
  }
}

class RequestError extends Error {
  constructor(message, { retryable }) {
    super(message);
    this.name = 'RequestError';
    this.retryable = retryable;
  }
}

function isExecutable(file) {
  try {
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findOnPath(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function browserCandidates() {
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const relative = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe']
    ];
    return relative.flatMap((parts) => roots.map((root) => path.join(root, ...parts)));
  }
  if (process.platform === 'darwin') {
    const apps = [
      ['Google Chrome.app', 'Google Chrome'],
      ['Microsoft Edge.app', 'Microsoft Edge'],
      ['Chromium.app', 'Chromium']
    ];
    const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
    return apps.flatMap(([bundle, binary]) => roots.map((root) => path.join(root, bundle, 'Contents', 'MacOS', binary)));
  }
  return [];
}

function resolveBrowserPath(explicitPath) {
  if (explicitPath) {
    if (!isExecutable(explicitPath)) {
      throw new Error(`Browser not found or not executable: ${explicitPath}`);
    }
    return explicitPath;
  }

  const fromKnownLocations = browserCandidates().find(isExecutable);
  if (fromKnownLocations) {
    return fromKnownLocations;
  }

  const fromPath = findOnPath([
    'google-chrome-stable',
    'google-chrome',
    'microsoft-edge-stable',
    'microsoft-edge',
    'chromium',
    'chromium-browser'
  ]);
  if (fromPath) {
    return fromPath;
  }

  throw new Error('Google Chrome or Microsoft Edge is required but was not found. Install one, or set BROWSER_PATH / --browserPath to its executable.');
}

async function waitForDevToolsPort(userDataDir, child, timeoutMs) {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  let exitCode = null;
  child.once('exit', (code) => {
    exitCode = code ?? -1;
  });

  while (Date.now() < deadline) {
    if (exitCode !== null) {
      throw new Error(`Browser exited during startup (code ${exitCode}).`);
    }
    try {
      const port = Number.parseInt(fs.readFileSync(portFile, 'utf8').split('\n')[0], 10);
      if (Number.isFinite(port) && port > 0) {
        return port;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error(`Browser did not expose a DevTools port within ${timeoutMs}ms.`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function pageRequest({ url, body, captcha, timeoutMs }) {
  return (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (captcha) {
        await new Promise((resolve) => window.grecaptcha.enterprise.ready(resolve));
        headers['Recaptcha-Client-Token'] = await window.grecaptcha.enterprise.execute(captcha.siteKey, { action: captcha.action });
      }
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body ?? {}),
        redirect: 'manual',
        credentials: 'include',
        signal: controller.signal
      });
      return {
        ok: response.ok,
        status: response.status,
        redirected: response.type === 'opaqueredirect',
        contentType: response.headers.get('content-type') || '',
        text: response.type === 'opaqueredirect' ? '' : await response.text()
      };
    } catch (error) {
      return { networkError: error.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(error.message || error) };
    } finally {
      clearTimeout(timer);
    }
  })();
}

async function launchSession({
  targetUrl,
  lang,
  headed = false,
  slowMo = 0,
  timeoutMs = 25000,
  browserPath = '',
  intervalMs = 0,
  stallMs = Number.POSITIVE_INFINITY,
  onCooldown
}) {
  const executable = resolveBrowserPath(browserPath);
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('A desktop session is required because the stock service rejects headless browsers. Run inside a graphical session or under xvfb-run.');
  }

  const origin = new URL(targetUrl).origin;
  const apiRoot = `${origin}/PharmacyStockCoreAPI`;
  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pharmacy-stock-'));
  const child = spawn(
    executable,
    [
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      ...(headed ? [] : ['--start-minimized']),
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  let browser = null;
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    if (browser) {
      try {
        const cdp = await browser.newBrowserCDPSession();
        await cdp.send('Browser.close');
      } catch {}
    }
    if (!(await waitForExit(child, 5000))) {
      child.kill();
      await waitForExit(child, 3000);
    }
    await fsp.rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  };

  try {
    const port = await waitForDevToolsPort(userDataDir, child, 20000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { slowMo });
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(Math.max(timeoutMs, 30000));
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

    const query = `lang=${encodeURIComponent(lang)}`;
    const adminRaw = await page.evaluate(pageRequest, {
      url: `${apiRoot}/api/Administration/GetAdminData?${query}`,
      body: {},
      captcha: null,
      timeoutMs
    });
    if (!adminRaw.ok || !adminRaw.contentType.includes('application/json')) {
      throw new Error(`Could not load service configuration (${adminRaw.networkError || `HTTP ${adminRaw.status}`}).`);
    }
    const params = JSON.parse(adminRaw.text).appParameters ?? {};
    const recaptchaActive = String(params.isRecaptchaActive ?? '').toUpperCase() === 'TRUE';
    const siteKey = params.pharmacyStock_AppRecaptchaSiteKey;
    if (recaptchaActive) {
      if (!siteKey) {
        throw new Error('Service requires reCAPTCHA but did not publish a site key.');
      }
      await page.waitForFunction(() => typeof window.grecaptcha?.enterprise?.execute === 'function');
    }

    const pacer = createPacer({ intervalMs, stallMs });

    const request = async (endpoint, body, { captchaAction } = {}) => {
      const verified = Boolean(recaptchaActive && captchaAction);
      if (verified) {
        await pacer.acquire();
      }
      if (page.isClosed()) {
        throw new ScanAbortedError('Browser window was closed.');
      }
      const url = `${apiRoot}/${endpoint}${endpoint.includes('?') ? '&' : '?'}${query}`;
      let raw;
      try {
        raw = await page.evaluate(pageRequest, {
          url,
          body,
          captcha: verified ? { siteKey, action: captchaAction } : null,
          timeoutMs
        });
      } catch (error) {
        if (page.isClosed() || !browser.isConnected()) {
          throw new ScanAbortedError('Browser window was closed.');
        }
        throw new RequestError(`Browser error at ${endpoint}: ${error.message.split('\n')[0]}`, { retryable: true });
      }

      if (raw.networkError) {
        throw new RequestError(`Network error at ${endpoint}: ${raw.networkError}`, { retryable: true });
      }
      if (raw.redirected) {
        if (verified) {
          const pause = pacer.rejected();
          onCooldown?.(pause);
        }
        throw new RequestError(`Request rejected by the service at ${endpoint} (verification failed)`, { retryable: true });
      }
      if (!raw.ok) {
        const retryable = raw.status === 401 || raw.status === 408 || raw.status === 429 || raw.status >= 500;
        throw new RequestError(`HTTP ${raw.status} at ${endpoint}`, { retryable });
      }
      if (!raw.contentType.toLowerCase().includes('application/json')) {
        const snippet = raw.text.slice(0, 120).replace(/\s+/g, ' ');
        throw new RequestError(`Non-JSON response at ${endpoint}: ${snippet}`, { retryable: true });
      }
      const parsed = JSON.parse(raw.text);
      if (verified) {
        pacer.succeeded();
      }
      return parsed;
    };

    return { request, close, executable, recaptchaActive };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { launchSession, createPacer, ScanAbortedError, RequestError, STOCK_CAPTCHA_ACTION };
