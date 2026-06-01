import Docker from 'dockerode';

export interface ContainerSample {
  /** docker container id (long). */
  containerId: string;
  /** Primary container name (leading slash stripped). */
  name: string;
  image: string;
  /** docker-compose project, from the `com.docker.compose.project` label. */
  stack: string;
  /** docker-compose service, from the `com.docker.compose.service` label. */
  service: string;
  state: string;
  status: string;
  health: string;
  cpuPercent: number;
  memMB: number;
  memLimitMB: number;
  memPercent: number;
  /** Writable-layer size in MB (container disk footprint). */
  diskMB: number;
  restartCount: number;
  startedAt: string | null;
  uptimeSeconds: number;
  ports: string;
}

export class DockerClient {
  private readonly docker: Docker;

  constructor(socketPath: string) {
    this.docker = new Docker({ socketPath });
  }

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  /** Sample every container (running + stopped) with cpu/mem/disk/state. */
  async sampleContainers(): Promise<ContainerSample[]> {
    const list = await this.docker.listContainers({ all: true, size: true });
    const samples = await Promise.all(
      list.map(async (info): Promise<ContainerSample> => {
        const name = (info.Names?.[0] ?? info.Id).replace(/^\//, '');
        const labels = info.Labels ?? {};
        const ports = (info.Ports ?? [])
          .filter((p) => p.PublicPort)
          .map((p) => `${p.PublicPort}:${p.PrivatePort}/${p.Type}`)
          .join(', ');

        const base: ContainerSample = {
          containerId: info.Id,
          name,
          image: info.Image,
          stack: labels['com.docker.compose.project'] ?? '',
          service: labels['com.docker.compose.service'] ?? '',
          state: info.State,
          status: info.Status,
          health: '',
          cpuPercent: 0,
          memMB: 0,
          memLimitMB: 0,
          memPercent: 0,
          diskMB: Math.round((((info as any).SizeRw ?? 0) / (1024 * 1024)) * 10) / 10,
          restartCount: 0,
          startedAt: null,
          uptimeSeconds: 0,
          ports,
        };

        // Live stats + inspect only make sense for running containers.
        if (info.State === 'running') {
          try {
            const container = this.docker.getContainer(info.Id);
            const [stats, inspect] = await Promise.all([
              container.stats({ stream: false }) as Promise<any>,
              container.inspect(),
            ]);
            const cpu = computeCpuPercent(stats);
            const mem = computeMem(stats);
            base.cpuPercent = cpu;
            base.memMB = mem.usedMB;
            base.memLimitMB = mem.limitMB;
            base.memPercent = mem.percent;
            base.restartCount = inspect.RestartCount ?? 0;
            base.health = inspect.State?.Health?.Status ?? '';
            const startedAt = inspect.State?.StartedAt ?? null;
            if (startedAt && startedAt !== '0001-01-01T00:00:00Z') {
              base.startedAt = startedAt;
              base.uptimeSeconds = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
            }
          } catch {
            // Best effort — keep the base sample.
          }
        }
        return base;
      }),
    );
    return samples;
  }

  async findByName(name: string): Promise<Docker.ContainerInfo | null> {
    const list = await this.docker.listContainers({ all: true });
    return list.find((c) => (c.Names ?? []).some((n) => n.replace(/^\//, '') === name)) ?? null;
  }

  async controlContainer(name: string, action: 'stop' | 'start' | 'restart'): Promise<void> {
    const info = await this.findByName(name);
    if (!info) throw new Error(`Container not found: ${name}`);
    const container = this.docker.getContainer(info.Id);
    if (action === 'stop') await container.stop({ t: 10 });
    else if (action === 'start') await container.start();
    else await container.restart({ t: 10 });
  }
}

/** docker-CLI-equivalent CPU% from a single stats sample. */
function computeCpuPercent(stats: any): number {
  try {
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpus =
      stats.cpu_stats.online_cpus ||
      (stats.cpu_stats.cpu_usage.percpu_usage?.length ?? 1) ||
      1;
    if (systemDelta > 0 && cpuDelta >= 0) {
      return Math.round((cpuDelta / systemDelta) * cpus * 100 * 10) / 10;
    }
  } catch {
    /* fall through */
  }
  return 0;
}

function computeMem(stats: any): { usedMB: number; limitMB: number; percent: number } {
  try {
    const cache = stats.memory_stats.stats?.inactive_file ?? stats.memory_stats.stats?.cache ?? 0;
    const used = Math.max(0, (stats.memory_stats.usage ?? 0) - cache);
    const limit = stats.memory_stats.limit ?? 0;
    return {
      usedMB: Math.round((used / (1024 * 1024)) * 10) / 10,
      limitMB: Math.round((limit / (1024 * 1024)) * 10) / 10,
      percent: limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0,
    };
  } catch {
    return { usedMB: 0, limitMB: 0, percent: 0 };
  }
}
