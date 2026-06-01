/**
 * GPU-service adapters. Each GPU framework exposes its loaded models / VRAM
 * differently and almost never speaks our schema, so per-app VRAM attribution
 * is done by a small per-kind adapter. Third-party services (ollama, ComfyUI)
 * have built-in adapters by necessity; our own apps implement the generic
 * `app-resources` contract (`GET /app/resources`).
 *
 * The set of services to probe is data-driven: rows of `system_gpu_services`.
 * Add a row → a new service is monitored, no code change.
 */

export interface GpuServiceConfig {
  key: string;
  name: string;
  kind: 'ollama' | 'comfyui' | 'omnivoice' | 'app-resources';
  url: string;
  containerName: string;
}

export interface ProbedWorkload {
  serviceKey: string;
  serviceName: string;
  /** Stable key within the service (model id / name). */
  workloadKey: string;
  label: string;
  vramMB: number;
  device: string;
  status: 'loaded' | 'idle' | 'unloaded';
  idleSeconds: number;
  unloadable: boolean;
  containerName: string;
  /** Whether the service itself was reachable on this probe. */
  reachable: boolean;
}

function bytesToMB(b: number): number {
  return Math.round((b / (1024 * 1024)) * 10) / 10;
}

async function fetchJson(url: string, timeoutMs: number, init?: RequestInit): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Like fetchJson but tolerates empty/non-JSON 2xx bodies — control endpoints
 * (e.g. ComfyUI `/free`) often return 200 with no body. Throws only on a
 * non-2xx status.
 */
async function fetchOk(url: string, timeoutMs: number, init?: RequestInit): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.text().catch(() => '');
  } finally {
    clearTimeout(timer);
  }
}

export interface ServiceProbe {
  serviceKey: string;
  reachable: boolean;
  workloads: ProbedWorkload[];
}

export async function probeService(cfg: GpuServiceConfig, timeoutMs: number): Promise<ServiceProbe> {
  try {
    let workloads: ProbedWorkload[];
    switch (cfg.kind) {
      case 'ollama':
        workloads = await probeOllama(cfg, timeoutMs);
        break;
      case 'comfyui':
        workloads = await probeComfy(cfg, timeoutMs);
        break;
      case 'omnivoice':
        workloads = await probeOmnivoice(cfg, timeoutMs);
        break;
      case 'app-resources':
        workloads = await probeAppResources(cfg, timeoutMs);
        break;
      default:
        return { serviceKey: cfg.key, reachable: false, workloads: [] };
    }
    return { serviceKey: cfg.key, reachable: true, workloads };
  } catch {
    // Service unreachable this cycle: report it so the collector marks the
    // service's existing rows offline rather than churning synthetic rows.
    return { serviceKey: cfg.key, reachable: false, workloads: [] };
  }
}

async function probeOllama(cfg: GpuServiceConfig, t: number): Promise<ProbedWorkload[]> {
  const data = await fetchJson(`${cfg.url}/api/ps`, t);
  const models = Array.isArray(data?.models) ? data.models : [];
  if (models.length === 0) return [];
  return models.map((m: any): ProbedWorkload => {
    const vram = Number(m.size_vram ?? 0);
    const total = Number(m.size ?? 0);
    const onGpu = vram > 0;
    return {
      serviceKey: cfg.key,
      serviceName: cfg.name,
      workloadKey: String(m.name ?? m.model ?? 'model'),
      label: `${m.name ?? m.model}`,
      vramMB: bytesToMB(onGpu ? vram : total),
      device: onGpu ? 'cuda' : 'cpu',
      status: 'loaded',
      idleSeconds: 0,
      unloadable: true,
      containerName: cfg.containerName,
      reachable: true,
    };
  });
}

