# TheItemApp_system — System Monitor

A privileged domain app that gives a single pane of glass over everything
consuming machine resources — VRAM, RAM, CPU, disk — across every container on
the host, plus controls to reclaim resources on demand.

## What it does

- **Container inventory.** Samples the Docker socket every cycle and publishes
  one `system_containers` row per container (running + stopped) with live CPU %,
  memory, writable-disk footprint, restart count, uptime, ports, and compose
  stack/service.
- **GPU attribution.** Probes a data-driven catalog of GPU services
  (`system_gpu_services`) and publishes `system_gpu_workloads` — which model /
  framework is holding VRAM right now, on which device, and whether it can be
  soft-unloaded.
- **Host totals.** `system_host` carries GPU name/driver, VRAM total/used/free
  (from `nvidia-smi`), GPU utilisation/power/temperature, attributed vs
  unattributed VRAM, and container count.
- **GPU time-series.** A fast sampler (~5 s) appends `system_gpu_samples` and
  prunes to a rolling window, backing the over-time charts so short bursts (e.g.
  STT transcriptions) are visible between the slower container cycles.
- **VRAM breakdown.** `system_vram_breakdown` is recomputed each cycle into
  slices — one per reporting GPU service, plus `unattributed` and `free` — that
  always sum to total VRAM, backing the VRAM pie.
- **Reclaim controls.** Soft-unload a single workload, batch "free idle GPU
  VRAM", offload a workload by stopping its owning container, or hard
  stop/start/restart a container (admin-gated; core/self/mongo/coding-agent are
  hard-blocked).

The UI is built entirely from core's generic prefabs — list windows + chart
windows (area / bar / pie) + row-action buttons — seeded by this app. There is
no federated frontend remote.

## Why per-app GPU attribution needs adapters

Per-container VRAM attribution is **not** available from Docker or `nvidia-smi`
under WSL2 (`--query-compute-apps` returns N/A). So per-app VRAM comes from each
GPU service self-reporting, dispatched by a small per-`kind` adapter:

| Adapter `kind`  | Source                                              |
| --------------- | --------------------------------------------------- |
| `ollama`        | `GET /api/ps` (loaded models + `size_vram`)         |
| `comfyui`       | `GET /system_stats` (torch reservation) + `/queue`  |
| `omnivoice`     | `GET /model/loaded` + `GET /sysmon/asr` (capture STT)|
| `app-resources` | first-party contract `GET /app/resources`           |
| `container`     | no API — attribute a configured `vramEstimateMB` while the backing container runs (offload = stop container) |

Because CUDA context memory usually only returns to the OS when the process
exits, soft unloads (Ollama `keep_alive:0`, ComfyUI `/free`) often don't free
everything — the only guaranteed *full* VRAM reclaim is **offload** (stopping
the container).

> **Note (intentional design tension):** as a privileged monitor, the collector
> polls third-party engines directly on the shared `theitemapp` network
> (`http://ollama:11434`, `http://comfyui:8188`, `http://omnivoice:3900`, …)
> rather than going through core. That direct reach is what lets it attribute
> VRAM for apps that never speak our schema.

## Stack

| Service      | Purpose                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `system-api` | Fastify app-container on host port 3009. Collector + control endpoints. Mounts the Docker socket and has `nvidia-smi` (`utility`) visibility. |

Routes are proxied to the browser under `/system-api/*` behind core's auth.

## Data models

- `system_gpu_services` — **config**: catalog of GPU services to probe (add a row to monitor a new one).
- `system_host` — singleton host totals.
- `system_containers` — one row per Docker container.
- `system_gpu_workloads` — one row per GPU-consuming component.
- `system_gpu_samples` — rolling GPU utilisation/VRAM/power/temp time-series (backs the over-time charts).
- `system_vram_breakdown` — whole-of-VRAM slices that sum to total (backs the VRAM pie).

## Control endpoints (`/system-api/api/*`)

| Method & path                                | Auth   | Purpose                                            |
| -------------------------------------------- | ------ | -------------------------------------------------- |
| `GET  /api/health`                           | none   | Liveness (used by the container healthcheck).      |
| `GET  /api/services`                         | auth   | The resolved GPU-service catalog.                  |
| `POST /api/control/gpu/unload/:rowId`        | auth   | Soft-unload one GPU workload via its service.      |
| `POST /api/control/free-idle`                | auth   | Soft-unload every unloadable GPU workload.         |
| `POST /api/control/workload/:rowId/offload`  | admin  | Offload a workload by stopping its owning container (the reliable full reclaim). |
| `POST /api/control/container/:action/:rowId` | admin  | Stop / start / restart a container.                |

Admin gating verifies the caller's group membership against core
(`/api/auth/me`) via the `/system-api` proxy. Protected containers (core
backend/web/mongo, any `*-mongo-*`, `coding-agent-backend`, and the monitor
itself) are hard-blocked in `routes.ts` regardless of action.

## Usage

```bash
npm start   # docker compose up -d --build
npm stop    # docker compose stop
```

Joins the shared `theitemapp` Docker network. Remove the `deploy` GPU stanza in
`docker-compose.yml` on a host without an NVIDIA GPU (the collector degrades to
no-GPU gracefully).
