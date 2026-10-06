// Defender antivirus health as reported to Intune. The bulk export report
// needs a ReadWrite scope, so this reads each device's protection state
// instead (one call per device, a few in parallel).
//
// Read the state directly: on a live tenant, $expand=windowsProtectionState on
// the device returns null even when the navigation property has data. The
// active malware count needs a second (beta) call, so it's only fetched for
// devices that aren't clean.

import type { Ctx } from '../collect';
import { GraphError, pool } from '../graph';

interface ProtectionState {
  deviceState?: string | null;
  realTimeProtectionEnabled?: boolean | null;
  signatureUpdateOverdue?: boolean | null;
}

export async function collectSecurity(ctx: Ctx): Promise<void> {
  const devices = ctx.fleet.devices;
  let done = 0, failures = 0, denied: GraphError | null = null;
  await pool(devices, 8, async (d) => {
    if (denied) return;
    try {
      const p = await ctx.graph.get<ProtectionState>(`deviceManagement/managedDevices/${d.id}/windowsProtectionState`);
      let threats = 0;
      if (p.deviceState && p.deviceState !== 'clean') {
        const m = await ctx.graph.get<{ windowsActiveMalwareCount?: number }>(`beta/deviceManagement/managedDevices/${d.id}?$select=id,windowsActiveMalwareCount`);
        threats = m.windowsActiveMalwareCount ?? 0;
      }
      d.fields = {
        ...d.fields,
        'defender.state': p.deviceState ?? null,
        'defender.realtime': p.realTimeProtectionEnabled ?? null,
        'defender.signaturesOverdue': p.signatureUpdateOverdue ?? null,
        'defender.threats': threats,
      };
    } catch (err) {
      if (err instanceof GraphError && err.denied) denied = err;
      // 404: the device has never reported Defender status. Leave it as "no data".
      else if (!(err instanceof GraphError && err.status === 404)) failures++;
    }
    done++;
    if (done % 25 === 0) ctx.progress('Reading Defender status', `${done.toLocaleString()} of ${devices.length.toLocaleString()} devices`, done / devices.length);
  });
  if (denied) throw denied;
  if (failures) ctx.warn(`Defender: couldn't read ${failures} device${failures === 1 ? '' : 's'}.`);
}
