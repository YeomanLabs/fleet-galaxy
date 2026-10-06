// Snapshots on disk: one gzipped fleet.json per day (the latest run of the day
// wins), pruned after keepDays. This is what feeds the time machine.

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const NAME = /^(\d{4}-\d{2}-\d{2})\.json\.gz$/;

export class SnapshotStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  save(json: string, generated: string): string {
    const day = generated.slice(0, 10);
    const file = join(this.dir, `${day}.json.gz`);
    writeFileSync(file, gzipSync(json));
    return file;
  }

  /** Days with a snapshot, oldest first. */
  days(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .map((f) => NAME.exec(f)?.[1])
      .filter((d): d is string => !!d)
      .sort();
  }

  /** The last `count` snapshots as JSON text, oldest first. */
  load(count: number): string[] {
    return this.days()
      .slice(-count)
      .map((d) => gunzipSync(readFileSync(join(this.dir, `${d}.json.gz`))).toString('utf8'));
  }

  latest(): string | null {
    const d = this.days().at(-1);
    return d ? gunzipSync(readFileSync(join(this.dir, `${d}.json.gz`))).toString('utf8') : null;
  }

  prune(keepDays: number, now = Date.now()): number {
    const cutoff = new Date(now - keepDays * 86_400_000).toISOString().slice(0, 10);
    let removed = 0;
    for (const d of this.days()) {
      if (d < cutoff) {
        unlinkSync(join(this.dir, `${d}.json.gz`));
        removed++;
      }
    }
    return removed;
  }
}
