// Desktop-only UI: welcome screen, account menu, refresh with progress, and
// settings. Only added when the page runs inside the Fleet Galaxy app.

import type { NativeApi } from '../native';
import { esc } from './panels';

export interface DesktopHooks {
  /** Replace what's on screen with these snapshots (fleet.json texts, oldest first). */
  loadSnapshots(jsons: string[]): void;
  loadDemo(): void;
  toast(msg: string, error?: boolean): void;
  openFiles(): void;
}

const REG_DOCS = 'https://github.com/YeomanLabs/fleet-galaxy/blob/main/docs/app-registration.md';

/** IPC errors arrive wrapped as "Error invoking remote method 'x': Error: ..."; keep the useful part. */
const why = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export async function initDesktop(api: NativeApi, hooks: DesktopHooks): Promise<void> {
  document.body.classList.add('desktop');
  let st = await api.state();

  // ---------------------------------------------------------------- top bar
  const topbar = document.querySelector('.topbar')!;
  const loadBtn = document.getElementById('load-btn')!;
  loadBtn.hidden = true;

  const refresh = el(`<button class="btn primary" id="refresh-btn" title="Pull a fresh snapshot from Microsoft Graph">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" /></svg><span>Refresh</span></button>`);
  const account = el('<button class="btn account" id="account-btn" aria-haspopup="menu"></button>');
  topbar.insertBefore(account, document.getElementById('help-btn'));
  topbar.insertBefore(refresh, account);

  const menu = el(`<div class="menu panel" id="account-menu" role="menu" hidden>
      <div class="menu-head"></div>
      <button role="menuitem" data-act="settings">Settings and data sources</button>
      <button role="menuitem" data-act="export">Export fleet.json</button>
      <button role="menuitem" data-act="export-anon">Export anonymized fleet.json</button>
      <button role="menuitem" data-act="open">Open files (fleet.json, CSV)</button>
      <button role="menuitem" data-act="folder">Show snapshots folder</button>
      <button role="menuitem" data-act="demo">Explore the demo fleet</button>
      <hr />
      <button role="menuitem" data-act="signout" class="danger">Sign out</button>
    </div>`);
  document.body.append(menu);

  const prog = el(`<div class="progress panel" id="progress" hidden>
      <div class="p-step"></div><div class="p-detail"></div><div class="p-bar"><i></i></div></div>`);
  document.body.append(prog);

  // ---------------------------------------------------------------- welcome
  const welcome = el(`<div class="welcome" id="welcome" hidden>
      <div class="welcome-card panel">
        <svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="3.6" /><ellipse cx="16" cy="16" rx="14" ry="5.5" transform="rotate(-25 16 16)" /></svg>
        <h1>See your fleet as a galaxy</h1>
        <p>Sign in with your work account. Fleet Galaxy reads your Intune and Entra data with read-only permissions, straight from Microsoft Graph to this computer. There's no Fleet Galaxy server and nothing to set up.</p>
        <div class="welcome-actions">
          <button class="btn primary big" data-act="signin">Sign in with Microsoft</button>
          <button class="btn big" data-act="demo">Explore the demo</button>
        </div>
        <p class="fine" data-slot="fine"></p>
      </div>
    </div>`);
  document.body.append(welcome);

  // ---------------------------------------------------------------- settings
  const settings = el('<dialog class="help settings" id="settings"></dialog>') as HTMLDialogElement;
  document.body.append(settings);

  function render(): void {
    account.innerHTML = st.signedIn
      ? `<span class="dot-ok"></span><span class="acct">${esc(st.account?.username ?? '')}</span>`
      : '<span>Sign in</span>';
    refresh.hidden = !st.signedIn;
    menu.querySelector('.menu-head')!.innerHTML = st.signedIn
      ? `<b>${esc(st.account?.name ?? st.account?.username ?? '')}</b><span>${esc(st.account?.username ?? '')}</span><span class="muted-s">${st.snapshotDays.length} snapshot${st.snapshotDays.length === 1 ? '' : 's'} saved</span>`
      : '<b>Not signed in</b>';
    menu.querySelector<HTMLElement>('[data-act=signout]')!.hidden = !st.signedIn;
    const fine = welcome.querySelector('[data-slot=fine]')!;
    fine.innerHTML = st.configured
      ? 'Signs in through Microsoft Graph Command Line Tools, Microsoft\'s own app that already exists in your tenant. An admin may need to approve the read-only permissions once. <a href="#" data-act="settings">Choose data sources</a>'
      : `This build has no shared app registration yet. <a href="#" data-act="settings">Enter your own client ID</a> (<a href="${REG_DOCS}" data-ext>how to create one</a>).`;
    welcome.querySelector<HTMLButtonElement>('[data-act=signin]')!.disabled = !st.configured;
  }

  function renderSettings(): void {
    settings.innerHTML = `
      <form method="dialog"><button class="close" aria-label="Close">×</button></form>
      <h2>Settings</h2>
      <h3>Data sources</h3>
      <p>Only the permissions for the sources you turn on are requested. All are read-only.</p>
      <div class="sources">${st.sources
        .map(
          (s) => `<label class="source"><input type="checkbox" name="src" value="${s.id}" ${s.enabled ? 'checked' : ''} ${s.id === 'devices' ? 'disabled' : ''} />
          <span><b>${esc(s.label)}</b><span>${esc(s.description)}</span>${s.needs ? `<em>Needs ${esc(s.needs)}</em>` : ''}</span></label>`,
        )
        .join('')}</div>
      <h3>App registration</h3>
      <p>${st.usingDefaultApp ? 'Signing in through <b>Microsoft Graph Command Line Tools</b>, Microsoft\'s own app that exists in every tenant. ' : ''}To use a dedicated app registration in your tenant instead, paste its client ID here. <a href="${REG_DOCS}" data-ext>How to create one</a>.</p>
      <div class="fields">
        <label>Client ID<input name="clientId" placeholder="${st.usingDefaultApp ? 'Blank = Graph Command Line Tools' : '00000000-0000-0000-0000-000000000000'}" value="${esc(st.settings.clientId)}" spellcheck="false" /></label>
        <label><span>Tenant ID <span class="opt">(optional)</span></span><input name="tenantId" placeholder="Any work account" value="${esc(st.settings.tenantId)}" spellcheck="false" /></label>
      </div>
      <h3>History</h3>
      <div class="fields">
        <label>Days on the timeline<input name="historyDays" type="number" min="2" max="365" value="${st.settings.historyDays}" /></label>
        <label>Days kept on disk<input name="keepDays" type="number" min="7" max="3650" value="${st.settings.keepDays}" /></label>
      </div>
      <p class="fine">One snapshot is saved per day you refresh, in <code>${esc(st.snapshotsDir)}</code>. Fleet Galaxy ${esc(st.version)}.</p>
      <div class="settings-actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="save">Save</button></div>`;
  }

  async function signIn(): Promise<void> {
    if (!st.configured) {
      hooks.toast('Add an app registration first: paste its client ID in Settings.');
      return act('settings');
    }
    try {
      hooks.toast('Finish signing in in your browser…');
      st = await api.signIn();
      render();
      welcome.hidden = true;
      await doRefresh();
    } catch (err) {
      hooks.toast(`Sign-in didn't complete: ${why(err)}`, true);
    }
  }

  async function doRefresh(): Promise<void> {
    prog.hidden = false;
    refresh.setAttribute('disabled', '');
    setProgress({ step: 'Starting', fraction: 0 });
    try {
      const res = await api.collect();
      const history = await api.loadHistory();
      hooks.loadSnapshots(history.length ? history : [res.json]);
      st = await api.state();
      render();
      const extra = res.warnings.length ? ` ${res.warnings.length} source${res.warnings.length === 1 ? '' : 's'} skipped (see Settings).` : '';
      hooks.toast(`Snapshot saved in ${res.seconds}s.${extra}`);
      if (res.warnings.length) console.warn('Fleet Galaxy collector warnings:\n' + res.warnings.join('\n'));
      lastWarnings = res.warnings;
    } catch (err) {
      hooks.toast(`Refresh failed: ${why(err)}`, true);
    } finally {
      prog.hidden = true;
      refresh.removeAttribute('disabled');
    }
  }
  let lastWarnings: string[] = [];

  function setProgress(p: { step: string; detail?: string; fraction?: number }): void {
    prog.querySelector('.p-step')!.textContent = p.step;
    prog.querySelector('.p-detail')!.textContent = p.detail ?? '';
    const bar = prog.querySelector<HTMLElement>('.p-bar i')!;
    bar.classList.toggle('indet', p.fraction === undefined);
    if (p.fraction !== undefined) bar.style.width = `${Math.round(p.fraction * 100)}%`;
  }
  api.onProgress(setProgress);

  // ---------------------------------------------------------------- events
  const act = async (name: string | undefined) => {
    menu.hidden = true;
    switch (name) {
      case 'signin':
        return signIn();
      case 'demo':
        welcome.hidden = true;
        return hooks.loadDemo();
      case 'settings':
        renderSettings();
        if (lastWarnings.length) settings.querySelector('.sources')!.insertAdjacentHTML('beforebegin', `<div class="warn">Last refresh skipped:<ul>${lastWarnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`);
        return settings.showModal();
      case 'export':
      case 'export-anon': {
        const file = await api.exportLatest(name === 'export-anon');
        if (file) hooks.toast(`Saved ${file}`);
        return;
      }
      case 'open':
        return hooks.openFiles();
      case 'folder':
        return api.openSnapshotsFolder();
      case 'signout':
        st = await api.signOut();
        render();
        hooks.toast('Signed out. Saved snapshots stay on this computer.');
        return;
    }
  };

  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const ext = t.closest<HTMLAnchorElement>('a[data-ext]');
    if (ext) {
      e.preventDefault();
      void api.openExternal(ext.href);
      return;
    }
    const a = t.closest<HTMLElement>('[data-act]');
    if (a && (menu.contains(a) || welcome.contains(a))) {
      e.preventDefault();
      void act(a.dataset.act);
      return;
    }
    if (!menu.hidden && !menu.contains(t) && t !== account && !account.contains(t)) menu.hidden = true;
  });

  account.addEventListener('click', () => {
    if (!st.signedIn) return void signIn();
    menu.hidden = !menu.hidden;
  });
  refresh.addEventListener('click', () => void doRefresh());

  settings.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    if (t === settings) return settings.close();
    const a = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (a === 'cancel') return settings.close();
    if (a !== 'save') return;
    const val = (n: string) => settings.querySelector<HTMLInputElement>(`[name=${n}]`)!.value;
    const sources = Object.fromEntries([...settings.querySelectorAll<HTMLInputElement>('[name=src]')].map((c) => [c.value, c.checked]));
    st = await api.saveSettings({ clientId: val('clientId'), tenantId: val('tenantId'), historyDays: Number(val('historyDays')), keepDays: Number(val('keepDays')), sources });
    settings.close();
    render();
    hooks.toast('Settings saved. They apply on the next refresh.');
  });

  // ---------------------------------------------------------------- boot
  render();
  if (st.snapshotDays.length) {
    hooks.loadSnapshots(await api.loadHistory());
  } else {
    welcome.hidden = false;
  }
}

function el(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}
