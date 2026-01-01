# Heat Pump Config

> [!NOTE]
> The configurations are largely documented elsewhere.
> This is just supplemental.

## Configuring external sensors
Use [source-config](source-config.yaml) to configure one (or more) external sensors, then make them selectable with the `sources` substitution. See [bedroom heat pump](../../heat-pump-bedroom.yaml) for a single-sensor example, or [loft heat pump](../../heat-pump-loft.yaml) for a multi-sensor example.

For safety, external sensors are configured to timeout if there's no update within a certain amount of time. This prevents runaway heating or cooling if a sensor stops reporting.

## ZigBee Sensors

Sleepy ZigBee devices may still fail to meet the timeout requirement, causing the heat pump to switch over to the internal sensor and turn off prematurely.

Using ZHA Toolkit, we can get and set the reporting configuration of a sensor. For example:
```yaml
action: zha_toolkit.conf_report_read
data:
  ieee: sensor.loft_office_sensor_temperature
  cluster: 0x0402
  attribute: measured_value
  tries: 50
```

This is the default configuration for a Sonoff SNZB-02P:
```yaml
result_conf:
  - cluster: Temperature Measurement
    cluster_id: "0x0402"
    ep: 1
    attr_id: "0x0000"
    direction: 0
    status: 0
    type: "0x29"
    min_interval:
      - 5 # Wait at least 5 seconds between updates.
    max_interval:
      - 3600 # Send an update at least every hour.
    reportable_change:
      - 20 # Update before max_interval if the change is >0.2∆C (>0.36∆F)
    attr: measured_value
```

With this configuration, it's possible to hit the configured timeout if the temperature is stable within 0.36∆F for more than 30 minutes. So any ZigBee sensor used to drive the heat pumps should be configured with a more aggressive update profile. 

Here's one such reporting configuration that should play nicer with the heat pumps (at the cost of some battery life):
```yaml
action: zha_toolkit.conf_report
data:
  ieee: sensor.loft_office_sensor_temperature
  cluster: 0x0402
  attribute: measured_value
  min_interval: 30 # Wait at least 30 seconds between updates.
  max_interval: 1500 # Send an update at least every 25 minutes
  reportable_change: 10 # Update if the change is >0.1∆C (>0.18∆F)
```

> [!CAUTION]
> Lowering `reportable_change` will likely have a big impact on battery consumption. Looking at my sensors' data, it seems like reaching the 1hr `max_interval` was rare, meaning that update frequency is largely constrained by `reportable_change`. If a sensor tends to update every 10-25 minutes normally, then halving `max_interval` to 30 minutes will have little to no impact on reporting frequency and power consumption. However, halving `reportable_change` could potentially **double** the reporting frequency and power consumption.

All of these values, as well as the controller's timeout value, can (and should) be tuned to balance performance and battery life.