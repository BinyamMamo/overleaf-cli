/**
 * Browser login for olf.
 *
 * Opens a real browser window on the Overleaf login page and waits for the
 * user to sign in any way Overleaf allows (password, Google, ORCID,
 * institutional SSO). The session cookie is then read from the browser, so
 * nobody has to copy it out of DevTools.
 *
 * The browser keeps its own profile next to the olf config. That profile
 * stays signed in, so `refreshSessionFromBrowser()` can later fetch a fresh
 * cookie headless, without a window, until Overleaf really logs the user out.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OverleafClient } from './client.js';
import {
  getBaseUrl,
  getConfigPath,
  getSessionCookieName,
  setSessionCookie,
  setSessionCookieName,
} from './config.js';

export interface BrowserLoginOptions {
  baseUrl?: string;
  cookieName?: string;
  /** Profile name; each one is a separate browser profile and account. */
  profile?: string;
  /** Give up after this long. Default 10 minutes for a visible login. */
  timeoutMs?: number;
  /** Visible window (login) or hidden (refresh). */
  headless?: boolean;
  /** Called with short status lines for the terminal. */
  onStatus?: (message: string) => void;
}

export interface BrowserLoginResult {
  cookieName: string;
  cookie: string;
  client: OverleafClient;
}

const KNOWN_SESSION_COOKIES = ['overleaf_session2', 'overleaf.sid', 'sharelatex.sid'];

function profilesRoot(): string {
  return join(dirname(getConfigPath()), 'browser-profiles');
}

/** The profile the current session came from, so refresh reuses it. */
export function getActiveProfile(): string {
  try {
    return readFileSync(join(profilesRoot(), 'active'), 'utf-8').trim() || 'default';
  } catch {
    return 'default';
  }
}

function setActiveProfile(profile: string): void {
  mkdirSync(profilesRoot(), { recursive: true });
  writeFileSync(join(profilesRoot(), 'active'), profile, 'utf-8');
}

export function getProfileDir(profile = getActiveProfile()): string {
  return join(profilesRoot(), profile);
}

export function hasBrowserProfile(profile = getActiveProfile()): boolean {
  return existsSync(getProfileDir(profile));
}

/**
 * Find a browser to drive. Playwright's bundled browsers are not required:
 * an installed Chrome, Edge or Chromium works, and OLF_BROWSER overrides.
 */
function resolveExecutable(): string | undefined {
  const candidates = [
    process.env.OLF_BROWSER,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidates.find((path): path is string => Boolean(path && existsSync(path)));
}

async function tryClient(cookie: string, baseUrl: string, cookieName: string): Promise<OverleafClient | null> {
  try {
    return await OverleafClient.fromSessionCookie(cookie, baseUrl, cookieName);
  } catch {
    return null;
  }
}

/**
 * Drive the browser until a logged-in session cookie appears.
 *
 * An anonymous visitor already has a session cookie, so the cookie existing
 * proves nothing. A cookie counts only once it opens the project list.
 */
export async function browserLogin(options: BrowserLoginOptions = {}): Promise<BrowserLoginResult | null> {
  const baseUrl = options.baseUrl || getBaseUrl();
  const preferredName = options.cookieName || getSessionCookieName();
  const headless = options.headless ?? false;
  const timeoutMs = options.timeoutMs ?? (headless ? 30_000 : 10 * 60_000);
  const status = options.onStatus || (() => {});

  let chromium: typeof import('playwright-core').chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new Error('Browser login needs playwright-core. Run: npm install playwright-core');
  }

  const executablePath = resolveExecutable();
  if (!executablePath) {
    throw new Error('No Chrome, Edge or Chromium found. Install one, or set OLF_BROWSER to its path.');
  }

  const context = await chromium.launchPersistentContext(getProfileDir(options.profile), {
    executablePath,
    headless,
    viewport: null,
    // Google sign-in refuses windows flagged as automated.
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${baseUrl}/project`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (!headless) status('Sign in to Overleaf in the browser window. olf waits until you are in.');

    const deadline = Date.now() + timeoutMs;
    let lastTried = '';
    while (Date.now() < deadline) {
      if (page.isClosed() && !headless) {
        throw new Error('The login window was closed before sign-in finished.');
      }
      const url = page.isClosed() ? '' : page.url();
      const onLoginPage = /\/(login|register|sso|saml|oauth)/.test(url);
      if (!onLoginPage) {
        const cookies = await context.cookies(baseUrl);
        const names = [preferredName, ...KNOWN_SESSION_COOKIES];
        const found = names.map(name => cookies.find(c => c.name === name)).find(Boolean);
        if (found && found.value !== lastTried) {
          lastTried = found.value;
          const client = await tryClient(found.value, baseUrl, found.name);
          if (client) return { cookieName: found.name, cookie: found.value, client };
        }
      }
      if (headless && onLoginPage) return null;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    return null;
  } finally {
    await context.close().catch(() => {});
  }
}

/** Save a login result as the cookie every olf command uses. */
export function persistLogin(result: BrowserLoginResult, profile?: string): void {
  setSessionCookieName(result.cookieName);
  setSessionCookie(result.cookie);
  if (profile) setActiveProfile(profile);
}

/**
 * Get a fresh cookie from the saved browser profile, without a window.
 * Returns null when there is no profile or Overleaf asks for a real login.
 */
export async function refreshSessionFromBrowser(options: Omit<BrowserLoginOptions, 'headless'> = {}): Promise<OverleafClient | null> {
  if (!hasBrowserProfile(options.profile)) return null;
  try {
    const result = await browserLogin({ ...options, headless: true });
    if (!result) return null;
    persistLogin(result, options.profile);
    return result.client;
  } catch {
    return null;
  }
}
