# Kubify ESPHome — Deferred Design

> **Status: not yet implemented.** This document is a design for moving the
> ESPHome dashboard off ad-hoc `docker compose` onto the K3s cluster, kept on
> ice until the prerequisite infra work (see "Preconditions" below) lands.

## Context

Today, ESPHome runs ad-hoc via `docker compose` from this repo. That requires
the user to be at a workstation, start the container manually, and tear it
down when done. The goal is a persistent deployment that's always available
behind Authentik SSO at `esphome.tm-local.net`, runs on the K3s cluster
(alongside Authentik, Frigate, data-science, etc.), and reads its config from
a **two-way host mount** so VS Code Remote-SSH editing on the K3s node updates
the running dashboard live (no copies, no rebuilds).

The existing `secrets.template.yaml` / `op inject` workflow and
`scripts/create-device.sh` tooling are kept as-is; only the runtime moves
from local Docker to K3s.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Target node | **hephaestus** | The only K3s-capable node today; cross-VLAN traffic is allowed. |
| Hostname | **esphome.tm-local.net** | Internal-only via wildcard `*.tm-local.net` → matches data-science. Admin tool, no need for the public Cloudflare tunnel. |
| Source layout | **Git clone of this repo at `/srv/esphome` on hephaestus** | Pod mounts `/srv/esphome/config` → `/config`. Edit via VS Code Remote-SSH, run `scripts/create-device.sh` and `op inject` on hephaestus, commit/push from there. |
| Network mode | **Plain pod (no hostNetwork)** | Avoids exposing port 6052 unauthenticated on hephaestus's LAN IP. OTA works fine over unicast TCP. Status indicators *should* work via the dashboard's API-probe; if they don't, escalate to hostNetwork + host iptables filter (see "Fallback" below). |
| Auth pattern | **Forward auth via Authentik's embedded outpost** | ESPHome doesn't need full reverse-proxy interception. Traefik calls Authentik's forward-auth endpoint per request; if the session is valid, traffic flows directly to the esphome Service. No per-namespace outpost to provision, no `authentik-rbac.yaml` needed. |
| Secrets | **File-based via `op inject`** for v1; ESO migration as a follow-up | v1 keeps the current workflow intact. ESO migration is desirable (gets secrets off disk, matches data-science) — see "Planned follow-ups". |

## Architecture

Hybrid of the data-science pattern (Local PV, IngressRoute, cert-manager) with
forward-auth instead of a per-namespace proxy outpost:

```
Browser
  → DNS (*.tm-local.net → hephaestus)
  → Traefik (websecure, cert-manager letsencrypt cert)
       │
       ├── /outpost.goauthentik.io/*  → authentik-server (handled globally by
       │                                 the existing authentik-ingress rule —
       │                                 no new IngressRoute needed for callbacks)
       │
       └── all other paths
              → ForwardAuth middleware (calls authentik-server's embedded
                 outpost at /outpost.goauthentik.io/auth/traefik)
              → Service esphome:6052 → Deployment esphome (1 replica, hephaestus)
                   └─ /config volume = Local PV at /srv/esphome/config on hephaestus
```

The existing `authentik/config/ingress.yaml` already routes
`PathPrefix(/outpost.goauthentik.io)` to `authentik-server` for *any* host
(the match is OR'd, not AND'd to the authentik hostname). Traefik picks the
right TLS cert per-SNI, so requests to
`esphome.tm-local.net/outpost.goauthentik.io/...` get the `esphome-tls` cert
and reach the embedded outpost — no extra cross-namespace routing for this
app.

Traffic to ESP devices is plain pod egress (cluster networking allows
outbound to the IoT VLAN; OTA on TCP/3232 and API on TCP/6053 work without
hostNetwork).

## Manifests (under `esphome/k3s-manifests/`)

### `00-namespace.yaml`
Single `Namespace` resource named `esphome`.

### `storage.yaml`
- `PersistentVolume` `esphome-config`: 5 Gi, `ReadWriteOnce`,
  `local.path: /srv/esphome/config`, `nodeAffinity` to `hephaestus`,
  `storageClassName: local-path`, `persistentVolumeReclaimPolicy: Retain`.
- `PersistentVolumeClaim` `config` in `esphome` namespace, bound by
  `volumeName: esphome-config`.

Pattern reference: `data-science/manifests/storage-notebooks.yaml`.

> See "Preconditions" — manual PV is a workaround until the local-path
> provisioner is configured to use `/srv/<app>` paths.

