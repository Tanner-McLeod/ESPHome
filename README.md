# ESPHome
Configuration and tools for ESPHome devices Casa de Tanner-McLeod.

## Secrets

[secrets template]: secrets.template.yaml

Real secrets live in 1Password and must be injected. [secrets template][] is used to generate `config/secrets.yaml`: 
```bash
op inject -f -i secrets.template.yaml -o config/secrets.yaml
```

> [!IMPORTANT]
> Don't forget to regenerate `config/secrets.yaml` whenever secrets are added, changed, or removed. **It's not updated automatically.**

Every device should define both `api.encryption.key` and `ota.password`. Nearly identical devices can share a pair, but each device type should have its own unique encryption/OTA pair.

## Adding a device
### Create a new device
[create-device]: scripts/create-device.sh
The [create-device][] script can be used to generate a stub for a new device, along with the necessary secrets: 
```bash
# Create a device:
./scripts/create-device.sh <Friendly Name>

# Create a typed device (adds config/packages/<type>/base.yaml and uses type-scoped secrets):
./scripts/create-device.sh "<Friendly Name>" --type "<Device Type>"
./scripts/create-device.sh "<Friendly Name>" -t "<Device Type>"

# In dry-run mode:
./scripts/create-device.sh "Example Device" --dry-run
./scripts/create-device.sh "Example Device" -d

# Without prompting for confirmation:
./scripts/create-device.sh "Example Device" --force
./scripts/create-device.sh "Example Device" -f
```

Any additional secrets must be added to 1Password and the [secrets template][] manually.

> [!IMPORTANT]
> [create-device][] doesn't regenerate `config/secrets.yaml` automatically. Be sure to [update it](#secrets) before attempting to validate or install your device.


### Duplicate an existing device
To create a new instance of an existing device type, simply copy an existing config and adjust it as needed.

> [!TIP]
> It'd be nice if [create-device.sh][] could copy an existing device, or use templates, but that feature doesn't yet exist.

## Validation
Use docker to validate configurations:
```bash
docker compose run --rm esphome config /config/<device>.yaml
```

> [!IMPORTANT]
> The path is mounted inside the container, which is why the command uses `/config/` rather than `./config/`.
