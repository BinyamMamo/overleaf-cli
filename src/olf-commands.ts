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
