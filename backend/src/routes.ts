import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import type { CoreApiClient } from './coreApiClient.js';
import type { DockerClient } from './docker.js';
import type { Collector } from './collector.js';
import { makeRequireAuth, makeRequireAdmin } from './auth.js';

export interface RouteDeps {
  config: AppConfig;
  coreApi: CoreApiClient;
  docker: DockerClient;
  collector: Collector;
}

/**
 * Never let the monitor take down core, the coding-agent executor, or itself —
 * matched on container name alone so it works whether we have the compose
 * stack (container route) or only a container name (workload offload).
 */
function isProtectedContainer(name: string): boolean {
  return (
    /^theitemapp-(backend|web|mongo)/.test(name) ||
    name.includes('-mongo-') ||
    name.includes('coding-agent-backend') ||
    name.includes('system-system-api')
  );
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, coreApi, docker, collector } = deps;
  const requireAuth = makeRequireAuth(config.coreApiUrl);
  const requireAdmin = makeRequireAdmin(config.coreApiUrl, config.adminGroupId);

  app.get('/api/health', async () => ({ ok: true, appKey: config.appKey }));

  app.get('/api/services', { preHandler: requireAuth }, async () => ({
    services: collector.getServices(),
  }));

  // ── Soft unload: free a single GPU workload via its owning service ────────
  app.post('/api/control/gpu/unload/:rowId', { preHandler: requireAuth }, async (req, reply) => {
    const { rowId } = req.params as { rowId: string };
    const row = await coreApi.get('system_gpu_workloads', rowId);
    if (!row) return reply.code(404).send({ ok: false, error: 'workload not found' });
    const serviceKey = String(row.serviceKey ?? '');
    const workloadKey = String(row.workloadKey ?? '');
    if (!serviceKey || !workloadKey) {
      return reply.code(400).send({ ok: false, error: 'workload missing serviceKey/workloadKey' });
    }
    const res = await collector.unload(serviceKey, workloadKey);
    return reply.code(res.ok ? 200 : 502).send(res);
  });

  // ── Batch: free every idle / unloadable GPU workload ─────────────────────
  app.post('/api/control/free-idle', { preHandler: requireAuth }, async () => {
    const rows = await coreApi.list('system_gpu_workloads');
    const results: Array<{ workload: string; ok: boolean; detail: string }> = [];
    for (const r of rows) {
      if (r.unloadable === true && (r.status === 'idle' || r.status === 'loaded')) {
        const res = await collector.unload(String(r.serviceKey), String(r.workloadKey));
        results.push({ workload: String(r.label ?? r.wkey), ...res });
      }
    }
    return { ok: true, freed: results.filter((x) => x.ok).length, results };
  });

  // ── Hard control: stop / start / restart a container (admin-gated) ───────
  app.post('/api/control/container/:action/:rowId', { preHandler: requireAdmin }, async (req, reply) => {
    const { action, rowId } = req.params as { action: string; rowId: string };
    if (!['stop', 'start', 'restart'].includes(action)) {
      return reply.code(400).send({ ok: false, error: `invalid action: ${action}` });
    }
    const row = await coreApi.get('system_containers', rowId);
    if (!row) return reply.code(404).send({ ok: false, error: 'container row not found' });
    const name = String(row.name ?? '');
    if (!name) return reply.code(400).send({ ok: false, error: 'container row missing name' });
    if (isProtectedContainer(name)) {
      return reply.code(400).send({ ok: false, error: `refusing to ${action} protected container ${name}` });
    }
    try {
      await docker.controlContainer(name, action as 'stop' | 'start' | 'restart');
      return reply.send({ ok: true, action, name });
    } catch (err) {
      return reply.code(502).send({ ok: false, error: (err as Error).message });
    }
  });

  // ── Offload a GPU workload by stopping its owning container ──────────────
  // The reliable VRAM reclaim: soft model-unloads don't free CUDA contexts
  // (ComfyUI, CTranslate2/faster-whisper), so "offload" stops the container.
  app.post('/api/control/workload/:rowId/offload', { preHandler: requireAdmin }, async (req, reply) => {
    const { rowId } = req.params as { rowId: string };
    const row = await coreApi.get('system_gpu_workloads', rowId);
    if (!row) return reply.code(404).send({ ok: false, error: 'workload not found' });
    const name = String(row.containerName ?? '');
    if (!name) return reply.code(400).send({ ok: false, error: 'workload has no container to stop' });
    if (isProtectedContainer(name)) {
      return reply.code(400).send({ ok: false, error: `refusing to stop protected container ${name}` });
    }
    try {
      await docker.controlContainer(name, 'stop');
      return reply.send({ ok: true, action: 'offload', name });
    } catch (err) {
      return reply.code(502).send({ ok: false, error: (err as Error).message });
    }
  });
}
