import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config.js';
import { CoreApiClient, type DynRow } from './coreApiClient.js';
import { DockerClient } from './docker.js';
import { getGpuSample } from './nvidia.js';
import { probeService, unloadWorkload, type GpuServiceConfig, type ProbedWorkload, type ServiceProbe } from './adapters.js';

const GROUPS = ['7000000000000000001d0001', '7000000000000000001d0002'];

const COL_HOST = 'system_host';
const COL_CONTAINERS = 'system_containers';
const COL_WORKLOADS = 'system_gpu_workloads';
const COL_SERVICES = 'system_gpu_services';
const COL_SAMPLES = 'system_gpu_samples';
const COL_BREAKDOWN = 'system_vram_breakdown';

interface CollectorDeps {
  config: AppConfig;
  coreApi: CoreApiClient;
  docker: DockerClient;
  logger: FastifyBaseLogger;
}

export class Collector {
  private readonly config: AppConfig;
  private readonly coreApi: CoreApiClient;
  private readonly docker: DockerClient;
  private readonly log: FastifyBaseLogger;
  private timer: NodeJS.Timeout | null = null;
  private gpuTimer: NodeJS.Timeout | null = null;
  private running = false;
  private gpuSampling = false;
  private services: GpuServiceConfig[] = [];
  private hostRowId: string | null = null;
  private lastAttributedMB = 0;

  constructor(deps: CollectorDeps) {
    this.config = deps.config;
    this.coreApi = deps.coreApi;
    this.docker = deps.docker;
    this.log = deps.logger;
  }

  getServices(): GpuServiceConfig[] {
    return this.services;
  }

