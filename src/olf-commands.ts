/**
 * Commands that exist only in olf (the fork), kept out of cli.ts so that
 * merging upstream olcli stays a small diff.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { OverleafClient } from './client.js';
import { getBaseUrl, getConfigPath, getSessionCookieName } from './config.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserLogin, getProfileDir, persistLogin } from './login.js';
import { Coop } from './live/coop.js';
import { listTasks } from './live/tasklog.js';
import { CLIENTS, registeredClients, setupClient, snippetFor, type ClientName } from './setup.js';
import { bridgeTokenExists, ensureBridgeToken } from './live/bridge.js';
import { copyToClipboard, installExtensionFiles, isWsl, openExtensionsPage, openProjectBrowser, type BrowserName } from './browser.js';
import { getSessionCookie } from './config.js';
import { hasBrowserProfile } from './login.js';
import { OverleafClient as Client } from './client.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ok = (text: string) => console.log(`  ${chalk.green('ok')}    ${text}`);
const warn = (text: string) => console.log(`  ${chalk.yellow('warn')}  ${text}`);
const bad = (text: string) => console.log(`  ${chalk.red('fail')}  ${text}`);

async function resolveProject(client: OverleafClient, project?: string): Promise<{ id: string; name: string }> {
  if (!project) {
    const metaPath = join(process.cwd(), '.olcli.json');
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      if (meta.projectId) return { id: meta.projectId, name: meta.projectName || meta.projectId };
    }
    throw new Error('Pass a project name or ID, or run this inside a pulled project folder.');
  }
  const found = (await client.getProjectById(project)) || (await client.getProject(project));
  if (!found) throw new Error(`Project not found: ${project}`);
  return { id: found.id, name: found.name };
}

export function registerOlfCommands(program: Command, getClient: () => Promise<OverleafClient>): void {
  program
    .command('login')
    .description('Sign in through a browser window (Google, ORCID, SSO and password all work)')
    .option('--profile <name>', 'Browser profile to use; one per Overleaf account', 'default')
    .option('--wait <minutes>', 'How long to wait for you to sign in', '10')
    .action(async (options) => {
      const baseUrl = (program.opts().baseUrl as string | undefined) || getBaseUrl();
      const cookieName = (program.opts().cookieName as string | undefined) || getSessionCookieName();
      const spinner = ora('Opening the login window...').start();
      try {
        const result = await browserLogin({
          baseUrl,
          cookieName,
          profile: options.profile,
          timeoutMs: Number(options.wait) * 60_000,
          onStatus: message => { spinner.text = message; },
        });
        if (!result) {
          spinner.fail('Sign-in did not finish in time. Run olf login again.');
          process.exit(1);
        }
        persistLogin(result, options.profile);
        const projects = await result.client.listProjects();
        spinner.succeed(`Signed in. Found ${projects.length} projects.`);
        console.log(chalk.dim(`Session saved to: ${getConfigPath()}`));
        console.log(chalk.dim(`Browser profile: ${getProfileDir(options.profile)}`));
        console.log(chalk.dim('When the session expires, olf refreshes it from this profile without a window.'));
      } catch (error: any) {
        spinner.fail(`Login failed: ${error.message}`);
        process.exit(1);
      }
    });

  program
    .command('setup [client]')
    .description(`Connect olf-mcp to an AI client: ${CLIENTS.join(', ')} (or "print" to show every snippet)`)
    .option('--project <names>', 'Only allow these projects (comma-separated names or IDs)')
    .option('--read-only', 'Refuse every tool that changes a project')
    .option('--workspace <dir>', 'Keep local file paths inside this folder')
    .option('--dry-run', 'Show what would change without writing')
    .action((client: string | undefined, options) => {
      const env: Record<string, string> = {};
      if (options.project) env.OLF_PROJECTS = options.project;
      if (options.readOnly) env.OLF_READ_ONLY = '1';
      if (options.workspace) env.OLF_WORKSPACE = options.workspace;
      if (!client || client === 'print') {
        for (const name of CLIENTS) {
          console.log(chalk.bold(`\n${name}`));
          console.log(snippetFor(name, { env }));
        }
        if (!client) console.log(chalk.dim('\nRun "olf setup <client>" to write one of these for you.'));
        return;
      }
      if (!CLIENTS.includes(client as ClientName)) {
        console.error(chalk.red(`Unknown client "${client}". Choose one of: ${CLIENTS.join(', ')}`));
        process.exit(1);
      }
      try {
        const result = setupClient(client as ClientName, { env, dryRun: options.dryRun });
        const verb = { added: 'Added', updated: 'Updated', unchanged: 'Already set up:', printed: 'Printed' }[result.action];
        console.log(chalk.green(`${verb} olf in ${client}${result.configPath ? ` (${result.configPath})` : ''}`));
        if (result.backup) console.log(chalk.dim(`  Backup of the previous file: ${result.backup}`));
        if (options.dryRun) console.log(chalk.dim('  Dry run: nothing was written. The entry would be:\n') + result.snippet);
        console.log();
        console.log(chalk.bold('Next:'));
        console.log(`  1. ${result.restart} The tools only load after a restart.`);
        console.log('  2. Check it inside the client. Ask it: "Use the olf live_status tool on <your project name>."');
        console.log('     If it says it has no such tool, the client has not loaded olf yet.');
        console.log(chalk.dim('  Run "olf doctor" any time to see what is installed, signed in and connected.'));
      } catch (error: any) {
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });

  program
    .command('doctor')
    .description('Check each setup stage: install, sign-in, MCP server, AI clients, extension')
    .action(async () => {
      console.log(chalk.bold('olf doctor\n'));
      const node = process.versions.node.split('.').map(Number);
      const here = dirname(fileURLToPath(import.meta.url));
      console.log(chalk.bold('Install'));
      if ((node[0] > 20 || (node[0] === 20 && node[1] >= 18))) ok(`Node ${process.versions.node}`);
      else bad(`Node ${process.versions.node}; olf needs 20.18 or newer`);
      if (existsSync(join(here, 'mcp.js'))) ok(`MCP server at ${join(here, 'mcp.js')}`);
      else bad('MCP server file missing; run npm run build');

      console.log(chalk.bold('\nSign-in'));
      const cookie = getSessionCookie();
      if (!cookie) bad('Not signed in. Run: olf login');
      else {
        try {
          const client = await Client.fromSessionCookie(cookie, getBaseUrl(), getSessionCookieName());
          const projects = await client.listProjects();
          ok(`Signed in to ${getBaseUrl()} (${projects.length} projects visible)`);
        } catch (error: any) {
          bad(`Saved session does not work (${error.message}). Run: olf login`);
        }
      }
      if (hasBrowserProfile()) ok('Login browser profile saved: expired sessions renew without a window');
      else warn('No login browser profile: when the session expires, run olf login again');

      console.log(chalk.bold('\nMCP server'));
      try {
        const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
        const mcp = new McpClient({ name: 'olf-doctor', version: '1' });
        await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, 'mcp.js')], stderr: 'ignore' }));
        const tools = (await mcp.listTools()).tools.map(t => t.name);
        await mcp.close();
        const live = ['live_status', 'live_read', 'claim_section', 'live_replace', 'release_claim'];
        if (live.every(t => tools.includes(t))) ok(`Starts and offers ${tools.length} tools, including the live editing tools`);
        else bad(`Starts, but live tools are missing: ${live.filter(t => !tools.includes(t)).join(', ')}`);
      } catch (error: any) {
        bad(`Does not start: ${error.message}`);
      }

      console.log(chalk.bold('\nAI clients'));
      const clients = registeredClients();
      for (const c of clients) {
        if (c.registered) ok(`${c.client}: olf is configured (${c.path})`);
      }
      if (!clients.some(c => c.registered)) warn('No AI client has olf yet. Run: olf setup claude-code (or codex, cursor, ...)');
      console.log(chalk.dim('        A configured client still needs a restart, and only the client can confirm it loaded'));
      console.log(chalk.dim('        the tools: ask it to "use the olf live_status tool".'));

      console.log(chalk.bold('\nBrowser extension (optional)'));
      if (bridgeTokenExists()) ok('Paired (olf extension install, olf browser or olf extension pair)');
      else warn('Not paired. Optional: olf extension install, or olf browser');
      console.log();
    });

  program
    .command('browser [project]')
    .description('Open the olf browser window: signed in, extension loaded, project open (Chrome)')
    .action(async (project?: string) => {
      const spinner = ora('Opening the olf browser...').start();
      try {
        let projectId: string | undefined;
        if (project || existsSync(join(process.cwd(), '.olcli.json'))) {
          projectId = (await resolveProject(await getClient(), project)).id;
        }
        const result = await openProjectBrowser({ projectId, onStatus: m => { spinner.text = m; } });
        if (!result.signedIn) {
          spinner.warn('The window is open, but you are not signed in yet. Sign in there, then run this again.');
          return;
        }
        spinner.succeed(`Opened ${result.url}`);
        console.log(chalk.dim(result.extension === 'loaded' ? '  Extension loaded and paired.' : `  ${result.note}`));
        console.log(chalk.dim('  This window keeps its own profile, so you stay signed in next time.'));
      } catch (error: any) {
        spinner.fail(error.message);
        process.exit(1);
      }
    });

  const extension = program
    .command('extension')
    .description('The optional browser extension');

  extension
    .command('install')
    .description('Copy the extension (already paired) to a folder and open your browser\'s extensions page')
    .option('--browser <name>', 'chrome, edge or brave', 'chrome')
    .option('--windows', 'On WSL: install for a Windows browser (default on WSL)')
    .option('--linux', 'On WSL: install for a browser running inside WSL')
    .action((options) => {
      const browser = String(options.browser).toLowerCase() as BrowserName;
      if (!['chrome', 'edge', 'brave'].includes(browser)) {
        console.error(chalk.red('Supported browsers: chrome, edge, brave. Firefox and Safari are not supported yet.'));
        process.exit(1);
      }
      const windows = isWsl() && !options.linux;
      const { displayPath } = installExtensionFiles({ windows });
      const copied = copyToClipboard(displayPath);
      const opened = openExtensionsPage(browser, windows);
      const page = browser === 'edge' ? 'edge://extensions' : browser === 'brave' ? 'brave://extensions' : 'chrome://extensions';
      console.log(chalk.green(`Extension ready in: ${displayPath}`) + (copied ? chalk.dim('  (copied to the clipboard)') : ''));
      console.log();
      console.log(chalk.bold(`${opened ? 'Your browser should now show' : 'Open'} ${page}, then:`));
      console.log('  1. Turn on "Developer mode" (a switch at the top right, or bottom left in Edge).');
      console.log('  2. Click "Load unpacked".');
      console.log(`  3. Choose the folder above${copied ? ' (paste the path into the folder picker)' : ''}.`);
      console.log();
      console.log(chalk.dim('It is already paired with olf. Browsers ask for these clicks for any extension that is not'));
      console.log(chalk.dim('from their store. To skip them, use "olf browser", which loads it for you.'));
    });

  extension
    .command('pair')
    .description('Show the pairing code to paste into the extension popup')
    .option('--rotate', 'Make a new code; existing pairings stop working')
    .action((options) => {
      const token = ensureBridgeToken(Boolean(options.rotate));
      console.log('Pairing code (keep it private):');
      console.log(`  ${token}`);
      if (copyToClipboard(token)) console.log(chalk.dim('  Copied to the clipboard.'));
      console.log(chalk.dim('Click the olf icon in the browser toolbar, paste it and press Pair. Restart your AI client so olf-mcp picks it up.'));
    });

  extension
    .command('path')
    .description('Print the folder with the extension files')
    .action(() => {
      console.log(installExtensionFiles({ windows: isWsl() }).displayPath);
    });

  program
    .command('tasks [project]')
    .description('List recent agent tasks on a project and what each one changed')
    .option('-n, --limit <n>', 'How many tasks', '10')
    .option('--diff', 'Show the before/after text of each edit')
    .action(async (project, options) => {
      try {
        const client = await getClient();
        const proj = await resolveProject(client, project);
        const tasks = listTasks(proj.id).slice(0, Number(options.limit));
        if (!tasks.length) {
          console.log(chalk.dim(`No agent tasks recorded for "${proj.name}".`));
          return;
        }
        for (const task of tasks) {
          const when = task.edits[0]?.ts?.replace('T', ' ').slice(0, 16) || '';
          console.log(`${chalk.cyan(task.taskId)}  ${when}  ${task.task}${task.undone ? chalk.yellow('  (undone)') : ''}`);
          console.log(chalk.dim(`  ${task.edits.length} edit(s) in ${[...new Set(task.edits.map(e => e.path))].join(', ')}`));
          if (options.diff) {
            for (const edit of task.edits) {
              console.log(chalk.red(`  - ${edit.before.replace(/\n/g, '\n    ')}`));
              console.log(chalk.green(`  + ${edit.after.replace(/\n/g, '\n    ')}`));
            }
          }
        }
      } catch (error: any) {
        console.error(chalk.red(error.message));
        process.exit(1);
      }
    });

  program
    .command('undo [taskId] [project]')
    .description("Undo an agent task's edits live (latest task if no ID). Text you changed since is left alone.")
    .action(async (taskId, project) => {
      const spinner = ora('Connecting...').start();
      try {
        const client = await getClient();
        const proj = await resolveProject(client, project);
        const coop = await Coop.open(client, proj.id, { owner: false });
        try {
          spinner.text = 'Undoing...';
          const result = await coop.undo(taskId);
          spinner.succeed(`Undid ${result.reverted} edit(s) of "${result.task}" in "${proj.name}"`);
          for (const skip of result.skipped) console.log(chalk.yellow(`  skipped in ${skip.path}: "${skip.text}" (${skip.reason})`));
        } finally {
          await coop.live.close();
        }
      } catch (error: any) {
        spinner.fail(error.message);
        process.exit(1);
      }
    });
}
