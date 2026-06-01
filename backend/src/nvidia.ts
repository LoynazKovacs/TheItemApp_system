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
}

let gpuAvailable: boolean | null = null;

/**
 * Read total GPU memory + utilisation via nvidia-smi. Returns null when no GPU
 * is present or the binary isn't injected (e.g. container started without the
 * nvidia runtime / `utility` capability). Per-process VRAM attribution is NOT
 * available under WSL2 (`--query-compute-apps` reports N/A), which is why
 * per-app VRAM comes from the GPU-service adapters instead.
 */
export async function getGpuSample(): Promise<GpuSample | null> {
  if (gpuAvailable === false) return null;
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=name,driver_version,memory.total,memory.used,memory.free,utilization.gpu',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 5_000 },
    );
    gpuAvailable = true;
    const line = stdout.trim().split('\n')[0] ?? '';
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 6) return null;
    return {
      name: parts[0],
      driver: parts[1],
      vramTotalMB: Number(parts[2]) || 0,
      vramUsedMB: Number(parts[3]) || 0,
      vramFreeMB: Number(parts[4]) || 0,
      utilizationPct: Number(parts[5]) || 0,
    };
  } catch {
    gpuAvailable = false;
    return null;
  }
}
