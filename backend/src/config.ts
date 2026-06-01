export interface AppConfig {
  port: number;
  coreApiUrl: string;
  coreApiKey: string | null;
  appKey: string;
  appRegistrationKey: string | null;
  registrationBaseUrl: string;
  registrationHeartbeatMs: number;
  /** Docker daemon socket path (mounted read+control into the container). */
  dockerSocketPath: string;
  /** How often the collector samples docker + GPU services. */
  pollIntervalMs: number;
  /** Per-service HTTP probe timeout when polling GPU services. */
  probeTimeoutMs: number;
  /** Group that may invoke hard container controls (stop/start/restart). */
  adminGroupId: string;
  /** Auto-free GPU workloads idle longer than this (0 = disabled). */
  idleReaperSeconds: number;
  /** Fast GPU time-series sampling interval (ms). */
  gpuSampleIntervalMs: number;
  /** How many GPU time-series samples to retain (rolling window). */
  gpuSampleRetention: number;
}

function parseInt0(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getConfig(): AppConfig {
  const port = parseInt0(process.env.SYSTEM_API_PORT, 3009);
  const appKey = (process.env.SYSTEM_APP_KEY ?? '').trim() || 'system';

  return {
    port,
    coreApiUrl: (process.env.CORE_API_URL ?? '').trim() || 'http://backend:3001',
    coreApiKey: (process.env.SYSTEM_CORE_API_KEY ?? '').trim() || null,
    appKey,
    appRegistrationKey: (process.env.APP_REGISTRATION_KEY ?? '').trim() || null,
    registrationBaseUrl: (process.env.SYSTEM_REGISTRATION_BASE_URL ?? '').trim() || `http://system-api:${port}`,
    registrationHeartbeatMs: parseInt0(process.env.SYSTEM_REGISTRATION_HEARTBEAT_MS, 5 * 60 * 1000),
    dockerSocketPath: (process.env.DOCKER_SOCKET_PATH ?? '').trim() || '/var/run/docker.sock',
    pollIntervalMs: parseInt0(process.env.SYSTEM_POLL_INTERVAL_MS, 10_000),
    probeTimeoutMs: parseInt0(process.env.SYSTEM_PROBE_TIMEOUT_MS, 4_000),
    adminGroupId: (process.env.SYSTEM_ADMIN_GROUP_ID ?? '').trim() || '7000000000000000001d0001',
    idleReaperSeconds: parseInt0(process.env.SYSTEM_IDLE_REAPER_SECONDS, 0),
    gpuSampleIntervalMs: parseInt0(process.env.SYSTEM_GPU_SAMPLE_INTERVAL_MS, 5_000),
    gpuSampleRetention: parseInt0(process.env.SYSTEM_GPU_SAMPLE_RETENTION, 180),
  };
}
