import { command, flag, option, optional, positional, string } from 'cmd-ts';
import { createDevice, CreateDeviceOptions } from '../lib/create-device.js';

export const createCommand = command({
  name: 'create',
  description: 'Create a device config and secrets via 1Password',
  args: {
    dryRun: flag({
      long: 'dry-run',
      short: 'd',
      description: 'Show planned changes without applying them'
    }),
    force: flag({
      long: 'force',
      short: 'f',
      description: 'Apply changes without prompting'
    }),
    typeName: option({
      long: 'type',
      short: 't',
      type: optional(string),
      description: 'Device type name (scopes secrets and creates a base package)'
    }),
    opPath: option({
      long: 'op',
      type: optional(string),
      description: 'Override the 1Password CLI executable path'
    }),
    friendlyName: positional({
      displayName: 'friendly-name',
      type: string
    })
  },
  handler: async (args) => {
    const options: CreateDeviceOptions = {
      friendlyName: args.friendlyName,
      typeName: args.typeName ?? undefined,
      opPath: args.opPath ?? undefined,
      dryRun: args.dryRun,
      force: args.force
    };
    await createDevice(options);
  }
});
