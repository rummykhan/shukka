// The shukka CLI (design C7): `bootstrap --account`, `bootstrap <project>`, `diff`, `deploy`.
// Run with `npx github:rummykhan/shukka#v1 <command>`; bin/shukka loads this file.
//
// Exit codes: 0 done; 1 refused or failed (one `shukka: ...` line says why); 2 usage error;
// 10 to 13 a release failed with the release script's code (scripts/release.mjs).

import { realAws } from './aws.mjs';
import { CliError, HOST_CODE_WARNING, PROJECT_IMAGE, cleanTemps, createIo } from './exec.mjs';

/**
 * @typedef {{ name: string, value?: string, repeat?: boolean, help: string }} FlagSpec
 * @typedef {{ name: string, usage: string, summary: string, flags: FlagSpec[] }} CommandSpec
 */

const PROFILE = { name: 'profile', value: '<name>', help: 'AWS profile to use (default: the AWS SDK default chain)' };
const REGION = { name: 'region', value: '<region>', help: 'AWS region (default: aws.region in shukka.json; must match it)' };
const CONFIG = { name: 'config', value: '<path>', help: 'path of shukka.json (default: shukka.json)' };
const DRY_RUN = { name: 'dry-run', help: 'print every command that would change something, change nothing (lookups still run)' };
const TRUST = { name: 'trust-project-code', help: "without Docker, run the project's own code on this machine as you (warns; it can read your home directory)" };

/** How diff and deploy run the project's own code: the same text in both commands' help. */
const PROJECT_CODE_HELP = [
  "Project code: npm ci, cdk synth, the checks, build, bundle and smoke run in throwaway Docker containers",
  `(docker run --rm) of ${PROJECT_IMAGE}`,
  '(Node 22, Debian bookworm, pinned by digest). Only the fresh worktree is mounted, read-write, at its own path;',
  'the container runs as your user and group, so files written back are yours; it has no home directory of yours',
  '(HOME=/tmp inside), no capabilities, and none of your environment: only CI=true, CDK_DEFAULT_ACCOUNT,',
  "CDK_DEFAULT_REGION and the app's build env and buildEnv values (names starting AWS_, GH_ or GITHUB_, and HOME,",
  'are refused). The network is allowed (npm needs it). git metadata is not in the container (the worktree\'s .git',
  'points outside it). cdk diff and cdk deploy then run on this machine, as below, on the assembly the container wrote.',
  'Without Docker, diff and deploy refuse unless --trust-project-code is given, and then print this warning:',
  `  ${HOST_CODE_WARNING}.`,
];

