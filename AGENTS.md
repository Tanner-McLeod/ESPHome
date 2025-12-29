## Repository overview
This repo stores and manages the ESPHome configuration for various devices in my home.

## Directory layout
- `config/` is the ESPHome config root (mounted into the container at `/config` via `docker-compose.yaml`).
- Device configs live in `config/*.yaml` (one file per device).
- Re-usable packages live in `config/packages/<device-type>/`.
- Prefer re-usable packages over duplicated YAML in device files.

## Secrets
- All secrets must go in `config/secrets.yaml`.
- Never hardcode secrets in device YAML or packages; always reference them via `!secret ...`.
- If you need a new secret, add a new key name and update YAML to reference it, but do not include real secret values in commits.

## Required security settings (per device)
Every device must have:
- an `api.encryption.key`
- an `ota.password`

Policy:
- Nearly identical devices can share an encryption key and OTA password.
- Each *type* of device should have a unique key/password (e.g., one pair for `heat-pump`, another pair for `garage-door`).

## Configuration conventions
- Keep each `config/<device>.yaml` minimal: `substitutions` + `packages` includes.
- Packages should be parameterized via `substitutions` and/or `vars` to avoid per-device duplication.
- Avoid baking Home Assistant entity IDs into shared packages; pass them in via `vars` (see `config/packages/heat-pump/source-config.yaml`).

## Generated files
- `config/.esphome/` is generated/cache content (IDE data, build state). Avoid editing it by hand.

## Local validation
From repo root:
- `docker compose run --rm esphome config /config/<device>.yaml`