  getService(key: string): GpuServiceConfig | undefined {
    return this.services.find((s) => s.key === key);
  }

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (!this.coreApi.hasApiKey()) return; // gated until registration provisions a key
      if (this.running) return;
      this.running = true;
      this.collect()
        .catch((err) => this.log.warn({ err: String(err) }, 'collector cycle failed'))
        .finally(() => {
          this.running = false;
        });
    };
    this.timer = setInterval(tick, this.config.pollIntervalMs);
    tick();

    // Fast, lightweight GPU sampler — feeds the utilisation/VRAM time-series so
    // short bursts (e.g. STT transcriptions) are visible between the heavier
    // container-sampling cycles.
    const gpuTick = () => {
      if (!this.coreApi.hasApiKey() || this.gpuSampling) return;
      this.gpuSampling = true;
      this.sampleGpu()
        .catch((err) => this.log.warn({ err: String(err) }, 'gpu sample failed'))
        .finally(() => {
          this.gpuSampling = false;
        });
    };
    this.gpuTimer = setInterval(gpuTick, this.config.gpuSampleIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.gpuTimer) clearInterval(this.gpuTimer);
    this.timer = null;
    this.gpuTimer = null;
  }

  /** Manual unload entry point used by the control routes. */
  async unload(serviceKey: string, workloadKey: string): Promise<{ ok: boolean; detail: string }> {
    const cfg = this.getService(serviceKey);
    if (!cfg) return { ok: false, detail: `unknown service: ${serviceKey}` };
    const res = await unloadWorkload(cfg, workloadKey, this.config.probeTimeoutMs);
    // Refresh promptly so the UI reflects the change without waiting a full cycle.
    this.collect().catch(() => {});
    return res;
  }

  private async loadServiceCatalog(): Promise<void> {
    try {
      const rows = await this.coreApi.list(COL_SERVICES);
      this.services = rows
        .filter((r) => r.enabled !== false)
        .map((r) => ({
          key: String(r.key ?? r._id),
          name: String(r.name ?? r.key ?? 'service'),
          kind: String(r.kind ?? 'app-resources') as GpuServiceConfig['kind'],
          url: String(r.url ?? '').replace(/\/$/, ''),
          containerName: String(r.containerName ?? ''),
          vramEstimateMB: Number(r.vramEstimateMB ?? 0),
        }))
        .filter((s) => s.url.length > 0 || s.kind === 'container');
    } catch (err) {
      this.log.warn({ err: String(err) }, 'failed to load system_gpu_services catalog');
    }
  }

  private async collect(): Promise<void> {
    await this.loadServiceCatalog();

    // Probe the (light) HTTP GPU services first, then nvidia-smi, then the heavy
    // 67-container docker sampling — running them concurrently let docker stats
    // starve the event loop and time out the GPU probes (causing flapping rows).
    const httpServices = this.services.filter((s) => s.kind !== 'container');
    const containerServices = this.services.filter((s) => s.kind === 'container');
    const probes = await Promise.all(httpServices.map((s) => probeService(s, this.config.probeTimeoutMs)));
    const gpu = await getGpuSample();
    const containers = await this.docker.sampleContainers().catch((err) => {
      this.log.warn({ err: String(err) }, 'docker sample failed');
      return [];
    });

    // `container`-kind services have no API to query — attribute a configured
    // estimate while their container is running (offload = stop the container).
    const runningNames = new Set(containers.filter((c) => c.state === 'running').map((c) => c.name));
    const containerProbes: ServiceProbe[] = containerServices.map((s) => {
      const running = runningNames.has(s.containerName);
      return {
        serviceKey: s.key,
        reachable: true,
        workloads: running
          ? [{
              serviceKey: s.key,
              serviceName: s.name,
              workloadKey: 'resident',
              label: `${s.name} (est.)`,
              vramMB: s.vramEstimateMB ?? 0,
              device: 'cuda',
              status: 'loaded' as const,
              idleSeconds: 0,
              unloadable: false,
              containerName: s.containerName,
              note: 'Estimated VRAM — this engine exposes no live metric (WSL hides per-process GPU memory). Offload stops the container to reclaim it.',
              reachable: true,
            }]
          : [],
      };
    });

    const allProbes = [...probes, ...containerProbes];
    const allWorkloads = allProbes.flatMap((p) => p.workloads);

    // Isolate each reconcile so a transient failure in one doesn't stall the others.
    await this.reconcileHost(gpu, containers.length, allWorkloads).catch((err) =>
      this.log.warn({ err: String(err) }, 'reconcileHost failed'),
    );
    await this.reconcileContainers(containers).catch((err) =>
      this.log.warn({ err: String(err) }, 'reconcileContainers failed'),
    );
    await this.reconcileWorkloads(allProbes).catch((err) =>
      this.log.warn({ err: String(err) }, 'reconcileWorkloads failed'),
    );
    await this.reconcileVramBreakdown(gpu, allWorkloads).catch((err) =>
      this.log.warn({ err: String(err) }, 'reconcileVramBreakdown failed'),
    );

    if (this.config.idleReaperSeconds > 0) {
      await this.reapIdle(allWorkloads);
    }
  }

  private async ensureHostRow(): Promise<string> {
    if (this.hostRowId) return this.hostRowId;
    const rows = await this.coreApi.list(COL_HOST);
    const existing = rows.find((r) => r.kind === 'host') ?? rows[0];
    if (existing) {
      this.hostRowId = existing._id;
    } else {
      const created = await this.coreApi.create(COL_HOST, { kind: 'host', name: 'localhost', groupIds: GROUPS });
      this.hostRowId = created._id;
    }
    return this.hostRowId;
  }

  private async reconcileHost(
    gpu: Awaited<ReturnType<typeof getGpuSample>>,
    containerCount: number,
    probed: ProbedWorkload[],
  ): Promise<void> {
    const attributedVram = Math.round(probed.reduce((sum, w) => sum + (w.vramMB || 0), 0) * 10) / 10;
    this.lastAttributedMB = attributedVram;
    const used = gpu?.vramUsedMB ?? 0;
    const desired: Record<string, unknown> = {
      kind: 'host',
      name: 'localhost',
      gpuName: gpu?.name ?? '',
      gpuDriver: gpu?.driver ?? '',
      gpuPresent: Boolean(gpu),
      vramTotalMB: gpu?.vramTotalMB ?? 0,
      vramUsedMB: used,
      vramFreeMB: gpu?.vramFreeMB ?? 0,
      vramAttributedMB: attributedVram,
      vramUnattributedMB: Math.max(0, Math.round((used - attributedVram) * 10) / 10),
      gpuUtilizationPct: gpu?.utilizationPct ?? 0,
      memUtilizationPct: gpu?.memUtilizationPct ?? 0,
      powerW: gpu?.powerW ?? 0,
      tempC: gpu?.tempC ?? 0,
      gpuProcCount: gpu?.procCount ?? 0,
      containerCount,
      sampledAt: new Date().toISOString(),
      groupIds: GROUPS,
    };
    await this.coreApi.update(COL_HOST, await this.ensureHostRow(), desired);
  }

  /** Fast path: refresh host GPU fields and append a time-series sample. */
  private async sampleGpu(): Promise<void> {
    const gpu = await getGpuSample();
    if (!gpu) return;
    const now = new Date();
    const unattributed = Math.max(0, Math.round((gpu.vramUsedMB - this.lastAttributedMB) * 10) / 10);

    await this.coreApi.update(COL_HOST, await this.ensureHostRow(), {
      gpuPresent: true,
      gpuName: gpu.name,
      gpuDriver: gpu.driver,
      vramTotalMB: gpu.vramTotalMB,
      vramUsedMB: gpu.vramUsedMB,
      vramFreeMB: gpu.vramFreeMB,
      vramUnattributedMB: unattributed,
      gpuUtilizationPct: gpu.utilizationPct,
      memUtilizationPct: gpu.memUtilizationPct,
      powerW: gpu.powerW,
      tempC: gpu.tempC,
      gpuProcCount: gpu.procCount,
      sampledAt: now.toISOString(),
    });

    await this.coreApi.create(COL_SAMPLES, {
      ts: now.toISOString(),
      tsMs: now.getTime(),
      gpuUtilPct: gpu.utilizationPct,
      memUtilPct: gpu.memUtilizationPct,
      vramUsedMB: gpu.vramUsedMB,
      vramFreeMB: gpu.vramFreeMB,
      powerW: gpu.powerW,
      tempC: gpu.tempC,
      procCount: gpu.procCount,
      groupIds: GROUPS,
    });

    // Prune to the rolling retention window — one filtered hard-delete instead
    // of listing the window and soft-deleting rows one by one (soft-deleted
    // samples used to accumulate in mongo forever).
    const cutoffMs = now.getTime() - this.config.gpuSampleRetention * this.config.gpuSampleIntervalMs;
    await this.coreApi.removeByFilter(COL_SAMPLES, { tsMs: { $lt: cutoffMs } });
  }

  private async reconcileContainers(containers: Awaited<ReturnType<DockerClient['sampleContainers']>>): Promise<void> {
    const rows = await this.coreApi.list(COL_CONTAINERS);
    const byName = new Map<string, DynRow>();
    for (const r of rows) byName.set(String(r.name), r);

    const seen = new Set<string>();
    for (const c of containers) {
      seen.add(c.name);
      const desired: Record<string, unknown> = {
        name: c.name,
        containerId: c.containerId.slice(0, 12),
        image: c.image,
        stack: c.stack,
        service: c.service,
        state: c.state,
        statusText: c.status,
        health: c.health,
        cpuPercent: c.cpuPercent,
        memMB: c.memMB,
        memPercent: c.memPercent,
        diskMB: c.diskMB,
        restartCount: c.restartCount,
        uptimeSeconds: c.uptimeSeconds,
        ports: c.ports,
        sampledAt: new Date().toISOString(),
        groupIds: GROUPS,
      };
      const existing = byName.get(c.name);
      if (existing) {
        if (changed(existing, desired)) await this.coreApi.update(COL_CONTAINERS, existing._id, desired);
      } else {
        await this.coreApi.create(COL_CONTAINERS, desired);
      }
    }

    // Drop rows for containers that no longer exist.
    for (const r of rows) {
      if (!seen.has(String(r.name))) await this.coreApi.remove(COL_CONTAINERS, r._id);
    }
  }

  private async reconcileWorkloads(probes: ServiceProbe[]): Promise<void> {
    const rows = await this.coreApi.list(COL_WORKLOADS);
    const byKey = new Map<string, DynRow>();
    for (const r of rows) byKey.set(String(r.wkey), r);

    const reachableServices = new Set(probes.filter((p) => p.reachable).map((p) => p.serviceKey));
    const seen = new Set<string>();

    for (const w of probes.flatMap((p) => p.workloads)) {
      const wkey = `${w.serviceKey}:${w.workloadKey}`;
      seen.add(wkey);
      const desired: Record<string, unknown> = {
        wkey,
        serviceKey: w.serviceKey,
        serviceName: w.serviceName,
        workloadKey: w.workloadKey,
        label: w.label,
        vramMB: w.vramMB,
        device: w.device,
        status: w.status,
        idleSeconds: w.idleSeconds,
        unloadable: w.unloadable,
        containerName: w.containerName,
        note: w.note,
        sampledAt: new Date().toISOString(),
        groupIds: GROUPS,
      };
      const existing = byKey.get(wkey);
      if (existing) {
        if (changed(existing, desired)) await this.coreApi.update(COL_WORKLOADS, existing._id, desired);
      } else {
        await this.coreApi.create(COL_WORKLOADS, desired);
      }
    }

    for (const r of rows) {
      if (seen.has(String(r.wkey))) continue;
      if (reachableServices.has(String(r.serviceKey))) {
        // Service was reachable but no longer reports this workload → it was unloaded.
        await this.coreApi.remove(COL_WORKLOADS, r._id);
      } else if (r.status !== 'offline' || Number(r.vramMB) !== 0) {
        // Service unreachable this cycle → mark its rows offline, don't churn them.
        await this.coreApi.update(COL_WORKLOADS, r._id, { status: 'offline', vramMB: 0, sampledAt: new Date().toISOString() });
      }
    }
  }

  private async reconcileVramBreakdown(
    gpu: Awaited<ReturnType<typeof getGpuSample>>,
    workloads: ProbedWorkload[],
  ): Promise<void> {
    if (!gpu) return;
    const perService = new Map<string, number>();
    for (const w of workloads) {
      if (w.vramMB > 0) perService.set(w.serviceName, (perService.get(w.serviceName) ?? 0) + w.vramMB);
    }
    const attributed = [...perService.values()].reduce((a, b) => a + b, 0);
    const unattributed = Math.max(0, Math.round((gpu.vramUsedMB - attributed) * 10) / 10);

    const desired: Array<{ label: string; vramMB: number; kind: string; order: number }> = [];
    let order = 10;
    for (const [name, mb] of perService) {
      desired.push({ label: name, vramMB: Math.round(mb * 10) / 10, kind: 'service', order: order++ });
    }
    desired.push({ label: 'Unattributed', vramMB: unattributed, kind: 'unattributed', order: 90 });
    desired.push({ label: 'Free', vramMB: gpu.vramFreeMB, kind: 'free', order: 100 });

    const rows = await this.coreApi.list(COL_BREAKDOWN);
    const byLabel = new Map(rows.map((r) => [String(r.label), r]));
    const seen = new Set<string>();
    for (const d of desired) {
      seen.add(d.label);
      const existing = byLabel.get(d.label);
      const row = { ...d, sampledAt: new Date().toISOString(), groupIds: GROUPS };
      if (existing) {
        if (
          String(existing.vramMB) !== String(d.vramMB) ||
          String(existing.kind) !== String(d.kind) ||
          String(existing.order) !== String(d.order)
        ) {
          await this.coreApi.update(COL_BREAKDOWN, existing._id, row);
        }
      } else {
        await this.coreApi.create(COL_BREAKDOWN, row);
      }
    }
    for (const r of rows) {
      if (!seen.has(String(r.label))) await this.coreApi.remove(COL_BREAKDOWN, r._id);
    }
  }

  private async reapIdle(probed: ProbedWorkload[]): Promise<void> {
    for (const w of probed) {
      if (w.reachable && w.unloadable && w.status === 'idle' && w.idleSeconds >= this.config.idleReaperSeconds) {
        this.log.info({ service: w.serviceKey, workload: w.workloadKey, idleSeconds: w.idleSeconds }, 'idle reaper: unloading');
        const cfg = this.getService(w.serviceKey);
        if (cfg) await unloadWorkload(cfg, w.workloadKey, this.config.probeTimeoutMs).catch(() => {});
      }
    }
  }
}

/** Compare the mutable metric fields to avoid pointless realtime churn. */
function changed(existing: DynRow, desired: Record<string, unknown>): boolean {
  const fields = [
    'state', 'statusText', 'health', 'cpuPercent', 'memMB', 'memPercent', 'diskMB',
    'restartCount', 'uptimeSeconds', 'ports', 'image', 'stack', 'service',
    'vramMB', 'device', 'status', 'idleSeconds', 'unloadable', 'label', 'serviceName', 'note',
  ];
  for (const f of fields) {
    if (f in desired && String(existing[f] ?? '') !== String(desired[f] ?? '')) return true;
  }
  return false;
}
