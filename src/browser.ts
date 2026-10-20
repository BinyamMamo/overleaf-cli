/**
 * The olf browser window, and the browser extension files.
 *
 * `olf browser` opens Chrome with the olf login profile, the extension
 * already loaded and paired, and the project open. The agent can do the
 * same through the `open_in_browser` tool, so neither the person nor the
 * agent has to install anything by hand. The profile remembers the sign-in.
 *
 * For a person's own browser, `olf extension install` copies the extension
 * to a stable folder with the pairing token inside it, then shows the three
 * clicks Chrome and Edge require for an unpacked extension.
 */

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBaseUrl, getConfigPath, getSessionCookieName } from './config.js';
import { ensureBridgeToken } from './live/bridge.js';
import { findBrowserExecutable, getActiveProfile, getProfileDir, persistLogin } from './login.js';
import { OverleafClient } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The extension folder shipped with olf. */
export function bundledExtensionDir(): string {
  return join(__dirname, '..', 'extension');
}

export function isWsl(): boolean {
  try {
    return process.platform === 'linux' && /microsoft/i.test(readFileSync('/proc/version', 'utf-8'));
  } catch {
    return false;
  }
}

function windowsHome(): string | null {
  if (!isWsl()) return null;
  const result = spawnSync('cmd.exe', ['/c', 'echo %USERPROFILE%'], { encoding: 'utf-8' });
  const win = result.stdout?.trim();
  if (!win || win.includes('%')) return null;
  const converted = spawnSync('wslpath', ['-u', win], { encoding: 'utf-8' }).stdout?.trim();
  return converted || null;
}

export type BrowserName = 'chrome' | 'edge' | 'brave';

/**
 * Copy the extension to a folder the browser can load, with the pairing
 * token baked in. On WSL, a Windows browser needs a Windows folder.
 */
export function installExtensionFiles(options: { windows?: boolean } = {}): { dir: string; displayPath: string } {
  const winHome = options.windows ? windowsHome() : null;
  const dir = winHome ? join(winHome, 'olf-extension') : join(dirname(getConfigPath()), 'extension');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(bundledExtensionDir(), dir, { recursive: true });
  writeFileSync(join(dir, 'pairing.json'), JSON.stringify({ token: ensureBridgeToken() }), 'utf-8');
  const displayPath = winHome ? spawnSync('wslpath', ['-w', dir], { encoding: 'utf-8' }).stdout.trim() : dir;
  return { dir, displayPath };
}

