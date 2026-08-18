import type { Command } from 'commander';
import { createContext } from '../client.js';
import { loadConfig, updateProfile } from '../config.js';
import { info, style, success } from '../output.js';
import { ask } from '../prompt.js';

export function registerAuthCommands(program: Command): void {
  program
    .command('login')
    .description('Sign in to an AgentMesh server')
    .option('-u, --url <url>', 'server URL')
    .option('-e, --email <email>', 'account email')
    .option('--register', 'create a new account instead of signing in')
    .option('--name <name>', 'display name (with --register)')
    .action(async (options: { url?: string; email?: string; register?: boolean; name?: string }) => {
      const { rest } = createContext(options.url ? { url: options.url } : {});
      const email = options.email ?? (await ask('Email: '));
      const password = await ask('Password: ', { mask: true });

      const tokens = options.register
        ? await rest.register({
            email,
            password,
            displayName: options.name ?? (await ask('Display name: ')),
          })
        : await rest.login({ email, password });

      updateProfile({
        url: rest.baseUrl,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        userId: tokens.user.id,
        displayName: tokens.user.displayName,
      });
      success(`Signed in as ${style.bold(tokens.user.displayName)} on ${rest.baseUrl}`);
    });

  program
    .command('logout')
    .description('Sign out and forget stored tokens')
    .action(async () => {
      const config = loadConfig();
      const profile = config.profiles[config.profile];
      if (profile?.refreshToken) {
        const { rest } = createContext();
        await rest.logout(profile.refreshToken).catch(() => undefined);
      }
      updateProfile({
        accessToken: undefined,
        refreshToken: undefined,
        userId: undefined,
        displayName: undefined,
      });
      success('Signed out.');
    });

  program
    .command('whoami')
    .description('Show the signed-in account')
    .action(async () => {
      const { rest } = createContext();
      const user = await rest.me();
      info(`${style.bold(user.displayName)} <${user.email}>`);
      info(style.dim(`${user.id} on ${rest.baseUrl}`));
    });
}
