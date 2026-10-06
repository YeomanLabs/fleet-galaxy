// Defender antivirus health as reported to Intune. The bulk export report
// needs a ReadWrite scope, so this reads each device's protection state
// instead (one call per device, a few in parallel). Active malware count
// comes from the same call.

import type { Ctx } from '../collect';
import { GraphError, pool } from '../graph';

interface ProtectionState {
  deviceState?: string;
  realTimeProtectionEnabled?: boolean;
  signatureUpdateOverdue?: boolean;
  malwareProtectionEnabled?: boolean;
}

export async function collectSecurity(ctx: Ctx): Promise<void> {
  const devices = ctx.fleet.devices;
  let done = 0, failures = 0, denied: GraphError | null = null;
  await pool(devices, 8, async (d) => {
    if (denied) return;
    try {
      const res = await ctx.graph.get<{ windowsActiveMalwareCount?: number; windowsProtectionState?: ProtectionState | null }>(
        `beta/deviceManagement/managedDevices/${d.id}?$select=id,windowsActiveMalwareCount&$expand=windowsProtectionState`,
      );
      const p = res.windowsProtectionState;
      if (p) {
        d.fields = {
          ...d.fields,
          'defender.state': p.deviceState ?? null,
          'defender.realtime': p.realTimeProtectionEnabled ?? null,
          'defender.signaturesOverdue': p.signatureUpdateOverdue ?? null,
          'defender.threats': res.windowsActiveMalwareCount ?? null,
        };
      }
    } catch (err) {
      if (err instanceof GraphError && err.denied) denied = err;
      else failures++;
    }
    done++;
    if (done % 25 === 0) ctx.progress('Reading Defender status', `${done.toLocaleString()} of ${devices.length.toLocaleString()} devices`, done / devices.length);
  });
  if (denied) throw denied;
  if (failures) ctx.warn(`Defender: couldn't read ${failures} device${failures === 1 ? '' : 's'}.`);
}
