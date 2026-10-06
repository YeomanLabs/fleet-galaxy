// The bridge between the page and the desktop app. In a browser it doesn't
// exist and the page runs as the static demo; in the Electron shell the
// preload script exposes it as window.fleetGalaxyNative.

export interface NativeSource {
  id: string;
  label: string;
  description: string;
  needs?: string;
  enabled: boolean;
}

export interface NativeState {
  version: string;
  signedIn: boolean;
  account?: { username: string; tenantId: string; name?: string };
  /** False until a client id is available (built-in or from Settings). */
  configured: boolean;
  usingDefaultApp: boolean;
  settings: { clientId: string; tenantId: string; historyDays: number; keepDays: number };
  sources: NativeSource[];
  snapshotDays: string[];
  snapshotsDir: string;
}

export interface CollectProgress {
  step: string;
  detail?: string;
  /** 0..1, or undefined while indeterminate. */
  fraction?: number;
}

export interface CollectResult {
  json: string;
  warnings: string[];
  seconds: number;
}

export interface NativeApi {
  state(): Promise<NativeState>;
  signIn(): Promise<NativeState>;
  signOut(): Promise<NativeState>;
  collect(): Promise<CollectResult>;
  onProgress(cb: (p: CollectProgress) => void): () => void;
  loadHistory(): Promise<string[]>;
  saveSettings(patch: { clientId?: string; tenantId?: string; historyDays?: number; keepDays?: number; sources?: Record<string, boolean> }): Promise<NativeState>;
  openSnapshotsFolder(): Promise<void>;
  exportLatest(anonymize: boolean): Promise<string | null>;
  openExternal(url: string): Promise<void>;
}

export function native(): NativeApi | undefined {
  return (window as unknown as { fleetGalaxyNative?: NativeApi }).fleetGalaxyNative;
}
