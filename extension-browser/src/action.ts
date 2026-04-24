import { getPrefs, setPrefs, Prefs } from './storage';

const api = ((globalThis as any).browser ?? (globalThis as any).chrome) as typeof chrome;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

async function getActiveHost(): Promise<string | null> {
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const url = tabs[0]?.url;
    if (!url) return null;
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.host.toLowerCase();
  } catch {
    return null;
  }
}

async function init() {
  let prefs: Prefs = await getPrefs();
  const enabledEl = $('enabled') as HTMLInputElement;
  const hostWrap = $('host-toggle-wrap');
  const hostEnabledEl = $('host-enabled') as HTMLInputElement;
  const hostLabelEl = $('host-label');
  const statusEl = $('status');

  enabledEl.checked = prefs.enabled;
  enabledEl.addEventListener('change', async () => {
    prefs = { ...prefs, enabled: enabledEl.checked };
    await setPrefs(prefs);
    renderStatus();
  });

  const host = await getActiveHost();
  if (host) {
    hostWrap.hidden = false;
    hostLabelEl.textContent = host;
    hostEnabledEl.checked = !prefs.disabledHosts.includes(host);
    hostEnabledEl.addEventListener('change', async () => {
      const set = new Set(prefs.disabledHosts);
      if (hostEnabledEl.checked) set.delete(host); else set.add(host);
      prefs = { ...prefs, disabledHosts: [...set] };
      await setPrefs(prefs);
      renderStatus();
    });
  }

  $('open-options').addEventListener('click', () => {
    if (api.runtime.openOptionsPage) api.runtime.openOptionsPage();
    else window.open(api.runtime.getURL('options.html'));
  });

  function renderStatus() {
    if (!prefs.enabled) {
      statusEl.textContent = 'Off everywhere. Reload the page to take effect.';
      return;
    }
    if (host && prefs.disabledHosts.includes(host)) {
      statusEl.textContent = `Disabled on ${host}. Reload to take effect.`;
      return;
    }
    statusEl.textContent = 'Reload the page to pick up changes.';
  }

  renderStatus();
}

init().catch(e => {
  const status = document.getElementById('status');
  if (status) status.textContent = 'Error: ' + String(e);
});