async function probeComfy(cfg: GpuServiceConfig, t: number): Promise<ProbedWorkload[]> {
  const stats = await fetchJson(`${cfg.url}/system_stats`, t);
  const dev = Array.isArray(stats?.devices) ? stats.devices[0] : null;
  let idle = false;
  try {
    const q = await fetchJson(`${cfg.url}/queue`, t);
    idle = (q?.queue_running?.length ?? 0) === 0 && (q?.queue_pending?.length ?? 0) === 0;
  } catch {
    /* queue unknown */
  }
  const torchReserved = Number(dev?.torch_vram_total ?? 0);
  return [
    {
      serviceKey: cfg.key,
      serviceName: cfg.name,
      workloadKey: 'torch',
      label: `${cfg.name} (torch reserved)`,
      vramMB: bytesToMB(torchReserved),
      device: dev?.type === 'cuda' ? 'cuda' : String(dev?.type ?? ''),
      status: torchReserved > 0 ? (idle ? 'idle' : 'loaded') : 'unloaded',
      idleSeconds: 0,
      unloadable: true,
      containerName: cfg.containerName,
      reachable: true,
    },
  ];
}

async function probeOmnivoice(cfg: GpuServiceConfig, t: number): Promise<ProbedWorkload[]> {
  const data = await fetchJson(`${cfg.url}/model/loaded`, t);
  const models = Array.isArray(data?.models) ? data.models : [];
  // Prefer the richer `/app/resources` contract if the voice-api in front of
  // OmniVoice exposes it; fall back to the raw engine model list otherwise.
  if (models.length === 0) return [];
  return models.map((m: any): ProbedWorkload => ({
    serviceKey: cfg.key,
    serviceName: cfg.name,
    workloadKey: String(m.id ?? m.name ?? 'model'),
    label: `${m.name ?? m.id}`,
    vramMB: Math.round(Number(m.vram_mb ?? 0) * 10) / 10,
    device: String(m.device ?? ''),
    status: 'loaded',
    idleSeconds: 0,
    unloadable: Boolean(m.unloadable),
    containerName: cfg.containerName,
    reachable: true,
  }));
}

async function probeAppResources(cfg: GpuServiceConfig, t: number): Promise<ProbedWorkload[]> {
  const data = await fetchJson(`${cfg.url}/app/resources`, t);
  const workloads = Array.isArray(data?.workloads) ? data.workloads : [];
  return workloads.map((w: any): ProbedWorkload => ({
    serviceKey: cfg.key,
    serviceName: cfg.name,
    workloadKey: String(w.key ?? w.label ?? 'workload'),
    label: String(w.label ?? w.key ?? cfg.name),
    vramMB: Math.round(Number(w.vramMB ?? 0) * 10) / 10,
    device: String(w.device ?? ''),
    status: (w.status as ProbedWorkload['status']) ?? 'loaded',
    idleSeconds: Number(w.idleSeconds ?? 0),
    unloadable: Boolean(w.unloadable),
    containerName: cfg.containerName,
    reachable: true,
  }));
}

/** Soft-unload a single workload through the owning service's native API. */
export async function unloadWorkload(
  cfg: GpuServiceConfig,
  workloadKey: string,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  try {
    switch (cfg.kind) {
      case 'ollama': {
        await fetchOk(`${cfg.url}/api/generate`, timeoutMs, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: workloadKey, keep_alive: 0, prompt: '' }),
        });
        return { ok: true, detail: `ollama unloaded ${workloadKey}` };
      }
      case 'comfyui': {
        await fetchOk(`${cfg.url}/free`, timeoutMs, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ unload_models: true, free_memory: true }),
        });
        return { ok: true, detail: 'comfyui freed models + cache' };
      }
      case 'omnivoice': {
        await fetchOk(`${cfg.url}/model/unload/${encodeURIComponent(workloadKey)}`, timeoutMs, {
          method: 'POST',
        });
        return { ok: true, detail: `omnivoice unloaded ${workloadKey}` };
      }
      case 'app-resources': {
        await fetchOk(`${cfg.url}/app/resources/unload/${encodeURIComponent(workloadKey)}`, timeoutMs, {
          method: 'POST',
        });
        return { ok: true, detail: `unloaded ${workloadKey}` };
      }
      default:
        return { ok: false, detail: `unknown service kind: ${cfg.kind}` };
    }
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
