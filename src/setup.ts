/**
 * Connect olf-mcp to an AI client, and check that every piece works.
 *
 * Installing the CLI does not connect anything: the client must have an
 * MCP entry for olf-mcp, and must be restarted to load it. This module
 * writes that entry (keeping everything else in the client's config, with a
 * backup) and `doctor` reports each stage separately.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ClientName = 'claude-code' | 'codex' | 'cursor' | 'claude-desktop' | 'windsurf';
export const CLIENTS: ClientName[] = ['claude-code', 'codex', 'cursor', 'claude-desktop', 'windsurf'];

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute command for the MCP server, so clients do not depend on PATH. */
export function mcpCommand(): { command: string; args: string[] } {
  return { command: process.execPath, args: [join(__dirname, 'mcp.js')] };
}

export interface SetupOptions {
  env?: Record<string, string>;
  dryRun?: boolean;
}

export interface SetupResult {
  client: ClientName;
  configPath?: string;
  action: 'added' | 'updated' | 'unchanged' | 'printed';
  backup?: string;
  restart: string;
  snippet: string;
}

function onPath(cmd: string): boolean {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
}

function backupFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const backup = `${path}.olf-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(path, backup);
  return backup;
}

function jsonEntry(options: SetupOptions): Record<string, unknown> {
  const { command, args } = mcpCommand();
  return { command, args, ...(options.env && Object.keys(options.env).length ? { env: options.env } : {}) };
}

/** Add or update `mcpServers.olf` in a JSON config file, keeping the rest. */
function mergeJsonConfig(path: string, options: SetupOptions): { action: SetupResult['action']; backup?: string } {
  let config: Record<string, any> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf-8');
    try {
      config = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`${path} is not valid JSON; fix it or add the entry by hand (olf setup print).`);
    }
  }
  const entry = jsonEntry(options);
  const before = JSON.stringify(config.mcpServers?.olf);
  if (before === JSON.stringify(entry)) return { action: 'unchanged' };
  if (options.dryRun) return { action: before ? 'updated' : 'added' };
  const backup = backupFile(path);
  config.mcpServers = { ...(config.mcpServers || {}), olf: entry };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return { action: before ? 'updated' : 'added', backup };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexBlock(options: SetupOptions): string {
  const { command, args } = mcpCommand();
  const lines = ['[mcp_servers.olf]', `command = ${tomlString(command)}`, `args = [${args.map(tomlString).join(', ')}]`];
  if (options.env && Object.keys(options.env).length) {
    lines.push(`env = { ${Object.entries(options.env).map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ')} }`);
  }
  return lines.join('\n') + '\n';
}

/** Replace (or append) the [mcp_servers.olf] table in Codex's config.toml. */
function mergeCodexConfig(path: string, options: SetupOptions): { action: SetupResult['action']; backup?: string } {
  const block = codexBlock(options);
  const raw = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const pattern = /^\[mcp_servers\.olf\]\n(?:(?!\[)[^\n]*\n?)*/m;
  const existing = raw.match(pattern)?.[0];
  if (existing && existing.trim() === block.trim()) return { action: 'unchanged' };
  if (options.dryRun) return { action: existing ? 'updated' : 'added' };
  const backup = backupFile(path);
  const next = existing ? raw.replace(pattern, block + '\n') : `${raw}${raw && !raw.endsWith('\n') ? '\n' : ''}${raw ? '\n' : ''}${block}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next, 'utf-8');
  return { action: existing ? 'updated' : 'added', backup };
}

function claudeDesktopPath(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

export function configPathFor(client: ClientName): string {
  switch (client) {
    case 'claude-code': return join(homedir(), '.claude.json');
    case 'codex': return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
    case 'cursor': return join(homedir(), '.cursor', 'mcp.json');
    case 'claude-desktop': return claudeDesktopPath();
    case 'windsurf': return join(homedir(), '.codeium', 'windsurf', 'mcp_config.json');
  }
}

const RESTART: Record<ClientName, string> = {
  'claude-code': 'Start a new Claude Code session (or run /mcp to reconnect).',
  codex: 'Quit and restart Codex.',
  cursor: 'Reload Cursor (Developer: Reload Window), then enable "olf" in Settings > MCP.',
  'claude-desktop': 'Quit Claude Desktop completely and open it again.',
  windsurf: 'Restart Windsurf.',
};

export function snippetFor(client: ClientName, options: SetupOptions = {}): string {
  if (client === 'codex') return codexBlock(options);
  if (client === 'claude-code') {
    const { command, args } = mcpCommand();
    const env = Object.entries(options.env || {}).map(([k, v]) => `-e ${k}=${JSON.stringify(v)} `).join('');
    return `claude mcp add --scope user ${env}olf -- ${command} ${args.join(' ')}`;
  }
  return JSON.stringify({ mcpServers: { olf: jsonEntry(options) } }, null, 2);
}

export function setupClient(client: ClientName, options: SetupOptions = {}): SetupResult {
  const snippet = snippetFor(client, options);
  const restart = RESTART[client];
  const configPath = configPathFor(client);

  if (client === 'claude-code' && onPath('claude') && !options.dryRun) {
    const { command, args } = mcpCommand();
    spawnSync('claude', ['mcp', 'remove', '--scope', 'user', 'olf'], { stdio: 'ignore' });
    const envArgs = Object.entries(options.env || {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    execFileSync('claude', ['mcp', 'add', '--scope', 'user', ...envArgs, 'olf', '--', command, ...args], { stdio: 'ignore' });
    return { client, configPath, action: 'added', restart, snippet };
  }
  const result = client === 'codex' ? mergeCodexConfig(configPath, options) : mergeJsonConfig(configPath, options);
  return { client, configPath, restart, snippet, ...result };
}

/** Which clients already have an olf entry. */
export function registeredClients(): { client: ClientName; path: string; registered: boolean }[] {
  return CLIENTS.map(client => {
    const path = configPathFor(client);
    let registered = false;
    try {
      const raw = readFileSync(path, 'utf-8');
      registered = client === 'codex' ? /^\[mcp_servers\.olf\]/m.test(raw) : Boolean(JSON.parse(raw).mcpServers?.olf);
    } catch {
      // not installed or unreadable
    }
    return { client, path, registered };
  });
}
