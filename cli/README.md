# esphome-cli

Type-safe, ESM-based utilities for ESPHome tooling. Commands are built with [`cmd-ts`](https://github.com/cmd-ts/cmd-ts) and mirror the behavior of the legacy Bash scripts.

## Setup

```bash
cd cli
npm install
npm run build
# or: npm start -- --help
```

The compiled binary lives at `dist/index.js` and is exposed as the `esphome-cli` bin when installed.

## create

Creates a device config, generates secrets in 1Password, and appends references to `secrets.template.yaml` at the repo root (matching `scripts/create-device.sh`).

```bash
# Basic device
node dist/index.js create "Friendly Name"

# Typed device (also creates config/packages/<type>/base.yaml)
node dist/index.js create "Friendly Name" --type "Device Type"

# Flags
node dist/index.js create "Example" --dry-run
node dist/index.js create "Example" --force
node dist/index.js create "Example" --op /path/to/op
```

Dependencies: 1Password CLI (`op`), `openssl`, and access to the repo root (`config/` and `secrets.template.yaml`).
