import Fastify from 'fastify';
import cors from '@fastify/cors';
import { getConfig } from './config.js';
import { loadSeedRegistry } from './seedRegistry.js';
import { CoreApiClient } from './coreApiClient.js';
import { DockerClient } from './docker.js';
import { Collector } from './collector.js';
import { registerRoutes } from './routes.js';

async function main(): Promise<void> {
  const config = getConfig();

  const app = Fastify({
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    },
  });

  await app.register(cors, { origin: false });

  const seedRegistry = loadSeedRegistry();
  const appManifest = seedRegistry.manifest;

  const coreApi = new CoreApiClient({ baseUrl: config.coreApiUrl, apiKey: config.coreApiKey });
  const docker = new DockerClient(config.dockerSocketPath);
  const collector = new Collector({ config, coreApi, docker, logger: app.log });

  registerRoutes(app, { config, coreApi, docker, collector });

  // ── App-container protocol endpoints ─────────────────────────────────────
  app.get('/app/health', async () => ({
    ok: true,
    appKey: (appManifest?.appKey as string | undefined) ?? config.appKey,
    version: (appManifest?.appVersion as string | undefined) ?? '0.0.0',
  }));
  app.get('/app/manifest', async () => appManifest ?? {});
  app.get('/app/seeds', async () => ({ collections: seedRegistry.listCollections() }));
  app.get('/app/seeds/:collection', async (request, reply) => {
    const { collection } = request.params as { collection: string };
    const data = seedRegistry.getCollection(collection);
    if (!data) return reply.code(404).send({ error: `No seed data for: ${collection}` });
    return reply.send(data);
  });

  const registerOnce = async (): Promise<boolean> => {
    if (!appManifest) return false;
    try {
      const response = await fetch(`${config.coreApiUrl}/api/apps/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.appRegistrationKey ? { 'X-Registration-Key': config.appRegistrationKey } : {}),
        },
        body: JSON.stringify({ manifest: appManifest, baseUrl: config.registrationBaseUrl }),
      });
      if (!response.ok) {
        app.log.warn({ status: response.status, body: (await response.text()).slice(0, 300) }, 'Registration failed');
        return false;
      }
      const data = (await response.json()) as any;
      app.log.info('Registered with core');
      if (data.apiKey) {
        coreApi.updateApiKey(data.apiKey);
        app.log.info('Core API client updated with auto-provisioned API key');
      } else {
        app.log.warn('No apiKey returned from core registration');
      }
      return true;
    } catch (error) {
      app.log.warn({ error: String(error) }, 'Registration request failed');
      return false;
    }
  };

  app.post('/app/re-register', async () => {
    setImmediate(() => {
      registerOnce().catch(() => {});
    });
    return { ok: true, appKey: (appManifest?.appKey as string | undefined) ?? config.appKey };
  });

  await app.listen({ host: '0.0.0.0', port: config.port });
  app.log.info(`System API listening on http://localhost:${config.port}`);

  const dockerOk = await docker.ping();
  app.log.info({ dockerOk, socket: config.dockerSocketPath }, dockerOk ? 'Docker socket reachable' : 'Docker socket NOT reachable');

  collector.start();

  const heartbeatTimer = setInterval(() => {
    if (!appManifest) return;
    void registerOnce();
  }, config.registrationHeartbeatMs);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    collector.stop();
    clearInterval(heartbeatTimer);
    try {
      await fetch(`${config.coreApiUrl}/api/apps/register/${config.appKey}`, {
        method: 'DELETE',
        headers: { ...(config.appRegistrationKey ? { 'X-Registration-Key': config.appRegistrationKey } : {}) },
      });
    } catch {
      /* best effort */
    }
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (appManifest) {
    void (async () => {
      for (let attempt = 1; attempt <= 30; attempt += 1) {
        if (await registerOnce()) return;
        app.log.info({ attempt }, 'Core not ready, retrying registration');
        await new Promise((r) => setTimeout(r, 5_000));
      }
      app.log.error('Failed to register with core after all retries');
    })();
  }
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
