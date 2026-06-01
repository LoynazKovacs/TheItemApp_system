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
  private running = false;
  private services: GpuServiceConfig[] = [];

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
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
        }))
        .filter((s) => s.url.length > 0);
    } catch (err) {
      this.log.warn({ err: String(err) }, 'failed to load system_gpu_services catalog');
    }
  }

  private async collect(): Promise<void> {
    await this.loadServiceCatalog();

    // Probe the (light) GPU services first, then nvidia-smi, then the heavy
    // 67-container docker sampling — running them concurrently let docker stats
    // starve the event loop and time out the GPU probes (causing flapping rows).
    const probes = await Promise.all(this.services.map((s) => probeService(s, this.config.probeTimeoutMs)));
    const gpu = await getGpuSample();
    const containers = await this.docker.sampleContainers().catch((err) => {
      this.log.warn({ err: String(err) }, 'docker sample failed');
      return [];
    });

    const allWorkloads = probes.flatMap((p) => p.workloads);

    // Isolate each reconcile so a transient failure in one doesn't stall the others.
    await this.reconcileHost(gpu, containers.length, allWorkloads).catch((err) =>
      this.log.warn({ err: String(err) }, 'reconcileHost failed'),
    );
    await this.reconcileContainers(containers).catch((err) =>
      this.log.warn({ err: String(err) }, 'reconcileContainers failed'),
    );
    await this.reconcileWorkloads(probes).catch((err) =>
      this.log.warn({ err: String(err) }, 'reconcileWorkloads failed'),
    );

    if (this.config.idleReaperSeconds > 0) {
      await this.reapIdle(allWorkloads);
    }
  }

  private async reconcileHost(
    gpu: Awaited<ReturnType<typeof getGpuSample>>,
    containerCount: number,
    probed: ProbedWorkload[],
  ): Promise<void> {
    const attributedVram = Math.round(probed.reduce((sum, w) => sum + (w.vramMB || 0), 0) * 10) / 10;
    const desired: Record<string, unknown> = {
      kind: 'host',
      name: 'localhost',
      gpuName: gpu?.name ?? '',
      gpuDriver: gpu?.driver ?? '',
      gpuPresent: Boolean(gpu),
      vramTotalMB: gpu?.vramTotalMB ?? 0,
      vramUsedMB: gpu?.vramUsedMB ?? 0,
      vramFreeMB: gpu?.vramFreeMB ?? 0,
      vramAttributedMB: attributedVram,
      gpuUtilizationPct: gpu?.utilizationPct ?? 0,
      containerCount,
      sampledAt: new Date().toISOString(),
      groupIds: GROUPS,
    };

    const rows = await this.coreApi.list(COL_HOST);
    const existing = rows.find((r) => r.kind === 'host') ?? rows[0];
    if (existing) {
      await this.coreApi.update(COL_HOST, existing._id, desired);
    } else {
      await this.coreApi.create(COL_HOST, desired);
    }
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
    'vramMB', 'device', 'status', 'idleSeconds', 'unloadable', 'label', 'serviceName',
  ];
  for (const f of fields) {
    if (f in desired && String(existing[f] ?? '') !== String(desired[f] ?? '')) return true;
  }
  return false;
}
