/**
 * Commands that exist only in olf (the fork), kept out of cli.ts so that
 * merging upstream olcli stays a small diff.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { OverleafClient } from './client.js';
import { getBaseUrl, getConfigPath, getSessionCookieName } from './config.js';
import { browserLogin, getProfileDir, persistLogin } from './login.js';

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

  void getClient;
}