/** @type {CommandSpec[]} */
export const COMMANDS = [
  {
    name: 'bootstrap',
    usage: 'shukka bootstrap --account [--oidc-provider-arn <arn>] [--projects <a,b>] [--profile <name>] --region <region> [--dry-run]\n'
      + 'shukka bootstrap <project> [--config <path>] [--hosted-zone-id <id>] [--mail-domain <domain>]... [--repo <owner/name>]\n'
      + '    [--emergency-principal <arn>]... [--allow-private-types] [--profile <name>] [--region <region>] [--dry-run]',
    summary: [
      'Once per AWS account, with admin credentials: --account deploys the Shukka-Account stack (cdk deploy), which owns',
      "the account's GitHub OIDC provider, or imports an existing one with --oidc-provider-arn, and lists the account's",
      'projects (kept from the deployed stack unless --projects is given).',
      '',
      'Once per project, with admin credentials, reading shukka.json from --config: refuses a project name that prefixes',
      "another project in the account (or is prefixed by one), a qualifier already bootstrapped by anything but shukka for",
      'this project (or CDK\'s default hnb659fds), private CloudFormation extensions, roles named like the project without',
      "its boundary, and any DynamoDB table, S3 bucket, SQS queue, SNS topic, Lambda function, log group or IAM role named",
      '<project>* or <Project>* (the fence) that is in no stack tagged Project=<project> or shukka:project=<project>:',
      "the fence would hand it to this project's pipeline (S3 and IAM are listed account-wide, the rest in the region).",
      'Then deploys Shukka-Boundary-<project> (the boundary and the three execution policies,',
      "cdk deploy), the project's own bootstrap as stack CDKToolkit-<qualifier> (aws cloudformation deploy; its",
      'execution role carries the three execution policies, its roles trust the infra role and the emergency',
      'principals), copies each buildEnv value from Parameter Store /<project>/prod/<NAME> to a GitHub repository',
      "variable (gh variable set), and adds the project to Shukka-Account's list when that stack exists.",
    ].join('\n'),
    flags: [
      { name: 'account', help: 'bootstrap the account (Shukka-Account) instead of a project' },
      { name: 'oidc-provider-arn', value: '<arn>', help: "--account: import this existing GitHub OIDC provider instead of creating one" },
      { name: 'projects', value: '<a,b>', help: "--account: set the account's project list (default: keep the deployed list)" },
      CONFIG,
      { name: 'hosted-zone-id', value: '<id>', repeat: true, help: 'Route 53 hosted zone the project may change (default: fence.hostedZoneIds in shukka.json; exactly one)' },
      { name: 'mail-domain', value: '<domain>', repeat: true, help: 'SES domain the project may send from (default: fence.mailDomains in shukka.json)' },
      { name: 'repo', value: '<owner/name>', help: "GitHub repository for buildEnv variables (default: origin's)" },
      { name: 'emergency-principal', value: '<arn>', repeat: true, help: 'role or user ARN (pattern) that may deploy from a laptop (default: whoever runs this)' },
      { name: 'allow-private-types', help: 'go ahead although the account has private CloudFormation extensions (each is listed with its execution role)' },
      PROFILE,
      REGION,
      DRY_RUN,
    ],
  },
  {
    name: 'diff',
    usage: 'shukka diff [--config <path>] [--trust-project-code] [--profile <name>] [--region <region>]',
    summary: [
      'Refuses unless the working tree is clean and HEAD equals origin/main. Synthesizes the CDK app from a fresh',
      'worktree of origin/main (npm ci, cdk synth in infra.dir, as project code: below), prints cdk diff run as the',
      'project\'s bootstrap deploy role (as for deploy, below) and the guard\'s verdict (scripts/guard.mjs). Exit 0 when',
      'nothing would be deleted or replaced, 1 when something would be or the diff is incomplete.',
      '',
      ...PROJECT_CODE_HELP,
    ].join('\n'),
    flags: [CONFIG, TRUST, PROFILE, REGION],
  },
  {
    name: 'deploy',
    usage: 'shukka deploy [--config <path>] [--profile <name>] [--region <region>] [--bucket <name>] [--allow-replacement] [--skip-checks]\n'
      + '    [--trust-project-code] [--dry-run]',
    summary: [
      'The emergency path when GitHub is down. Refuses unless the working tree is clean and HEAD equals origin/main,',
      'then does what the workflows do, in their order (credentials below): the checks, build and bundle every',
      'app (buildEnv values from the environment, else from Parameter Store /<project>/prod/<NAME>), cdk synth,',
      'cdk diff and the guard, cdk deploy with the shukka:revision tag, then for each app upload the bundle',
      '(scripts/upload.mjs) and release it on the servers (scripts/release.mjs), and the smoke test. Every part',
      'deploys, whatever changed. It builds from a fresh worktree of origin/main and reads shukka.json from there.',
      '',
      ...PROJECT_CODE_HELP,
      '',
      "Credentials: cdk diff and cdk deploy run with shukka's pinned cdk and only a session of the project's bootstrap",
      'deploy role (cdk-<qualifier>-deploy-role-<account>-<region>), which your principal must be allowed to assume (an',
      "emergency principal named at bootstrap). Upload and release are shukka's own code and use your credentials.",
      'With --trust-project-code the project\'s code runs with every AWS_* variable removed, the AWS config and',
      'credentials files pointed at empty files and instance metadata off, but code that reads ~/.aws by path is not',
      'stopped: there, run the emergency deploy as a non-admin emergency principal rather than an admin.',
    ].join('\n'),
    flags: [
      CONFIG,
      { name: 'bucket', value: '<name>', help: 'bucket for app bundles (default: <project>-deploy-<account>, as in the workflows)' },
      { name: 'allow-replacement', help: 'deploy even when resources would be deleted or replaced (the guard\'s --allow)' },
      { name: 'skip-checks', help: "skip the project's checks (warns)" },
      TRUST,
      PROFILE,
      REGION,
      DRY_RUN,
    ],
  },
];

