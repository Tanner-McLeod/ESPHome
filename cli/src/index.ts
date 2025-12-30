#!/usr/bin/env node
import { run, subcommands } from 'cmd-ts';
import { createCommand } from './commands/create.js';

const cli = subcommands({
  name: 'esphome-cli',
  description: 'ESPHome utilities',
  cmds: {
    create: createCommand
  }
});

run(cli, process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
