import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createSpinner, Spinner } from 'nanospinner';
import { OP_SECRET_ID } from './constants.js';

const execFileAsync = promisify(execFile);

export interface CreateDeviceOptions {
  friendlyName: string;
  typeName?: string;
  opPath?: string;
  dryRun: boolean;
  force: boolean;
}

interface DerivedNames {
  friendlyName: string;
  deviceSlug: string;
  typeName?: string;
  typeSlug?: string;
  configName: string;
  configFriendlyName: string;
  configFileSlug: string;
  secretSectionSlug: string;
  secretSectionName: string;
  yamlKeyEncryption: string;
  yamlKeyOta: string;
  opRefEncryption: string;
  opRefOta: string;
}

interface Paths {
  projectRoot: string;
  configDir: string;
  templatePath: string;
  deviceConfigPath: string;
  basePackageDir?: string;
  basePackagePath?: string;
}

interface Secrets {
  encryptionKey: string;
  otaPassword: string;
}

interface PlanBlocks {
  templateBlock: string;
  deviceBlock: string;
  packageBlock?: string;
}

interface ExecAttempt {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(moduleDir, '../..');
const projectRoot = path.resolve(cliRoot, '..');
const configDir = path.join(projectRoot, 'config');
const templatePath = path.join(projectRoot, 'secrets.template.yaml');

export async function createDevice(options: CreateDeviceOptions): Promise<void> {
  const derived = deriveNames(options);
  const paths = buildPaths(derived);

  const opCmd = await resolveOpCommand(options.opPath);
  const opensslCmd = await requireExecutable('openssl', "Required command 'openssl' not found in PATH");

  await ensurePathExists(paths.templatePath, `Template file not found: ${paths.templatePath}`);
  await ensurePathExists(paths.configDir, `Config directory not found: ${paths.configDir}`);

  const progress = createProgress();

  try {
    progress.start('Checking files...');
    await checkFileConflicts(paths, derived);
    progress.succeed('Files look good.');

    progress.start('Checking 1Password...');
    await ensureOnePasswordReady(opCmd, derived.secretSectionName);
    progress.succeed('1Password ready.');

    progress.start('Generating content...');
    const plan = buildPlanBlocks(derived);
    const secrets = await generateSecrets(opensslCmd);
    progress.succeed('Generated config and secrets.');

    progress.info('Ready.');
    progress.info('');
    printPlan(paths, derived, plan);

    if (options.dryRun) {
      progress.info('Dry run: no changes will be applied.');
    } else if (!options.force) {
      const confirmed = await promptForConfirmation('Create device and secrets? [y/N] ');
      if (!confirmed) {
        console.log('Aborted.');
        process.exitCode = 1;
        return;
      }
    }

    progress.info('');

    if (!options.dryRun) {
      progress.start('Saving secrets and writing files...');
      await applyChanges(paths, derived, plan, secrets, opCmd);
      progress.succeed('Secrets saved and files written.');
    }

    printSummary(paths, derived, secrets, options.dryRun);
  } catch (error) {
    progress.fail((error as Error).message);
    throw error;
  }
}

function deriveNames(options: CreateDeviceOptions): DerivedNames {
  const friendlyName = normalizeFriendlyName(options.friendlyName);
  if (!friendlyName) {
    throw new Error('Friendly name cannot be empty');
  }
  validateNamePattern(friendlyName, 'Friendly name');

  const deviceSlug = slugify(friendlyName);

  const rawTypeName = options.typeName?.trim();
  const typeName = rawTypeName ?? undefined;
  if (options.typeName !== undefined) {
    if (!typeName) {
      throw new Error('Type name cannot be empty');
    }
    validateNamePattern(typeName, 'Type name');
  }
  const typeSlug = typeName ? slugify(typeName) : undefined;
  if (typeSlug) {
    validateSlug(typeSlug);
  }

  const configName = typeSlug ? `${deviceSlug}-${typeSlug}` : deviceSlug;
  const configFriendlyName = typeSlug ? `${friendlyName} ${typeName}` : friendlyName;
  const configFileSlug = typeSlug ? `${typeSlug}-${deviceSlug}` : deviceSlug;
  const secretSectionSlug = typeSlug ?? deviceSlug;
  const secretSectionName = typeSlug ? typeName! : friendlyName;

  validateSlug(configName);
  validateSlug(configFileSlug);

  const yamlKeyEncryption = `${secretSectionSlug}_encryption_key`;
  const yamlKeyOta = `${secretSectionSlug}_ota_password`;
  const opRefEncryption = `op://${OP_SECRET_ID}/${secretSectionName}/encryption key`;
  const opRefOta = `op://${OP_SECRET_ID}/${secretSectionName}/ota password`;

  return {
    friendlyName,
    deviceSlug,
    typeName,
    typeSlug,
    configName,
    configFriendlyName,
    configFileSlug,
    secretSectionSlug,
    secretSectionName,
    yamlKeyEncryption,
    yamlKeyOta,
    opRefEncryption,
    opRefOta
  };
}

function buildPaths(derived: DerivedNames): Paths {
  const deviceConfigPath = path.join(configDir, `${derived.configFileSlug}.yaml`);
  const basePackageDir = derived.typeSlug ? path.join(configDir, 'packages', derived.typeSlug) : undefined;
  const basePackagePath = basePackageDir ? path.join(basePackageDir, 'base.yaml') : undefined;

  return {
    projectRoot,
    configDir,
    templatePath,
    deviceConfigPath,
    basePackageDir,
    basePackagePath
  };
}

async function ensurePathExists(targetPath: string, message: string): Promise<void> {
  try {
    await access(targetPath, fsConstants.F_OK);
  } catch {
    throw new Error(message);
  }
}

async function checkFileConflicts(paths: Paths, derived: DerivedNames): Promise<void> {
  const templateContent = await readFile(paths.templatePath, 'utf8');
  if (
    hasYamlKey(templateContent, derived.yamlKeyEncryption) ||
    hasYamlKey(templateContent, derived.yamlKeyOta)
  ) {
    throw new Error(`Secrets for '${derived.secretSectionSlug}' already exist in ${paths.templatePath}; aborting.`);
  }

  if (await pathExists(paths.deviceConfigPath)) {
    throw new Error(`Device config already exists: ${paths.deviceConfigPath}; aborting.`);
  }

  if (derived.typeSlug && paths.basePackageDir && (await pathExists(paths.basePackageDir))) {
    throw new Error(`Package directory already exists: ${paths.basePackageDir}; aborting.`);
  }
}

async function ensureOnePasswordReady(opCmd: string, secretSectionName: string): Promise<void> {
  const accountCheck = await tryExec(opCmd, ['account', 'get']);
  if (!accountCheck.ok) {
    throw new Error('1Password CLI is locked or not authenticated; please sign in/unlock and try again.');
  }

  const encryptionExists = await tryExec(opCmd, [
    'item',
    'get',
    OP_SECRET_ID,
    '--field',
    `${secretSectionName}.encryption key`
  ]);
  const otaExists = await tryExec(opCmd, [
    'item',
    'get',
    OP_SECRET_ID,
    '--field',
    `${secretSectionName}.ota password`
  ]);
  if (encryptionExists.ok || otaExists.ok) {
    throw new Error(`Secrets for '${secretSectionName}' already exist in 1Password; aborting.`);
  }
}

function buildPlanBlocks(derived: DerivedNames): PlanBlocks {
  const templateBlock = [
    `# ${derived.secretSectionName}`,
    `${derived.yamlKeyEncryption}: "${derived.opRefEncryption}"`,
    `${derived.yamlKeyOta}: "${derived.opRefOta}"`,
    ''
  ].join('\n');

  const apiOtaBlock = [
    'api:',
    '  encryption:',
    `    key: !secret ${derived.yamlKeyEncryption}`,
    '',
    'ota:',
    '  - platform: esphome',
    `    password: !secret ${derived.yamlKeyOta}`
  ].join('\n');

  const deviceBaseBlock = [
    'substitutions:',
    `  name: ${derived.configName}`,
    `  friendly_name: ${derived.configFriendlyName}`
  ].join('\n');

  const deviceBlock = derived.typeSlug
    ? [
        deviceBaseBlock,
        '',
        'packages:',
        `  ${derived.typeSlug}_base: !include packages/${derived.typeSlug}/base.yaml`,
        ''
      ].join('\n')
    : [deviceBaseBlock, '', apiOtaBlock, ''].join('\n');

  const packageBlock = derived.typeSlug
    ? [
        'substitutions:',
        '  name: "REQUIRED"',
        '',
        apiOtaBlock,
        ''
      ].join('\n')
    : undefined;

  return { templateBlock, deviceBlock, packageBlock };
}

async function generateSecrets(opensslCmd: string): Promise<Secrets> {
  const encryptionKey = await execAndCapture(opensslCmd, ['rand', '-base64', '32']);
  const otaPassword = await execAndCapture(opensslCmd, ['rand', '-hex', '16']);

  return {
    encryptionKey: encryptionKey.trim(),
    otaPassword: otaPassword.trim()
  };
}

function printPlan(paths: Paths, derived: DerivedNames, plan: PlanBlocks): void {
  console.log('+++ secrets.template.yaml');
  process.stdout.write(plan.templateBlock);
  console.log('');

  const deviceConfigRel = path.relative(paths.projectRoot, paths.deviceConfigPath);
  console.log(`+++ ${deviceConfigRel}`);
  process.stdout.write(plan.deviceBlock);
  console.log('');

  if (plan.packageBlock && paths.basePackagePath) {
    const packageRel = path.relative(paths.projectRoot, paths.basePackagePath);
    console.log(`+++ ${packageRel}`);
    process.stdout.write(plan.packageBlock);
    console.log('');
  }

  console.log('+++ 1Password Secrets');
  console.log(`- "${derived.opRefEncryption}"`);
  console.log(`- "${derived.opRefOta}"`);
  console.log('');
}

async function promptForConfirmation(promptText: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(promptText);
  await rl.close();
  return /^[Yy](?:[Ee][Ss])?$/.test(answer.trim());
}

async function applyChanges(
  paths: Paths,
  derived: DerivedNames,
  plan: PlanBlocks,
  secrets: Secrets,
  opCmd: string
): Promise<void> {
  await execFileAsync(opCmd, [
    'item',
    'edit',
    OP_SECRET_ID,
    `${derived.secretSectionName}.encryption key=${secrets.encryptionKey}`,
    `${derived.secretSectionName}.ota password=${secrets.otaPassword}`
  ]);

  await appendFile(paths.templatePath, `\n${plan.templateBlock}`);
  await writeFile(paths.deviceConfigPath, plan.deviceBlock);

  if (plan.packageBlock && paths.basePackageDir && paths.basePackagePath) {
    await mkdir(paths.basePackageDir, { recursive: true });
    await writeFile(paths.basePackagePath, plan.packageBlock);
  }
}

function printSummary(paths: Paths, derived: DerivedNames, secrets: Secrets, dryRun: boolean): void {
  const resultLabel = dryRun ? 'Dry Run Complete' : 'Creation Complete';
  const encryptionKeyEmit = dryRun ? secrets.encryptionKey : '[hidden]';
  const otaPasswordEmit = dryRun ? secrets.otaPassword : '[hidden]';
  const deviceConfigRel = path.join('.', path.relative(paths.projectRoot, paths.deviceConfigPath));
  const basePackageRel = paths.basePackagePath
    ? path.join('.', path.relative(paths.projectRoot, paths.basePackagePath))
    : '[none]';

  console.log(
    [
      `=== ${resultLabel} ===`,
      `Generated device '${derived.friendlyName}' (${derived.configFriendlyName}):`,
      `- Device config: ${deviceConfigRel}`,
      `- Base package: ${basePackageRel}`,
      '- Encryption Key:',
      `  - Secret ID: ${derived.yamlKeyEncryption}`,
      `  - Reference: "${derived.opRefEncryption}"`,
      `  - Generated: ${encryptionKeyEmit}`,
      '- OTA Password:',
      `  - Secret ID: ${derived.yamlKeyOta}`,
      `  - Reference: "${derived.opRefOta}"`,
      `  - Generated: ${otaPasswordEmit}`
    ].join('\n')
  );
}

function normalizeFriendlyName(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function validateNamePattern(value: string, label: string): void {
  if (!/^[A-Za-z][A-Za-z0-9 ]*$/.test(value)) {
    throw new Error(`${label} must start with a letter and contain only letters, numbers, and spaces`);
  }
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/ +/g, '-');
}

function validateSlug(value: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new Error(`Derived name '${value}' is not valid`);
  }
}