/**
 * The --help text: every command, its usage and every flag.
 * @returns {string}
 */
export function helpText() {
  const lines = [
    'shukka: deploy AWS CDK projects from GitHub Actions; this CLI bootstraps accounts and projects and deploys when GitHub is down.',
    '',
    'usage: npx github:rummykhan/shukka#v1 <command> [options]',
    '',
    'commands:',
    '  bootstrap --account   deploy the account stack (GitHub OIDC provider, project list)',
    "  bootstrap <project>   deploy the project's fence and its own CDK bootstrap; copy buildEnv to GitHub",
    '  diff                  cdk diff of origin/main with the guard\'s verdict',
    '  deploy                emergency deploy of origin/main from this machine',
    '  help                  this text (also --help, and <command> --help)',
    '',
  ];
  for (const c of COMMANDS) {
    lines.push(`${c.name}`, '', `  ${c.usage.replaceAll('\n', '\n  ')}`, '', ...c.summary.split('\n').map((l) => (l ? `  ${l}` : '')), '');
    for (const f of c.flags) {
      const left = `--${f.name}${f.value ? ` ${f.value}` : ''}${f.repeat ? ' (repeatable)' : ''}`;
      lines.push(`    ${left.padEnd(40)} ${f.help}`);
    }
    lines.push('');
  }
  lines.push(
    'exit codes: 0 done; 1 refused or failed; 2 usage error; 10-13 a release failed (see scripts/release.mjs)',
    '',
  );
  return lines.join('\n');
}

/**
 * Parse a command's flags: `--name value`, `--name=value`, booleans, repeatable flags; one positional at most.
 * @param {CommandSpec} spec
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string | string[] | true>, positional: string[] }}
 */
export function parseCommand(spec, argv) {
  /** @type {Record<string, string | string[] | true>} */
  const flags = {};
  /** @type {string[]} */
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = /** @type {string} */ (argv[i]);
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const f = spec.flags.find((x) => x.name === name);
    if (!f) throw new CliError(`${spec.name}: unknown option --${name}`, 2);
    if (!f.value) {
      if (eq !== -1) throw new CliError(`${spec.name}: --${name} takes no value`, 2);
      flags[name] = true;
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) throw new CliError(`${spec.name}: --${name} needs a value`, 2);
    if (f.repeat) {
      const list = flags[name];
      flags[name] = [...(Array.isArray(list) ? list : []), value];
    } else {
      if (Object.hasOwn(flags, name)) throw new CliError(`${spec.name}: --${name} given twice`, 2);
      flags[name] = value;
    }
  }
  return { flags, positional };
}

/**
 * @param {Record<string, string | string[] | true>} flags
 * @param {string} name
 * @returns {string | undefined}
 */
