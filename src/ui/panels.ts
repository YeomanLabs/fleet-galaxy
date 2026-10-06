// HTML for the detail panel: one builder per entity. Pure string building so
// main.ts only wires events.

import { KNOWN_FIELDS, DEPLOYMENT_KIND_LABEL, prettyField } from '../data/lenses';
import type { Device, FieldValue, User } from '../data/types';
import type { View } from '../view';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function relativeAge(days: number): string {
  if (!Number.isFinite(days)) return 'never';
  if (days < 1 / 24) return 'just now';
  if (days < 1) return `${Math.round(days * 24)} h ago`;
  if (days < 60) return `${Math.round(days)} d ago`;
  return `${Math.round(days / 30)} mo ago`;
}

const COMPLIANCE: Record<string, [string, string]> = {
  compliant: ['Compliant', '#7dd3fc'],
  ingrace: ['In grace period', '#fbbf24'],
  noncompliant: ['Not compliant', '#fb3d6b'],
  unknown: ['Compliance unknown', '#64748b'],
};

const PATCH: Record<string, string> = {
  current: 'Current',
  behind1: '1 update behind',
  behind2: '2+ updates behind',
  unknown: 'Unknown',
};

const MFA: Record<string, [string, string]> = {
  passwordless: ['Passwordless', '#6ee7b7'],
  strong: ['Authenticator app', '#7dd3fc'],
  weak: ['SMS or voice only', '#fbbf24'],
  none: ['No MFA', '#fb3d6b'],
};

const METHOD_LABEL: Record<string, string> = {
  windowsHelloForBusiness: 'Windows Hello for Business',
  microsoftAuthenticatorPasswordless: 'Authenticator (passwordless)',
  microsoftAuthenticatorPush: 'Authenticator (push)',
  softwareOneTimePasscode: 'Authenticator code',
  mobilePhone: 'SMS / voice',
  alternateMobilePhone: 'Alternate phone',
  fido2: 'FIDO2 security key',
  email: 'Email',
};

const ISSUE: Record<string, string> = {
  failed: 'Failed',
  conflict: 'Conflict',
  pending: 'Pending',
  recurred: 'Issue recurred',
};

const INTUNE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatField(key: string, v: FieldValue): string {
  if (v == null) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (key === 'defender.signaturesOverdue') return v ? 'Overdue' : 'Up to date';
  if (key === 'defender.state') return ({ clean: 'Clean', fullScanPending: 'Full scan pending', rebootPending: 'Reboot pending', manualStepsPending: 'Manual steps pending', offlineScanPending: 'Offline scan pending', critical: 'Critical' } as Record<string, string>)[String(v)] ?? String(v);
  if (key === 'ea.bootSeconds') return `${v} s`;
  if (key === 'ea.batteryHealth') return `${v}%`;
  if (key === 'lifecycle.ageYears') return `${v} years`;
  if (key === 'lifecycle.warrantyDays') return (v as number) < 0 ? `Expired ${Math.round(-(v as number) / 30)} mo ago` : `${Math.round((v as number) / 30)} months left`;
  if (key === 'lifecycle.win11') return ({ onWin11: 'On Windows 11', capable: 'Capable', notCapable: 'Not capable' } as Record<string, string>)[String(v)] ?? String(v);
  return String(v);
}

