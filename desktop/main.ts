// Fleet Galaxy desktop: the same page as the web demo, plus sign-in with
// Microsoft, a Graph collector and a local snapshot history. Data only ever
// moves between Microsoft Graph and this computer.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anonymize } from '../src/collect/anonymize';
import { collect } from '../src/collect/collect';
import { Graph } from '../src/collect/graph';
import type { CollectProgress, NativeState } from '../src/native';
import { Auth } from './auth';
import { DEFAULT_CLIENT_ID, DEFAULT_SETTINGS, scopesFor, SOURCES, type Settings, type SourceId } from './config';
import { SnapshotStore } from './store';

const userData = app.getPath('userData');
mkdirSync(userData, { recursive: true });
const settingsFile = join(userData, 'settings.json');
const store = new SnapshotStore(join(userData, 'snapshots'));

function readSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(settingsFile, 'utf8')) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...raw, sources: { ...DEFAULT_SETTINGS.sources, ...raw.sources } };
  } catch {
    return { ...DEFAULT_SETTINGS, sources: { ...DEFAULT_SETTINGS.sources } };
  }
}
let settings = readSettings();
const saveSettingsFile = () => writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

const effectiveClientId = () => settings.clientId.trim() || DEFAULT_CLIENT_ID;
const auth = new Auth(join(userData, 'token-cache.bin'), () => ({ clientId: effectiveClientId(), tenantId: settings.tenantId.trim() }));

let win: BrowserWindow | null = null;
let collecting = false;

async function state(): Promise<NativeState> {
  let account: NativeState['account'];
  try {
    const a = await auth.account();
    if (a) account = { username: a.username, tenantId: a.tenantId, name: a.name };
  } catch {
    /* misconfigured client id: report as signed out */
  }
  return {
    version: app.getVersion(),
    signedIn: !!account,
    account,
    configured: !!effectiveClientId(),
    usingDefaultApp: !settings.clientId.trim() && !!DEFAULT_CLIENT_ID,
    settings: { clientId: settings.clientId, tenantId: settings.tenantId, historyDays: settings.historyDays, keepDays: settings.keepDays },
    sources: SOURCES.map((s) => ({ id: s.id, label: s.label, description: s.description, needs: s.needs, enabled: settings.sources[s.id] })),
    snapshotDays: store.days(),
    snapshotsDir: store.dir,
  };
}

function progress(p: CollectProgress): void {
  win?.webContents.send('collect-progress', p);
}

ipcMain.handle('state', () => state());

ipcMain.handle('sign-in', async () => {
  await auth.signIn(scopesFor(settings));
  return state();
});

ipcMain.handle('sign-out', async () => {
  await auth.signOut();
  return state();
});

ipcMain.handle('collect', async () => {
  if (collecting) throw new Error('A refresh is already running.');
  collecting = true;
  const started = Date.now();
  try {
    const scopes = scopesFor(settings);
    // Ask for any newly enabled scopes up front, so consent happens once.
    await auth.token(scopes);
    const graph = new Graph({ token: () => auth.token(scopes) });
    const enabled = Object.fromEntries(SOURCES.map((s) => [s.id, settings.sources[s.id]])) as Record<SourceId, boolean>;
    const { fleet, warnings } = await collect(graph, { sources: enabled, onProgress: progress });
    const json = JSON.stringify(fleet);
    store.save(json, fleet.generated);
    store.prune(settings.keepDays);
    progress({ step: 'Done', fraction: 1 });
    return { json, warnings, seconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    collecting = false;
  }
});

ipcMain.handle('load-history', () => store.load(settings.historyDays));

ipcMain.handle('save-settings', async (_e, patch: Partial<Settings> & { sources?: Partial<Record<SourceId, boolean>> }) => {
  const clientChanged = (patch.clientId !== undefined && patch.clientId.trim() !== settings.clientId.trim()) || (patch.tenantId !== undefined && patch.tenantId.trim() !== settings.tenantId.trim());
  if (clientChanged) await auth.signOut().catch(() => undefined);
  settings = {
    ...settings,
    ...(patch.clientId !== undefined ? { clientId: patch.clientId.trim() } : {}),
    ...(patch.tenantId !== undefined ? { tenantId: patch.tenantId.trim() } : {}),
    ...(patch.historyDays ? { historyDays: Math.max(2, Math.min(365, Math.round(patch.historyDays))) } : {}),
    ...(patch.keepDays ? { keepDays: Math.max(7, Math.min(3650, Math.round(patch.keepDays))) } : {}),
    sources: { ...settings.sources, ...patch.sources, devices: true },
  };
  saveSettingsFile();
  return state();
});

ipcMain.handle('open-snapshots', () => shell.openPath(store.dir).then(() => undefined));

ipcMain.handle('export-latest', async (_e, anon: boolean) => {
  const latest = store.latest();
  if (!latest || !win) return null;
  const res = await dialog.showSaveDialog(win, {
    title: 'Export fleet.json',
    defaultPath: anon ? 'fleet-anonymized.json' : 'fleet.json',
    filters: [{ name: 'Fleet Galaxy data', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return null;
  writeFileSync(res.filePath, anon ? JSON.stringify(anonymize(JSON.parse(latest))) : latest);
  return res.filePath;
});

ipcMain.handle('open-external', (_e, url: string) => {
  if (/^https:\/\//.test(url)) return shell.openExternal(url);
});

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#03050c',
    title: 'Fleet Galaxy',
    autoHideMenuBar: true,
    icon: existsSync(join(__dirname, '../build/icon.png')) ? join(__dirname, '../build/icon.png') : undefined,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Links (Intune deep links, docs) open in the real browser; the app never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:') && !url.startsWith(process.env.FLEET_DEV_URL ?? '\0')) e.preventDefault();
  });
  if (process.env.FLEET_DEV_URL) void win.loadURL(process.env.FLEET_DEV_URL);
  else void win.loadFile(join(__dirname, '../dist/demo/index.html'));
}

Menu.setApplicationMenu(null);
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
