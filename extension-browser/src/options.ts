import { BUILTIN_PACKS } from '../../src/core/rules';
import { getPrefs, updatePrefs, onPrefsChanged, Prefs } from './storage';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function clearChildren(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function renderPacks(container: HTMLElement, prefs: Prefs) {
  clearChildren(container);
  for (const pack of BUILTIN_PACKS) {
    const id = `pack-${pack}`;
    const label = document.createElement('label');
    label.className = 'pack';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.value = pack;
    cb.checked = prefs.enabledPacks.includes(pack);
    cb.addEventListener('change', async () => {
      const current = await getPrefs();
      const set = new Set(current.enabledPacks);
      if (cb.checked) set.add(pack); else set.delete(pack);
      await updatePrefs({ enabledPacks: [...set] });
    });
    const span = document.createElement('span');
    span.textContent = pack;
    label.append(cb, document.createTextNode(' '), span);
    container.appendChild(label);
  }
}

function renderDisabledHosts(container: HTMLElement, prefs: Prefs) {
  clearChildren(container);
  if (prefs.disabledHosts.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'None.';
    container.appendChild(li);
    return;
  }
  for (const host of [...prefs.disabledHosts].sort()) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = host;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Re-enable';
    btn.addEventListener('click', async () => {
      const current = await getPrefs();
      const set = new Set(current.disabledHosts);
      set.delete(host);
      await updatePrefs({ disabledHosts: [...set] });
    });
    li.append(code, document.createTextNode(' '), btn);
    container.appendChild(li);
  }
}

async function init() {
  let prefs = await getPrefs();
  const packsEl = $('packs');
  const hostsEl = $('disabled-hosts');
  const roToggle = $('readonly-enabled') as HTMLInputElement;
  const nbspToggle = $('nbsp-richtext-enabled') as HTMLInputElement;
  renderPacks(packsEl, prefs);
  renderDisabledHosts(hostsEl, prefs);
  roToggle.checked = prefs.readOnlyEnabled;
  nbspToggle.checked = prefs.detectNbspInRichText;
  roToggle.addEventListener('change', async () => {
    await updatePrefs({ readOnlyEnabled: roToggle.checked });
  });
  nbspToggle.addEventListener('change', async () => {
    await updatePrefs({ detectNbspInRichText: nbspToggle.checked });
  });
  onPrefsChanged(next => {
    prefs = next;
    renderPacks(packsEl, prefs);
    renderDisabledHosts(hostsEl, prefs);
    roToggle.checked = prefs.readOnlyEnabled;
    nbspToggle.checked = prefs.detectNbspInRichText;
  });
}

init();