function hasYamlKey(content: string, key: string): boolean {
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*:`, 'm');
  return pattern.test(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveOpCommand(opOverride?: string): Promise<string> {
  if (opOverride) {
    const resolved = await resolveExecutable(opOverride);
    if (!resolved) {
      throw new Error(`Resolved 1Password CLI '${opOverride}' not found`);
    }
    return resolved;
  }

  const resolved = await findFirstExecutable(['op', 'op.exe']);
  if (!resolved) {
    throw new Error('Could not find 1Password CLI (op or op.exe) in PATH.');
  }
  return resolved;
}

async function requireExecutable(commandName: string, errorMessage: string): Promise<string> {
  const resolved = await resolveExecutable(commandName);
  if (!resolved) {
    throw new Error(errorMessage);
  }
  return resolved;
}

async function resolveExecutable(candidate: string): Promise<string | null> {
  const hasPathSeparator = candidate.includes(path.sep) || candidate.startsWith('.');
  if (hasPathSeparator || path.isAbsolute(candidate)) {
    const absolutePath = path.resolve(candidate);
    return (await isExecutable(absolutePath)) ? absolutePath : null;
  }
  return findOnPath(candidate);
}

async function findFirstExecutable(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const resolved = await resolveExecutable(candidate);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

async function findOnPath(commandName: string): Promise<string | null> {
  const searchPaths = process.env.PATH?.split(path.delimiter).filter(Boolean) ?? [];
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT?.split(';').filter(Boolean) ?? ['.EXE', '.BAT', '.CMD', ''])
      : [''];

  for (const base of searchPaths) {
    for (const ext of extensions) {
      const candidateName = commandName.toLowerCase().endsWith(ext.toLowerCase())
        ? commandName
        : `${commandName}${ext}`;
      const candidatePath = path.join(base, candidateName);
      if (await isExecutable(candidatePath)) {
        return candidatePath;
      }
    }
  }
  return null;
}

async function isExecutable(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath, fsConstants.X_OK);
    return true;
  } catch {
    if (process.platform === 'win32') {
      try {
        await access(candidatePath, fsConstants.F_OK);
        return true;
      } catch {
        // fall through
      }
    }
    return false;
  }
}

async function tryExec(commandName: string, args: string[]): Promise<ExecAttempt> {
  try {
    const { stdout, stderr } = await execFileAsync(commandName, args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      ok: false,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? '',
      code: typeof execError.code === 'number' ? execError.code : null
    };
  }
}

async function execAndCapture(commandName: string, args: string[]): Promise<string> {
  const result = await tryExec(commandName, args);
  if (!result.ok) {
    const renderedArgs = args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ');
    const reason = result.stderr || result.stdout || `exit code ${result.code ?? 'unknown'}`;
    throw new Error(`Command "${commandName} ${renderedArgs}" failed: ${reason}`);
  }
  return result.stdout;
}

interface Progress {
  start(text: string): void;
  succeed(text: string): void;
  fail(text: string): void;
  info(text: string): void;
}

function createProgress(): Progress {
  if (!process.stdout.isTTY) {
    return {
      start: (text) => console.log(text),
      succeed: () => {},
      fail: (text) => console.error(text),
      info: (text) => console.log(text)
    };
  }

  let spinner: Spinner | null = null;

  return {
    start: (text: string) => {
      spinner = createSpinner(text).start();
    },
    succeed: (text: string) => {
      spinner?.success({ text });
      spinner = null;
    },
    fail: (text: string) => {
      spinner?.error({ text });
      spinner = null;
    },
    info: (text: string) => {
      spinner?.clear();
      console.log(text);
    }
  };
}
