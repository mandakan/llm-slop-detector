import { BUILTIN_PACKS } from '../../src/core/rules';
import { getPrefs, updatePrefs, onPrefsChanged, Prefs } from './storage';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function renderPacks(container: HTMLElement, prefs: Prefs) {
  container.innerHTML = '';
  for (const pack of BUILTIN_PACKS) {
    const id = `pack-${pack}`;
    const label = document.createElement('label');
    label.className = 'pack';
    label.innerHTML = `<input type="checkbox" id="${id}" value="${pack}"> <span>${pack}</span>`;
    container.appendChild(label);
    const cb = label.querySelector('input') as HTMLInputElement;
    cb.checked = prefs.enabledPacks.includes(pack);
    cb.addEventListener('change', async () => {
      const current = await getPrefs();
      const set = new Set(current.enabledPacks);
      if (cb.checked) set.add(pack); else set.delete(pack);
      await updatePrefs({ enabledPacks: [...set] });
    });
  }
}

function renderDisabledHosts(container: HTMLElement, prefs: Prefs) {
  container.innerHTML = '';
  if (prefs.disabledHosts.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'None.';
    container.appendChild(li);
    return;
  }
  for (const host of [...prefs.disabledHosts].sort()) {
    const li = document.createElement('li');
    li.innerHTML = `<code></code> <button type="button">Re-enable</button>`;
    (li.querySelector('code') as HTMLElement).textContent = host;
    const btn = li.querySelector('button') as HTMLButtonElement;
    btn.addEventListener('click', async () => {
      const current = await getPrefs();
      const set = new Set(current.disabledHosts);
      set.delete(host);
      await updatePrefs({ disabledHosts: [...set] });
    });
    container.appendChild(li);
  }
}

async function init() {
  let prefs = await getPrefs();
  const packsEl = $('packs');
  const hostsEl = $('disabled-hosts');
  const roToggle = $('readonly-enabled') as HTMLInputElement;
  renderPacks(packsEl, prefs);
  renderDisabledHosts(hostsEl, prefs);
  roToggle.checked = prefs.readOnlyEnabled;
  roToggle.addEventListener('change', async () => {
    await updatePrefs({ readOnlyEnabled: roToggle.checked });
  });
  onPrefsChanged(next => {
    prefs = next;
    renderPacks(packsEl, prefs);
    renderDisabledHosts(hostsEl, prefs);
    roToggle.checked = prefs.readOnlyEnabled;
  });
}

init();
