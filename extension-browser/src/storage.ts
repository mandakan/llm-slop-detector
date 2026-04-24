// Typed wrapper over chrome.storage.local. Works in Chrome, Firefox, and
// Chromium forks (Arc, Brave, Edge) via the globalThis.browser ?? chrome shim.
// Per-device only -- we deliberately don't use storage.sync so a user's
// selected packs and per-site disables don't fan out to other devices.

type BrowserApi = typeof chrome;
const api: BrowserApi = ((globalThis as any).browser ?? (globalThis as any).chrome) as BrowserApi;

export type Prefs = {
  enabled: boolean;
  enabledPacks: string[];
  disabledHosts: string[];
  readOnlyEnabled: boolean;
};

export const DEFAULTS: Prefs = {
  enabled: true,
  enabledPacks: [],
  disabledHosts: [],
  readOnlyEnabled: true,
};

const KEY = 'prefs';

export async function getPrefs(): Promise<Prefs> {
  const raw = await api.storage.local.get(KEY);
  const stored = (raw as Record<string, unknown>)[KEY] as Partial<Prefs> | undefined;
  return {
    enabled: typeof stored?.enabled === 'boolean' ? stored.enabled : DEFAULTS.enabled,
    enabledPacks: Array.isArray(stored?.enabledPacks)
      ? (stored!.enabledPacks as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.enabledPacks,
    disabledHosts: Array.isArray(stored?.disabledHosts)
      ? (stored!.disabledHosts as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.disabledHosts,
    readOnlyEnabled: typeof stored?.readOnlyEnabled === 'boolean' ? stored.readOnlyEnabled : DEFAULTS.readOnlyEnabled,
  };
}

export async function setPrefs(next: Prefs): Promise<void> {
  await api.storage.local.set({ [KEY]: next });
}

export async function updatePrefs(update: Partial<Prefs>): Promise<Prefs> {
  const current = await getPrefs();
  const next = { ...current, ...update };
  await setPrefs(next);
  return next;
}

export function onPrefsChanged(cb: (prefs: Prefs) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (areaName !== 'local') return;
    if (!(KEY in changes)) return;
    getPrefs().then(cb).catch(() => { /* ignore */ });
  };
  api.storage.onChanged.addListener(listener);
  return () => api.storage.onChanged.removeListener(listener);
}

export function isHostDisabled(prefs: Prefs, host: string): boolean {
  return prefs.disabledHosts.includes(host.toLowerCase());
}
