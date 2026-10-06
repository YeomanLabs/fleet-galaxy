// Intune "report actions" (POST deviceManagement/reports/...) answer with a
// table: { TotalRowCount, Schema: [{ Column }], Values: [[...]] }. The shape
// isn't in the Graph reference, so this parser is forgiving and pages with
// skip/top until it has every row.

import type { Graph } from './graph';

export type Row = Record<string, unknown>;

interface ReportPage {
  TotalRowCount?: number;
  Schema?: { Column: string }[];
  Values?: unknown[][];
}

export function rowsOf(page: ReportPage): Row[] {
  const cols = (page.Schema ?? []).map((c) => c.Column);
  return (page.Values ?? []).map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
}

export async function reportRows(graph: Graph, action: string, body: Record<string, unknown>, pageSize = 1000): Promise<Row[]> {
  const out: Row[] = [];
  for (let skip = 0; ; skip += pageSize) {
    const page = await graph.post<ReportPage>(`beta/deviceManagement/reports/${action}`, { ...body, skip, top: pageSize });
    const rows = rowsOf(page ?? {});
    out.push(...rows);
    const total = page?.TotalRowCount ?? 0;
    if (rows.length < pageSize || (total && out.length >= total)) return out;
  }
}

/** Reports often carry a localized twin column ("PolicyStatus_loc"); prefer it for matching text. */
export function text(row: Row, col: string): string {
  const v = row[`${col}_loc`] ?? row[col];
  return v == null ? '' : String(v);
}
