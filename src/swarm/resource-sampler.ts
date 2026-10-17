/**
 * Stage 57 — sample container memory/CPU and host memory while workers run.
 *
 * Phase 2 uses it to find how many workers the server holds before memory pressure,
 * which sets the global worker limit. `docker stats --no-stream` takes a second or two
 * on its own, so samples are taken back to back rather than on a fixed clock.
 */
import { execFile } from 'child_process';
import fs from 'fs';

import { CONTAINER_RUNTIME_BIN } from '../container-runtime.js';

export interface ResourceReport {
  samples: number;
  /** Peak memory per container, MB. */
  peakMemMbByContainer: Record<string, number>;
  /** Peak CPU per container, % of one core as docker reports it. */
  peakCpuByContainer: Record<string, number>;
  /** Highest total worker memory seen in one sample, MB, and how many were running then. */
  peakTotalMemMb: number;
  containersAtPeak: number;
  /** Most containers seen running in one sample. */
  maxConcurrent: number;
  /** Lowest host MemAvailable seen, MB (null when /proc/meminfo is unreadable). */
  minHostAvailableMb: number | null;
  hostTotalMb: number | null;
}

function toMb(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*([KMG]i?B|B)$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit.startsWith('G')) return n * 1024;
  if (unit.startsWith('M')) return n;
  if (unit.startsWith('K')) return n / 1024;
  return n / (1024 * 1024);
}

function hostMem(): { availableMb: number; totalMb: number } | null {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf-8');
    const get = (k: string) =>
      Number(txt.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm'))?.[1] ?? NaN) /
      1024;
    const availableMb = get('MemAvailable'),
      totalMb = get('MemTotal');
    return Number.isFinite(availableMb) && Number.isFinite(totalMb)
      ? { availableMb, totalMb }
      : null;
  } catch {
    return null;
  }
}

function dockerStats(): Promise<
  Array<{ name: string; memMb: number; cpu: number }>
> {
  return new Promise((resolve) => {
    execFile(
      CONTAINER_RUNTIME_BIN,
      [
        'stats',
        '--no-stream',
        '--format',
        '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}',
      ],
      { timeout: 15_000 },
      (err, stdout) => {
        if (err) return resolve([]);
        resolve(
          stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              const [name, mem, cpu] = line.split('\t');
              return {
                name,
                memMb: toMb((mem ?? '').split('/')[0] ?? ''),
                cpu: parseFloat((cpu ?? '').replace('%', '')) || 0,
              };
            }),
        );
      },
    );
  });
}

/** Start sampling containers whose name starts with `prefix`. Call stop() for the report. */
export function startResourceSampler(prefix: string): {
  stop: () => Promise<ResourceReport>;
} {
  const report: ResourceReport = {
    samples: 0,
    peakMemMbByContainer: {},
    peakCpuByContainer: {},
    peakTotalMemMb: 0,
    containersAtPeak: 0,
    maxConcurrent: 0,
    minHostAvailableMb: null,
    hostTotalMb: null,
  };
  let running = true;
  const loop = (async () => {
    while (running) {
      const rows = (await dockerStats()).filter((r) =>
        r.name.startsWith(prefix),
      );
      const host = hostMem();
      report.samples++;
      if (host) {
        report.hostTotalMb = Math.round(host.totalMb);
        report.minHostAvailableMb = Math.round(
          Math.min(report.minHostAvailableMb ?? Infinity, host.availableMb),
        );
      }
      let total = 0;
      for (const r of rows) {
        total += r.memMb;
        report.peakMemMbByContainer[r.name] = Math.round(
          Math.max(report.peakMemMbByContainer[r.name] ?? 0, r.memMb),
        );
        report.peakCpuByContainer[r.name] = Math.round(
          Math.max(report.peakCpuByContainer[r.name] ?? 0, r.cpu),
        );
      }
      report.maxConcurrent = Math.max(report.maxConcurrent, rows.length);
      if (total > report.peakTotalMemMb) {
        report.peakTotalMemMb = Math.round(total);
        report.containersAtPeak = rows.length;
      }
      if (running) await new Promise((r) => setTimeout(r, 500));
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return report;
    },
  };
}
