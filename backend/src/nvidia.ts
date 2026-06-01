import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GpuSample {
  name: string;
  driver: string;
  vramTotalMB: number;
  vramUsedMB: number;
  vramFreeMB: number;
  utilizationPct: number;
  memUtilizationPct: number;
  powerW: number;
  tempC: number;
  procCount: number;
}

let gpuAvailable: boolean | null = null;

/**
 * Read total GPU memory + utilisation/power/temp via nvidia-smi. Returns null
 * when no GPU is present or the binary isn't injected. Per-process VRAM
 * attribution is NOT available under WSL2 (`--query-compute-apps` returns N/A
 * for memory and `[Not Found]` for names), so we only count the number of
 * compute contexts — per-app VRAM comes from the GPU-service adapters.
 */
export async function getGpuSample(): Promise<GpuSample | null> {
  if (gpuAvailable === false) return null;
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=name,driver_version,memory.total,memory.used,memory.free,utilization.gpu,utilization.memory,power.draw,temperature.gpu',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 5_000 },
    );
    gpuAvailable = true;
    const line = stdout.trim().split('\n')[0] ?? '';
    const p = line.split(',').map((s) => s.trim());
    if (p.length < 9) return null;
    return {
      name: p[0],
      driver: p[1],
      vramTotalMB: Number(p[2]) || 0,
      vramUsedMB: Number(p[3]) || 0,
      vramFreeMB: Number(p[4]) || 0,
      utilizationPct: Number(p[5]) || 0,
      memUtilizationPct: Number(p[6]) || 0,
      powerW: Math.round((Number(p[7]) || 0) * 10) / 10,
      tempC: Number(p[8]) || 0,
      procCount: await countComputeApps(),
    };
  } catch {
    gpuAvailable = false;
    return null;
  }
}

async function countComputeApps(): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-compute-apps=pid', '--format=csv,noheader'],
      { timeout: 4_000 },
    );
    return stdout.trim().split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}