### `esphome.yaml`
- `Deployment` `esphome` (1 replica):
  - Image: `ghcr.io/esphome/esphome:stable` (matches current `docker-compose.yaml`).
  - Pinned to hephaestus via
    `nodeSelector: { kubernetes.io/hostname: hephaestus }` (PV node affinity
    already enforces this; the selector just makes intent explicit).
  - Pod labels include
    `network-policy.esphome/allow-from-traefik: "true"`.
  - Container port `6052/tcp` named `http`.
  - Mount `/config` from PVC `config` (this is where ESPHome reads device
    YAMLs *and* writes its `.esphome/` build cache).
  - Env: none required by default (the image's CMD launches
    `esphome dashboard /config`).
  - `readinessProbe` / `livenessProbe`: TCP probe on 6052 (the dashboard
    doesn't expose a clean HTTP health endpoint; TCP connect is sufficient).
  - Resources: `requests` 200m CPU / 256Mi RAM; `limits` 2 CPU / 2Gi RAM.
    Compilation can spike memory; 2Gi headroom matches typical builds.
  - `securityContext` permissive enough that the image (which runs as root by
    default) can read/write the host-mounted `/config`. **Do not set
    `runAsNonRoot`**: the upstream image expects root for the compile
    toolchain.
- `Service` `esphome`: ClusterIP, port 6052 → targetPort `http`. Traefik
  forwards authenticated requests here directly (after the forward-auth
  middleware approves them).

### `middleware.yaml`
Traefik `Middleware` `authentik-forward-auth` in the `esphome` namespace:

```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: authentik-forward-auth
  namespace: esphome
spec:
  forwardAuth:
    address: https://authentik-server.authentik.svc.cluster.local/outpost.goauthentik.io/auth/traefik
    trustForwardHeader: true
    authResponseHeaders:
      - X-authentik-username
      - X-authentik-groups
      - X-authentik-email
      - X-authentik-name
      - X-authentik-uid
      - X-authentik-jwt
      - X-authentik-meta-jwks
      - X-authentik-meta-outpost
      - X-authentik-meta-provider
      - X-authentik-meta-app
      - X-authentik-meta-version
    tls:
      insecureSkipVerify: true   # mirrors authentik/config/ingress.yaml ServersTransport pattern
```

HTTPS+`insecureSkipVerify` mirrors the existing `authentik-transport`
ServersTransport in `authentik/config/ingress.yaml` (Authentik's internal
cert is self-signed; the same TODO applies here as in that file).

### `ingress.yaml`
- `Certificate` `esphome-tls` in namespace `esphome`,
  `dnsNames: [esphome.tm-local.net]`,
  `issuerRef: { name: letsencrypt, kind: ClusterIssuer }`.
- `IngressRoute` `esphome`:
  - `entryPoints: [websecure]`.
  - Single rule: ``Host(`esphome.tm-local.net`)`` with `priority: 400`.
  - `middlewares: [{ name: authentik-forward-auth }]` — every request goes
    through forward-auth before reaching the backend.
  - Service: `esphome:6052` (the dashboard, directly).
  - `tls.secretName: esphome-tls`.
- No second route for `/outpost.goauthentik.io/*` — that path is already
  routed cluster-wide by the existing `authentik-ingress` rule.

### `network-policies.yaml`
Simpler than data-science because there's no in-namespace outpost to gate:
- `default-deny-ingress`.
- `allow-traefik-to-esphome` — namespace `traefik` + label
  `app.kubernetes.io/name: traefik` → pods labelled
  `network-policy.esphome/allow-from-traefik: "true"` on port `http` (6052).
  Pattern: data-science's `allow-traefik-to-services` rule, renamed.

Egress is intentionally unrestricted so the pod can reach ESP devices on the
IoT VLAN for OTA / API probes.

### `deploy.sh` (in repo root, not under `k3s-manifests/`)

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

KUBECTL="$(command -v kubecolor || echo kubectl)"

echo "=== Asserting namespace..."
kubectl get namespace esphome >/dev/null 2>&1 || $KUBECTL create namespace esphome

echo "=== Applying manifests..."
$KUBECTL apply -f k3s-manifests/

echo "=== Waiting for rollout..."
$KUBECTL rollout status deployment/esphome -n esphome --timeout=120s

echo "=== Done. https://esphome.tm-local.net"
```

## Manual / out-of-band steps

These cannot be automated from the repo.

1. **Hephaestus filesystem prep:**
   ```bash
   sudo mkdir -p /srv/esphome
   sudo chown $(id -u):$(id -g) /srv/esphome
   git clone <esphome-repo-remote> /srv/esphome
   cd /srv/esphome
   op inject -f -i secrets.template.yaml -o config/secrets.yaml
   ```
2. **DNS:** confirm `esphome.tm-local.net` resolves to hephaestus
   (data-science already uses the `*.tm-local.net` wildcard).
3. **Authentik UI** (forward-auth single-application pattern):
   - **Provider:** new Proxy Provider named `esphome`, mode
     **"Forward auth (single application)"**, external host
     `https://esphome.tm-local.net`. Authorization flow / authentication flow
     per existing convention.
   - **Application:** new Application named "ESPHome" with slug `esphome`,
     linked to the provider above.
   - **Outpost:** **add the new application to the existing
     "authentik Embedded Outpost"** (Applications → Outposts in the UI). No
     new outpost is created.
4. **Cloudflared:** no change needed. `*.tm-local.net` is internal-only.

## Files to update under `esphome/`

- **`README.md`** — add a "Persistent K3s deployment" section documenting
  bootstrap and the ongoing edit-via-VS-Code-Remote workflow. Note that
  `docker-compose.yaml` is retained for ad-hoc local validation only.
- **`AGENTS.md`** — short pointer that the running dashboard lives in K3s
  and configs are under `/srv/esphome/config` on hephaestus; package /
  scripting conventions are unchanged.
- **`docker-compose.yaml`** — leave as-is (still useful for offline
  `esphome config` validation).
- **`scripts/create-device.sh`** — no changes needed; works against
  `./config/` and `./secrets.template.yaml` relative to the repo root,
  identical whether the repo lives at the dev workstation or `/srv/esphome`.

## Verification

Run after `./deploy.sh` completes:

1. **Pod healthy:** `kubectl -n esphome get pods` shows `esphome-…` `Running`
   / `Ready 1/1`. (No outpost pod is expected — forward auth uses the
   embedded outpost in the `authentik` namespace.)
2. **TLS issued:** `kubectl -n esphome get certificate esphome-tls` shows
   `READY: True`.
3. **Auth flow:** in a browser, navigate to `https://esphome.tm-local.net` —
   should redirect to Authentik login, then land on the ESPHome dashboard.
4. **Two-way mount works:** edit `config/<device>.yaml` from VS Code
   Remote-SSH on hephaestus (e.g. add a comment); reload the dashboard —
   change is visible immediately, no pod restart.
5. **Compile works:** in the dashboard, click a device → "Install" →
   "Manual download" or "Wirelessly". A successful compile confirms toolchain
   + cache directory permissions.
6. **OTA works:** install new firmware to one known device wirelessly.
   Confirms egress reachability + API key resolution.
7. **Status indicators (the open question):** check whether device tiles in
   the dashboard show ONLINE for devices that are actually up. If they're
   stuck OFFLINE, the API-probe assumption was wrong — escalate to the
   documented fallback.

## Fallback (if status indicators don't work)

Add to `esphome.yaml`:
```yaml
spec:
  template:
    spec:
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
```
…and on hephaestus, add a persisted firewall rule limiting port 6052 to the
K3s pod CIDR (otherwise an unauthenticated dashboard is exposed on
hephaestus's LAN IP):
```bash
sudo iptables -I INPUT 1 -p tcp --dport 6052 -s 10.42.0.0/16 -j ACCEPT
sudo iptables -A INPUT    -p tcp --dport 6052 -j DROP
sudo netfilter-persistent save   # or equivalent
```
This restores mDNS while keeping the unauthenticated dashboard off the LAN.

## Preconditions (the reason this is deferred)

Several choices in this design are workarounds for infra work that hasn't
landed yet. When that work happens, the corresponding choice here should be
revisited.

| Workaround in this plan | Blocked on | Cleaner version once the blocker lifts |
|---|---|---|
| Manual `PersistentVolume` with `local.path: /srv/esphome/config` and node affinity | Local-path provisioner isn't configured to use `/srv/<app>` paths | Drop the manual PV; let the provisioner dynamically allocate a `PersistentVolumeClaim` rooted at `/srv/esphome/<pvc-name>` |
| File-based secrets via `op inject` to `config/secrets.yaml` on disk | ESO isn't adopted as the default secrets pattern beyond data-science | Migrate per-device keys to `ExternalSecret` resources (see "Planned follow-ups") |
| Manual Authentik provider/application/outpost setup in the UI | No IaC for Authentik objects yet | Once Authentik is managed via blueprints / Terraform provider / similar, generate the provider+application from a manifest |
| DNS records assumed to exist (relying on the `*.tm-local.net` wildcard) | DNS isn't IaC'd | Declarative DNS management (e.g. external-dns) |
| Bootstrap requires SSHing to hephaestus to clone the repo and `op inject` | No automated cluster-wide deployment system | A GitOps system (Flux/ArgoCD) and a separate bootstrap path for `/srv/esphome` |

## Planned follow-ups (after initial deployment)

- **ESO migration for secrets.** Move from file-based `op inject` to
  External Secrets Operator, mirroring the data-science pattern
  (`bootstrap/auth-secret.yaml.tpl` + `SecretStore` + per-secret
  `ExternalSecret` resources). Outline:
  - Each per-device key-pair becomes an `ExternalSecret` materialising a
    Kubernetes Secret.
  - Pod mounts the Secret(s) at `/config/secrets.yaml` via a projected
    volume that combines all keys, OR `secrets.yaml` is generated by an
    init container from individual ExternalSecrets.
  - `scripts/create-device.sh` updates to write a new `ExternalSecret`
    manifest instead of (or in addition to) appending to
    `secrets.template.yaml`.
  - Removes the disk-resident `secrets.yaml` entirely.
- **mTLS to the embedded outpost.** Replaces
  `tls.insecureSkipVerify: true` in the middleware. Tracked alongside the
  existing TODO in `authentik/config/ingress.yaml`.
- **Status-indicator escalation.** If verification step 7 fails, switch to
  the documented `hostNetwork: true` + iptables fallback.

## Out of scope

- Public Cloudflare exposure of the dashboard.
- Multus / macvlan / mDNS reflectors.
- Changes to `cloudflared/`, `authentik/`, `kubernetes/`, or any directory
  outside `esphome/`.
- Updating `docker-compose.yaml` (kept as a local-validation tool).
