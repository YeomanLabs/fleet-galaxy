// Exposes a narrow, typed API to the page. No Node access leaks through.

import { contextBridge, ipcRenderer } from 'electron';
import type { CollectProgress, NativeApi } from '../src/native';

const api: NativeApi = {
  state: () => ipcRenderer.invoke('state'),
  signIn: () => ipcRenderer.invoke('sign-in'),
  signOut: () => ipcRenderer.invoke('sign-out'),
  collect: () => ipcRenderer.invoke('collect'),
  onProgress: (cb) => {
    const listener = (_e: unknown, p: CollectProgress) => cb(p);
    ipcRenderer.on('collect-progress', listener);
    return () => ipcRenderer.removeListener('collect-progress', listener);
  },
  loadHistory: () => ipcRenderer.invoke('load-history'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  openSnapshotsFolder: () => ipcRenderer.invoke('open-snapshots'),
  exportLatest: (anonymize) => ipcRenderer.invoke('export-latest', anonymize),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
};

contextBridge.exposeInMainWorld('fleetGalaxyNative', api);
