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
  (from `nvidia-smi`), attributed VRAM, GPU utilisation, and container count.
- **Reclaim controls.** Soft-unload a single workload, batch "free idle GPU
  VRAM", or hard stop/start/restart a container (admin-gated; core/self/mongo
  are hard-blocked).

The UI is built entirely from core's generic prefabs (list windows + row-action
buttons) seeded by this app — there is no federated frontend remote.

## Why per-app GPU attribution needs adapters

Per-container VRAM attribution is **not** available from Docker or `nvidia-smi`
under WSL2 (`--query-compute-apps` returns N/A). So per-app VRAM comes from each
GPU service self-reporting. Third-party services use built-in adapters
(`ollama` `/api/ps`, `comfyui` `/system_stats`, `omnivoice` `/model/loaded`);
first-party apps can implement the generic `app-resources` contract
(`GET /app/resources`). And because CUDA context memory usually only returns to
the OS when the process exits, the only guaranteed *full* VRAM reclaim is
stopping the container.

## Stack

| Service      | Purpose                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `system-api` | Fastify app-container on port 3009. Collector + control endpoints. Mounts the Docker socket and has `nvidia-smi` (`utility`) visibility. |

Routes are proxied to the browser under `/system-api/*` behind core's auth.

## Data models

- `system_gpu_services` — **config**: catalog of GPU services to probe (add a row to monitor a new one).
- `system_host` — singleton host totals.
- `system_containers` — one row per Docker container.
- `system_gpu_workloads` — one row per GPU-consuming component.

## Control endpoints (`/system-api/api/control/*`)

| Method & path                                | Purpose                                            |
| -------------------------------------------- | -------------------------------------------------- |
| `POST /control/gpu/unload/:rowId`            | Soft-unload one GPU workload via its service.      |
| `POST /control/free-idle`                    | Soft-unload every unloadable GPU workload.         |
| `POST /control/container/:action/:rowId`     | Stop / start / restart a container (admin-gated).  |

## Usage

```bash
npm start   # docker compose up -d --build
npm stop    # docker compose stop
```

Joins the shared `theitemapp` Docker network. Remove the `deploy` GPU stanza in
`docker-compose.yml` on a host without an NVIDIA GPU (the collector degrades to
no-GPU gracefully).