function str(flags, name) {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

/**
 * @param {Record<string, string | string[] | true>} flags
 * @param {string} name
 * @returns {string[] | undefined}
 */
function list(flags, name) {
  const v = flags[name];
  return Array.isArray(v) ? v : undefined;
}

/**
 * @typedef {{
 *   out?: (text: string) => void,
 *   err?: (text: string) => void,
 *   spawn?: import('./exec.mjs').Spawn,
 *   aws?: (target: { profile?: string, region: string }, io: import('./exec.mjs').Io) => import('./aws.mjs').Aws,
 *   cwd?: string,
 *   env?: Record<string, string | undefined>,
 *   checkAssembly?: (dir: string) => string[],
 *   keepTemp?: boolean,
 * }} Deps
 */

/**
 * @param {string[]} argv
 * @param {Deps} [deps]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const out = deps.out ?? ((text) => process.stdout.write(text));
  const err = deps.err ?? ((text) => process.stderr.write(text));
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    out(helpText());
    return command === undefined ? 2 : 0;
  }
  const spec = COMMANDS.find((c) => c.name === command);
  if (!spec) {
    err(`shukka: unknown command ${JSON.stringify(command)}\n${helpText()}`);
    return 2;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    out(helpText());
    return 0;
  }
  try {
    const { flags, positional } = parseCommand(spec, rest);
    const io = createIo({ dryRun: flags['dry-run'] === true, out, err, ...(deps.spawn ? { spawn: deps.spawn } : {}) });
    const profile = str(flags, 'profile');
    const region = str(flags, 'region');
    /** @param {string} r */
    const makeAws = (r) => (deps.aws ?? ((t, i) => realAws({ ...t, io: i })))({ ...(profile ? { profile } : {}), region: r }, io);
    const configPath = str(flags, 'config') ?? 'shukka.json';

    if (spec.name === 'bootstrap') {
      const { bootstrapAccount, bootstrapProject } = await import('./bootstrap.mjs');
      if (flags.account === true) {
        if (positional.length > 0) throw new CliError('bootstrap: give --account or a project name, not both', 2);
        const projectOnly = ['config', 'hosted-zone-id', 'mail-domain', 'repo', 'emergency-principal', 'allow-private-types'].filter((f) => f in flags);
        if (projectOnly.length > 0) throw new CliError(`bootstrap --account: --${projectOnly[0]} is for a project bootstrap`, 2);
        const r = region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
        if (!r) throw new CliError('bootstrap --account: give --region', 2);
        const projects = str(flags, 'projects');
        await bootstrapAccount({
          io, aws: makeAws(r), target: { ...(profile ? { profile } : {}), region: r },
          ...(str(flags, 'oidc-provider-arn') ? { oidcProviderArn: str(flags, 'oidc-provider-arn') } : {}),
          ...(projects !== undefined ? { projects: projects.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        });
        return 0;
      }
      if (positional.length !== 1) throw new CliError('bootstrap: give --account or one project name', 2);
      const accountOnly = ['oidc-provider-arn', 'projects'].filter((f) => f in flags);
      if (accountOnly.length > 0) throw new CliError(`bootstrap <project>: --${accountOnly[0]} is for bootstrap --account`, 2);
      const { loadConfig } = await import('../config.mjs');
      const { resolve } = await import('node:path');
      const fullConfig = resolve(cwd, configPath);
      const { refuseSymlink } = await import('./exec.mjs');
      refuseSymlink(cwd, fullConfig);
      const { config, problems } = loadConfig(fullConfig);
      if (!config) throw new CliError(problems.join('\n'));
      const r = region ?? config.aws.region;
      await bootstrapProject({
        io, aws: makeAws(r), target: { ...(profile ? { profile } : {}), ...(region ? { region } : {}) },
        project: /** @type {string} */ (positional[0]), configPath: fullConfig, cwd,
        ...(list(flags, 'hosted-zone-id') ? { hostedZoneIds: list(flags, 'hosted-zone-id') } : {}),
        ...(list(flags, 'mail-domain') ? { mailDomains: list(flags, 'mail-domain') } : {}),
        ...(str(flags, 'repo') ? { repo: str(flags, 'repo') } : {}),
        ...(list(flags, 'emergency-principal') ? { emergencyPrincipals: list(flags, 'emergency-principal') } : {}),
        allowPrivateTypes: flags['allow-private-types'] === true,
      });
      return 0;
    }

    if (positional.length > 0) throw new CliError(`${spec.name}: unexpected argument ${JSON.stringify(positional[0])}`, 2);
    // shukka.json is read from the fresh worktree of origin/main, not from this working tree.
    const target = { ...(profile ? { profile } : {}), ...(region ? { region } : {}) };
    const { deployCommand, diffCommand } = await import('./deploy.mjs');
    const checkAssembly = deps.checkAssembly ? { checkAssembly: deps.checkAssembly } : {};
    const trustProjectCode = flags['trust-project-code'] === true;
    if (spec.name === 'diff') return await diffCommand({ io, makeAws, target, configPath, cwd, trustProjectCode, ...checkAssembly });
    return await deployCommand({
      io, makeAws, target, configPath, cwd, env, trustProjectCode, ...checkAssembly,
      ...(str(flags, 'bucket') ? { bucket: str(flags, 'bucket') } : {}),
      allowReplacement: flags['allow-replacement'] === true,
      skipChecks: flags['skip-checks'] === true,
    });
  } catch (error) {
    if (error instanceof CliError) {
      for (const line of error.message.split('\n')) err(`shukka: ${line}\n`);
      if (error.code === 2) err(`run shukka ${spec.name} --help for usage\n`);
      return error.code;
    }
    err(`shukka: ${/** @type {Error} */ (error).message}\n`);
    return 1;
  } finally {
    if (!deps.keepTemp) cleanTemps();
  }
}
