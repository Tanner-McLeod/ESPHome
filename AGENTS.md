## Repository overview
This repo stores and manages the ESPHome configuration for various devices in my home.

## Directory layout
- `config/` is the ESPHome config root (mounted into the container at `/config` via `docker-compose.yaml`).
- Device configs live in `config/*.yaml` (one file per device).
- Re-usable packages live in `config/packages/<device-type>/`.
- Prefer re-usable packages over duplicated YAML in device files.

## Secrets
- Secrets are stored in 1Password; generate `config/secrets.yaml` from the checked-in template with `op inject -f -i config/secrets.template.yaml -o config/secrets.yaml`.
- `config/secrets.template.yaml` contains only 1Password references and is safe to commit; never place real values there.
- Never hardcode secrets in device YAML or packages; always reference them via `!secret ...`.
- When adding a secret, add the reference key to `config/secrets.template.yaml` and store the real value in 1Password (not in git).

### Device creation helper (ask permission before running)
- Script: `scripts/create-device.sh`
- Purpose: generates encryption/OTA secrets via 1Password, appends references to `secrets.template.yaml`, and scaffolds `config/<slug>.yaml` with substitutions.
- Usage: `./scripts/create-device.sh [-d|--dry-run] [-f|--force] [--op <op|op.exe|path>] "<Friendly Name>"`
- Behavior: prints planned changes first; in dry-run it shows the generated values and does not write files; otherwise prompts unless `--force` is set, then writes template + device file and updates 1Password.

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