function rows(list: [string, string][]): string {
  return `<dl class="facts">${list.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

export function devicePanel(view: View, i: number, owner: { index: number; user: User } | null): string {
  const d: Device = view.fleet.devices[i];
  const f = view.facts;
  const [label, color] = COMPLIANCE[d.compliance];
  const reasons = d.complianceReasons?.length ? `<ul class="reasons">${d.complianceReasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '';

  const core: [string, string][] = [
    ['Last check-in', relativeAge(f.age[i])],
    ['Windows', f.release[i]],
    ['Build', d.osVersion || '—'],
    ['Patch level', PATCH[f.patch[i]]],
    ['Update ring', d.ring],
    ['Site', d.site],
    ['Model', `${d.manufacturer} ${d.model}`],
    ...(d.serial ? ([['Serial', d.serial]] as [string, string][]) : []),
    ['BitLocker', d.encrypted === undefined ? '—' : d.encrypted ? 'Encrypted' : 'Not encrypted'],
    ['Enrolled', d.enrolled ? new Date(d.enrolled).toLocaleDateString() : '—'],
  ];

  // Known fields, grouped like the lens picker.
  const sections = ['Security', 'Experience', 'Lifecycle']
    .map((group) => {
      const items = KNOWN_FIELDS.filter((k) => k.group === group && d.fields?.[k.field] !== undefined).map((k) => [k.label, formatField(k.field, d.fields![k.field])] as [string, string]);
      return items.length ? `<h4>${group}</h4>${rows(items)}` : '';
    })
    .join('');
  const known = new Set(KNOWN_FIELDS.map((k) => k.field));
  const custom = Object.entries(d.fields ?? {}).filter(([k]) => !known.has(k));
  const customHtml = custom.length ? `<h4>Custom fields</h4>${rows(custom.map(([k, v]) => [prettyField(k), formatField(k, v)]))}` : '';

  // Deployments that aren't happy on this device.
  const issues = (view.fleet.deployments ?? [])
    .map((dep) => ({ dep, s: dep.status[d.id] }))
    .filter((x) => x.s && ISSUE[x.s]);
  const issuesHtml = issues.length
    ? `<h4>Deployment issues</h4><ul class="issues">${issues
        .map(({ dep, s }) => `<li data-lens="deploy:${esc(dep.id)}"><span class="st st-${s}">${ISSUE[s]}</span><span class="nm">${esc(dep.name)}</span><span class="kd">${DEPLOYMENT_KIND_LABEL[dep.kind]}</span></li>`)
        .join('')}</ul>`
    : '';

  const who = owner
    ? `<button class="who link" data-user="${owner.index}">${esc(owner.user.name || owner.user.upn)} ↗</button>`
    : `<div class="who">${esc(d.user ?? 'No primary user')}</div>`;
  const intune = view.fleet.demo || !INTUNE_ID.test(d.id)
    ? ''
    : `<a class="btn" target="_blank" rel="noopener" href="https://intune.microsoft.com/#view/Microsoft_Intune_Devices/DeviceSettingsMenuBlade/~/overview/mdmDeviceId/${encodeURIComponent(d.id)}">Open in Intune ↗</a>`;

  return `
    <button class="btn icon close" aria-label="Close">×</button>
    <div class="eyebrow">Device</div>
    <h3>${esc(d.name)}</h3>
    ${who}
    <div class="status" style="--c:${color}">${label}</div>
    ${reasons}
    ${rows(core)}
    ${issuesHtml}
    ${sections}
    ${customHtml}
    <div class="actions">
      <button class="btn" data-act="copy">Copy name</button>
      ${intune}
    </div>`;
}

export function userPanel(view: View, i: number): string {
  const u: User = view.fleet.users![i];
  const pf = view.people;
  const [mfaLabel, mfaColor] = MFA[u.mfa ?? ''] ?? ['MFA unknown', '#64748b'];
  const risk = u.risk && u.risk !== 'none' ? `<div class="status" style="--c:${u.risk === 'high' ? '#fb3d6b' : u.risk === 'medium' ? '#fb923c' : '#fde68a'}">${u.risk[0].toUpperCase() + u.risk.slice(1)} risk</div>` : '';
  const disabled = !u.enabled ? '<div class="status" style="--c:#64748b">Account disabled</div>' : '';

  const list: [string, string][] = [
    ['Last sign-in', u.lastSignIn ? relativeAge(pf.idle[i]) : 'Never'],
    ['Department', u.department ?? '—'],
    ['Office', u.office ?? '—'],
    ['License', (u.licenses ?? []).join(', ') || 'Unlicensed'],
  ];
  const methods = u.methods?.length ? `<h4>Sign-in methods</h4><ul class="chips-static">${u.methods.map((m) => `<li>${esc(METHOD_LABEL[m] ?? m)}</li>`).join('')}</ul>` : '';
  const devs = pf.devices[i];
  const devHtml = devs.length
    ? `<h4>Devices</h4><ul class="devlist">${devs
        .map((di) => {
          const d = view.fleet.devices[di];
          const [, c] = COMPLIANCE[d.compliance];
          return `<li data-device="${di}"><i style="--c:${c}"></i><span>${esc(d.name)}</span><span class="m">${esc(d.model)} · ${relativeAge(view.facts.age[di])}</span></li>`;
        })
        .join('')}</ul>${devs.length > 1 ? '<button class="btn small" data-act="constellation">Show in device galaxy</button>' : ''}`
    : '<h4>Devices</h4><p class="muted">No Windows devices with this person as primary user.</p>';

  return `
    <button class="btn icon close" aria-label="Close">×</button>
    <div class="eyebrow">Person</div>
    <h3 class="sans">${esc(u.name || u.upn)}</h3>
    <div class="who">${esc(u.upn)}</div>
    <div class="pills"><div class="status" style="--c:${mfaColor}">${mfaLabel}</div>${risk}${disabled}</div>
    ${rows(list)}
    ${methods}
    ${devHtml}
    <div class="actions"><button class="btn" data-act="copy">Copy UPN</button></div>`;
}