/** Open the browser's extensions page, best effort. Returns false if it could not. */
export function openExtensionsPage(browser: BrowserName, windows: boolean): boolean {
  const page = browser === 'edge' ? 'edge://extensions/' : browser === 'brave' ? 'brave://extensions/' : 'chrome://extensions/';
  try {
    if (windows) {
      const exe = browser === 'edge' ? 'msedge' : browser === 'brave' ? 'brave' : 'chrome';
      return spawnSync('cmd.exe', ['/c', 'start', '', exe, page], { stdio: 'ignore' }).status === 0;
    }
    if (process.platform === 'darwin') {
      const app = browser === 'edge' ? 'Microsoft Edge' : browser === 'brave' ? 'Brave Browser' : 'Google Chrome';
      return spawnSync('open', ['-a', app, page], { stdio: 'ignore' }).status === 0;
    }
    const exe = browser === 'edge' ? 'microsoft-edge' : browser === 'brave' ? 'brave-browser' : 'google-chrome';
    const child = spawn(exe, [page], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Put text on the clipboard, best effort. */
export function copyToClipboard(text: string): boolean {
  const tools: [string, string[]][] = isWsl() || process.platform === 'win32'
    ? [['clip.exe', []]]
    : process.platform === 'darwin' ? [['pbcopy', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of tools) {
    const result = spawnSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    if (result.status === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------- olf browser

interface BrowserState {
  port: number;
  pid: number;
  profile: string;
}

function statePath(): string {
  return join(dirname(getConfigPath()), 'browser.json');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function debuggerUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface OpenBrowserResult {
  url: string;
  signedIn: boolean;
  extension: 'loaded' | 'unavailable';
  reused: boolean;
  note?: string;
}

/**
 * Open (or reuse) the olf Chrome window on a project. Waits up to
 * `loginWaitMs` for the person to sign in if Overleaf asks for it.
 */
export async function openProjectBrowser(options: { projectId?: string; profile?: string; loginWaitMs?: number; onStatus?: (m: string) => void } = {}): Promise<OpenBrowserResult> {
  const baseUrl = getBaseUrl();
  const profile = options.profile || getActiveProfile();
  const status = options.onStatus || (() => {});
  const { chromium } = await import('playwright-core');

  let state: BrowserState | null = null;
  try {
    state = JSON.parse(readFileSync(statePath(), 'utf-8'));
  } catch {
    state = null;
  }
  const reused = Boolean(state && state.profile === profile && await debuggerUp(state.port));

  if (!reused) {
    const executable = findBrowserExecutable();
    if (!executable) throw new Error('No Chrome, Edge or Chromium found. Install Chrome, or set OLF_BROWSER.');
    const port = await freePort();
    const child = spawn(executable, [
      `--user-data-dir=${getProfileDir(profile)}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1500,950',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    state = { port, pid: child.pid || 0, profile };
    for (let i = 0; i < 40 && !(await debuggerUp(port)); i++) await new Promise(r => setTimeout(r, 250));
    if (!(await debuggerUp(port))) throw new Error('Chrome started but did not open its debugging port. Close other Chrome windows that use the olf profile and retry.');
    writeFileSync(statePath(), JSON.stringify(state), 'utf-8');
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${state!.port}`);
  try {
    const context = browser.contexts()[0];

    // Load and pair the extension. Chrome ignores --load-extension now, so
    // this goes through the DevTools protocol instead.
    let extension: OpenBrowserResult['extension'] = 'unavailable';
    if (!reused || !context.serviceWorkers().some(w => w.url().startsWith('chrome-extension://'))) {
      try {
        const cdp = await browser.newBrowserCDPSession();
        const { id } = await cdp.send('Extensions.loadUnpacked' as any, { path: installExtensionFiles().dir }) as { id: string };
        extension = id ? 'loaded' : 'unavailable';
      } catch {
        extension = 'unavailable';
      }
    } else {
      extension = 'loaded';
    }

    const target = options.projectId ? `${baseUrl}/project/${options.projectId}` : `${baseUrl}/project`;
    const page = context.pages().find(p => p.url().startsWith(target)) || await context.newPage();
    if (!page.url().startsWith(target)) await page.goto(target, { waitUntil: 'domcontentloaded' });
    await page.bringToFront().catch(() => {});
    // The editor sometimes fails its first socket connection on a cold
    // start ("Could not connect to WebSocket server"); one reload fixes it.
    if (options.projectId && !(await page.waitForSelector('.cm-content', { timeout: 25_000 }).then(() => true, () => false)) && !/\/login/.test(page.url())) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }

    // Signed in? If Overleaf sent us to the login page, wait for the person.
    let signedIn = !/\/login|\/register/.test(page.url());
    if (!signedIn) {
      status('Sign in to Overleaf in the olf browser window.');
      const deadline = Date.now() + (options.loginWaitMs ?? 10 * 60_000);
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1500));
        const cookies = await context.cookies(baseUrl);
        const session = cookies.find(c => c.name === getSessionCookieName()) || cookies.find(c => c.name === 'overleaf_session2');
        if (session && !/\/login|\/register/.test(page.url())) {
          try {
            const client = await OverleafClient.fromSessionCookie(session.value, baseUrl, session.name);
            persistLogin({ cookieName: session.name, cookie: session.value, client }, profile);
            signedIn = true;
            break;
          } catch {
            // not yet
          }
        }
      }
      if (signedIn && !page.url().startsWith(target)) await page.goto(target, { waitUntil: 'domcontentloaded' });
    }

    return {
      url: target,
      signedIn,
      extension,
      reused,
      note: extension === 'unavailable' ? 'This browser could not load the extension automatically; the claim comment and agent cursor still show.' : undefined,
    };
  } finally {
    // Disconnect only; the window stays open for the person.
    await browser.close().catch(() => {});
  }
}

export function forgetBrowserState(): void {
  if (existsSync(statePath())) rmSync(statePath());
}
