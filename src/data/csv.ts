// Merge a CSV into the fleet as custom fields: warranty dates from a vendor
// portal, cost centers, anything keyed by device name, serial or user.

import type { FieldValue, Fleet, LensDef } from './types';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  // Excel in some locales writes semicolon-separated "CSV".
  const firstLine = s.slice(0, s.indexOf('\n') >>> 0);
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const DEVICE_KEYS = ['devicename', 'device', 'name', 'computername', 'computer', 'hostname', 'serial', 'serialnumber', 'servicetag'];
const USER_KEYS = ['userprincipalname', 'upn', 'user', 'email', 'mail', 'emailaddress'];
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface CsvMerge {
  entity: 'device' | 'user';
  keyColumn: string;
  fields: string[];
  matched: number;
  rows: number;
}

function convert(raw: string, generated: number): FieldValue {
  const v = raw.trim();
  if (!v) return null;
  if (/^(true|yes|y)$/i.test(v)) return true;
  if (/^(false|no|n)$/i.test(v)) return false;
  const num = Number(v.replace(/[$,%]/g, ''));
  if (/^[-+$]?[\d,]*\.?\d+%?$/.test(v) && Number.isFinite(num)) return num;
  // Dates become "days from the snapshot", so warranty end dates read as days left.
  if (/^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v)) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return Math.round((t - generated) / 86_400_000);
  }
  return v;
}

/** Adds CSV columns as `csv.<column>` fields. Mutates the fleets in place. */
export function mergeCsv(fleets: Fleet[], text: string): CsvMerge {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('That CSV has no data rows.');
  const header = rows[0].map((h) => h.trim());
  const n = header.map(norm);
  let keyIdx = n.findIndex((h) => DEVICE_KEYS.includes(h));
  let entity: 'device' | 'user' = 'device';
  if (keyIdx < 0) {
    keyIdx = n.findIndex((h) => USER_KEYS.includes(h));
    entity = 'user';
  }
  if (keyIdx < 0) throw new Error('Couldn\'t find a key column. Name one "Device name", "Serial number" or "UPN".');
  const bySerial = ['serial', 'serialnumber', 'servicetag'].includes(n[keyIdx]);

  const generated = Date.parse(fleets[fleets.length - 1].generated);
  const cols = header.map((h, i) => ({ h, i })).filter((c) => c.i !== keyIdx && c.h);
  const fieldOf = (h: string) => `csv.${h}`;
  const dateCols = new Set(cols.filter((c) => rows.slice(1).some((r) => /^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test((r[c.i] ?? '').trim()))).map((c) => c.h));

  const table = new Map<string, Record<string, FieldValue>>();
  for (const r of rows.slice(1)) {
    const key = (r[keyIdx] ?? '').trim().toLowerCase();
    if (!key) continue;
    const rec: Record<string, FieldValue> = {};
    for (const c of cols) rec[fieldOf(c.h)] = convert(r[c.i] ?? '', generated);
    table.set(key, rec);
  }

  let matched = 0;
  fleets.forEach((fleet, s) => {
    const last = s === fleets.length - 1;
    if (entity === 'device') {
      for (const d of fleet.devices) {
        const rec = table.get((bySerial ? d.serial ?? '' : d.name).toLowerCase());
        if (!rec) continue;
        d.fields = { ...d.fields, ...rec };
        if (last) matched++;
      }
    } else {
      for (const u of fleet.users ?? []) {
        const rec = table.get(u.upn.toLowerCase());
        if (!rec) continue;
        u.fields = { ...u.fields, ...rec };
        if (last) matched++;
      }
    }
    const defs: LensDef[] = [...dateCols].map((h) => ({
      field: fieldOf(h), entity, label: `${h} (days from snapshot)`, kind: 'number', group: 'Custom',
      stops: [0, 90, 365], good: 'high', bucketLabels: ['Past', 'Within 90 days', '90 days to a year', 'Over a year away'],
    }));
    fleet.lenses = [...(fleet.lenses ?? []).filter((l) => !defs.some((d) => d.field === l.field)), ...defs];
  });

  return { entity, keyColumn: header[keyIdx], fields: cols.map((c) => fieldOf(c.h)), matched, rows: table.size };
}
