// Sign-in with Microsoft: auth code + PKCE in the system browser, redirected
// back to a localhost port (msal-node's loopback flow). Works for any tenant.
// The token cache is encrypted at rest with Electron's safeStorage (DPAPI on
// Windows, Keychain on macOS).

import { PublicClientApplication, type AccountInfo } from '@azure/msal-node';
import { safeStorage, shell } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const PAGE = (msg: string) =>
  `<html><body style="background:#03050c;color:#e7ecff;font-family:Segoe UI,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="font-weight:600">${msg}</h2><p style="color:#8b93b5">You can close this tab and go back to Fleet Galaxy.</p></div></body></html>`;

export class Auth {
  private pca: PublicClientApplication | null = null;
  private key = '';

  constructor(
    private readonly cacheFile: string,
    private readonly config: () => { clientId: string; tenantId: string },
  ) {}

  configured(): boolean {
    return !!this.config().clientId;
  }

  private client(): PublicClientApplication {
    const { clientId, tenantId } = this.config();
    if (!clientId) throw new Error('No app registration is set. Add a client ID in Settings.');
    const key = `${clientId}|${tenantId}`;
    if (!this.pca || this.key !== key) {
      const file = this.cacheFile;
      this.pca = new PublicClientApplication({
        auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId || 'organizations'}` },
        cache: {
          cachePlugin: {
            beforeCacheAccess: async (ctx) => {
              if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return;
              try {
                ctx.tokenCache.deserialize(safeStorage.decryptString(readFileSync(file)));
              } catch {
                /* unreadable cache: start fresh */
              }
            },
            afterCacheAccess: async (ctx) => {
              if (ctx.cacheHasChanged && safeStorage.isEncryptionAvailable()) writeFileSync(file, safeStorage.encryptString(ctx.tokenCache.serialize()));
            },
          },
        },
      });
      this.key = key;
    }
    return this.pca;
  }

  async account(): Promise<AccountInfo | null> {
    if (!this.configured()) return null;
    const accounts = await this.client().getTokenCache().getAllAccounts();
    return accounts[0] ?? null;
  }

  async signIn(scopes: string[]): Promise<AccountInfo> {
    const res = await this.client().acquireTokenInteractive({
      scopes,
      prompt: 'select_account',
      openBrowser: async (url) => {
        await shell.openExternal(url);
      },
      successTemplate: PAGE('Signed in to Fleet Galaxy'),
      errorTemplate: PAGE('Sign-in failed: {error}'),
    });
    if (!res.account) throw new Error('Sign-in returned no account.');
    return res.account;
  }

  /** Silent token for these scopes; falls back to an interactive consent prompt when new scopes are needed. */
  async token(scopes: string[]): Promise<string> {
    const account = await this.account();
    if (!account) throw new Error('Not signed in.');
    try {
      return (await this.client().acquireTokenSilent({ account, scopes })).accessToken;
    } catch {
      const res = await this.client().acquireTokenInteractive({
        scopes,
        loginHint: account.username,
        openBrowser: async (url) => {
          await shell.openExternal(url);
        },
        successTemplate: PAGE('Permissions updated'),
        errorTemplate: PAGE('Sign-in failed: {error}'),
      });
      return res.accessToken;
    }
  }

  async signOut(): Promise<void> {
    if (!this.configured()) return;
    const cache = this.client().getTokenCache();
    for (const a of await cache.getAllAccounts()) await cache.removeAccount(a);
  }
}
