#!/usr/bin/env node
// Release one app on the project's servers: send box/shukka-release.sh with its arguments through
// SSM Run Command (AWS-RunShellScript) to every running instance tagged Project=<project>, wait,
// print what the script printed, and turn its exit code into a failure message.
//
// The configure hook runs as root on the server, so it is never taken from the bundle (the bundle
// is built by the project's own code and dependencies). It is read from the commit checked out at
// --checkout (git's HEAD, not the working tree, so nothing unpacked over the checkout can stand in
// for it) at the config's server.configure path, uploaded to
// s3://<bucket>/<project>/<app>/<sha>.configure.sh, and that key is passed as --configure-key.
//
// CLI:
//   node scripts/release.mjs --bucket <bucket> --sha <sha> --checkout <git-checkout>
//        (--config <shukka.json> --app <name>
//         | --project <p> --app <a> --region <r> --configure <path> --units "u1 u2" --health <url>)
//        [--keep 5] [--health-timeout 60] [--timeout <seconds>] [--script <path>]
//   exit 0: live on every instance; 10 to 13: the release script's code (see EXIT_MESSAGES);
//   1: any other failure; 2: usage error

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCommandInvocationCommand, SendCommandCommand, SSMClient } from '@aws-sdk/client-ssm';
import { loadConfig } from './config.mjs';
import { APP_RE, BUCKET_RE, parseFlags, PROJECT_RE, REGION_RE, SHA_RE } from './upload.mjs';

export const DEFAULT_SCRIPT = fileURLToPath(new URL('../box/shukka-release.sh', import.meta.url));
export const DOCUMENT = 'AWS-RunShellScript';

/** What each exit code of box/shukka-release.sh means (design: shukka-release.sh contract). */
export const EXIT_MESSAGES = Object.freeze({
  10: 'download or unpack failed; nothing changed on the server',
  11: 'the configure hook failed; nothing was switched and the new release was deleted',
  12: 'the new release was unhealthy and was rolled back; the previous release is live and healthy',
  13: 'the new release was unhealthy and the rollback is unhealthy too; the app needs manual attention',
});

const TERMINAL = new Set(['Success', 'Failed', 'Cancelled', 'TimedOut']);
const UNIT_RE = /^[A-Za-z0-9@._:-]+$/;
const HEALTH_RE = /^https?:\/\/[^\s/?#]+([/?#]\S*)?$/;
const CONFIGURE_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * @typedef {{ send(command: any): Promise<any> }} AwsLike
 * @typedef {{
 *   project: string, app: string, sha: string, bucket: string, region: string,
 *   units: string[], health: string, keep?: number, healthTimeout?: number,
 * }} ReleaseArgs
 * @typedef {ReleaseArgs & {
 *   checkout: string, configure: string,
 *   script?: string, s3?: AwsLike, ssm?: AwsLike, ec2?: AwsLike, pollMs?: number, timeoutSeconds?: number,
 *   out?: (text: string) => void,
 * }} ReleaseOptions
 * @typedef {{ instanceId: string, status: string, code: number, stdout: string, stderr: string, message: string | null }} InstanceResult
 * @typedef {{ ok: boolean, code: number, commandId: string, results: InstanceResult[] }} ReleaseResult
 */

/**
 * The failure message for an exit code of the release script (null for 0).
 * @param {number} code
 * @returns {string | null}
 */
export function failureMessage(code) {
  if (code === 0) return null;
  if (code === 10 || code === 11 || code === 12 || code === 13) return EXIT_MESSAGES[code];
  if (code === 2) return 'the release script refused its arguments; nothing changed';
  return `the release script exited with code ${code}`;
}

/**
 * Problems with the release arguments, checked before anything is sent.
 * @param {ReleaseArgs} args
 * @returns {string[]}
 */
export function checkArgs(args) {
  /** @type {string[]} */
  const problems = [];
  if (!PROJECT_RE.test(args.project)) problems.push(`project: "${args.project}" must match ${PROJECT_RE.source}`);
  if (!APP_RE.test(args.app)) problems.push(`app: "${args.app}" must match ${APP_RE.source}`);
  if (!SHA_RE.test(args.sha)) problems.push(`sha: "${args.sha}" must be 7 to 40 lowercase hex characters`);
  if (!BUCKET_RE.test(args.bucket)) problems.push(`bucket: "${args.bucket}" is not a bucket name`);
  if (!REGION_RE.test(args.region)) problems.push(`region: "${args.region}" is not a region`);
  if (args.units.length === 0) problems.push('units: at least one unit is needed');
  for (const unit of args.units) if (!UNIT_RE.test(unit)) problems.push(`units: "${unit}" is not a unit name`);
  if (!HEALTH_RE.test(args.health)) problems.push(`health: "${args.health}" is not an http(s) URL`);
  // Run Command resolves {{ssm:...}} in its parameters with the caller's role: a value carrying
  // one would put a parameter (possibly a secret) on the server's command line.
  for (const [name, value] of [['health', args.health], ['units', args.units.join(' ')]]) {
    if (/[{}]/.test(/** @type {string} */ (value))) problems.push(`${name}: must not contain { or }`);
  }
  if (args.keep !== undefined && !(Number.isInteger(args.keep) && args.keep >= 1 && args.keep <= 99)) {
    problems.push('keep: must be 1 to 99');
  }
  if (args.healthTimeout !== undefined && !(Number.isInteger(args.healthTimeout) && args.healthTimeout >= 1 && args.healthTimeout <= 9999)) {
    problems.push('health-timeout: must be 1 to 9999 seconds');
  }
  return problems;
}

/**
 * S3 key of an app's configure hook for one commit, beside its bundle.
 * @param {string} project
 * @param {string} app
 * @param {string} sha
 * @returns {string}
 */
export function hookKey(project, app, sha) {
  return `${project}/${app}/${sha}.configure.sh`;
}

/**
 * @param {string} checkout
 * @param {string[]} args
 * @returns {Buffer}
 */
function git(checkout, args) {
  const result = spawnSync('git', ['-C', checkout, ...args]);
  if (result.error) throw new Error(`git: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed in ${checkout}: ${result.stderr.toString().trim().split('\n')[0] ?? ''}`);
  }
  return result.stdout;
}

/**
 * Read the configure hook from the commit checked out at `checkout` (its HEAD), not from the
 * working tree, so nothing written into the checkout after it (a downloaded artifact, a build) can
 * stand in for it. The path must name a regular file in that commit, and the commit must be the one
 * being released (HEAD equals `sha`, or starts with it when `sha` is abbreviated).
 * @param {string} checkout root of a git checkout
 * @param {string} configure path relative to the repository root (shukka.json server.configure)
 * @param {string} sha the commit being released
 * @returns {Buffer}
 */
export function readHook(checkout, configure, sha) {
  if (!CONFIGURE_RE.test(configure) || isAbsolute(configure) || configure.split('/').some((s) => s === '..' || s === '.' || s === '')) {
    throw new Error(`configure: "${configure}" must be a relative path inside the repository`);
  }
  const prefix = git(checkout, ['rev-parse', '--show-prefix']).toString().trim();
  if (prefix !== '') throw new Error(`checkout: ${checkout} is not the root of its git repository`);
  const head = git(checkout, ['rev-parse', 'HEAD']).toString().trim();
  if (!SHA_RE.test(sha) || !head.startsWith(sha)) {
    throw new Error(`checkout: ${checkout} is at ${head}, not at the commit being released (${sha})`);
  }
  const listing = git(checkout, ['ls-tree', '-z', 'HEAD', '--', configure]).toString();
  const match = /^(\d+) (\w+) ([0-9a-f]+)\t([^\0]*)\0$/.exec(listing);
  if (!match || match[4] !== configure) {
    throw new Error(`configure: ${configure} is not committed in the checkout at ${checkout}`);
  }
  if (match[2] !== 'blob' || (match[1] !== '100644' && match[1] !== '100755')) {
    throw new Error(`configure: ${configure} is not a regular file in git`);
  }
  return git(checkout, ['cat-file', 'blob', /** @type {string} */ (match[3])]);
}

/**
 * The arguments for box/shukka-release.sh, in the contract's order.
 * @param {ReleaseArgs} args
 * @returns {string[]}
 */
export function scriptArgs(args) {
  return [
    '--project', args.project,
    '--app', args.app,
    '--sha', args.sha,
    '--bucket', args.bucket,
    '--region', args.region,
    '--configure-key', hookKey(args.project, args.app, args.sha),
    '--units', args.units.join(' '),
    '--health', args.health,
    ...(args.keep !== undefined ? ['--keep', String(args.keep)] : []),
    ...(args.healthTimeout !== undefined ? ['--health-timeout', String(args.healthTimeout)] : []),
  ];
}

/**
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The AWS-RunShellScript command lines: write the script (base64, so its text cannot break out),
 * run it with bash and its arguments, and exit with its code.
 * @param {string} script text of box/shukka-release.sh
 * @param {string[]} args
 * @returns {string[]}
 */
export function buildCommands(script, args) {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return [
    'f=$(mktemp /tmp/shukka-release.XXXXXX) || exit 1',
    `printf '%s' '${encoded}' | base64 -d > "$f" || { rm -f "$f"; exit 1; }`,
    `bash "$f" ${args.map(shellQuote).join(' ')}`,
    'rc=$?',
    'rm -f "$f"',
    'exit $rc',
  ];
}

/**
 * Ids of the running instances tagged Project=<project>.
 * @param {AwsLike} ec2
 * @param {string} project
 * @returns {Promise<string[]>}
 */
export async function findInstances(ec2, project) {
  /** @type {string[]} */
  const ids = [];
  /** @type {string | undefined} */
  let token;
  do {
    const page = await ec2.send(new DescribeInstancesCommand({
      Filters: [
        { Name: 'tag:Project', Values: [project] },
        { Name: 'instance-state-name', Values: ['running'] },
      ],
      ...(token ? { NextToken: token } : {}),
    }));
    for (const reservation of page.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        if (instance.InstanceId) ids.push(instance.InstanceId);
      }
    }
    token = page.NextToken;
  } while (token);
  return ids;
}

/**
 * Poll one invocation until it ends or the deadline passes.
 * @param {AwsLike} ssm
 * @param {string} commandId
 * @param {string} instanceId
 * @param {number} pollMs
 * @param {number} deadline epoch ms
 * @returns {Promise<{ status: string, code: number, stdout: string, stderr: string }>}
 */
async function waitFor(ssm, commandId, instanceId, pollMs, deadline) {
  for (;;) {
    try {
      const inv = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }));
      const status = String(inv.Status ?? '');
      if (TERMINAL.has(status)) {
        return {
          status,
          code: typeof inv.ResponseCode === 'number' ? inv.ResponseCode : -1,
          stdout: String(inv.StandardOutputContent ?? ''),
          stderr: String(inv.StandardErrorContent ?? ''),
        };
      }
    } catch (error) {
      // Right after SendCommand the invocation may not exist yet.
      if (/** @type {{ name?: string }} */ (error).name !== 'InvocationDoesNotExist') throw error;
    }
    if (Date.now() >= deadline) return { status: 'TimedOut', code: -1, stdout: '', stderr: '' };
    await sleep(pollMs);
  }
}

/**
 * The release script's result line, if the output still ends with it (SSM truncates long output).
 * @param {string} text
 * @returns {string}
 */
export function resultLine(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  return /^shukka: /.test(last) ? last : 'output truncated';
}

/**
 * Send the release, wait for every instance, print the output and the outcome.
 * @param {ReleaseOptions} options
 * @returns {Promise<ReleaseResult>}
 */
export async function release(options) {
  const problems = checkArgs(options);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const out = options.out ?? ((text) => process.stdout.write(text));
  const clientConfig = { region: options.region };
  const ec2 = options.ec2 ?? new EC2Client(clientConfig);
  const ssm = options.ssm ?? new SSMClient(clientConfig);
  const s3 = options.s3 ?? new S3Client(clientConfig);
  const timeoutSeconds = options.timeoutSeconds ?? 900;
  const pollMs = options.pollMs ?? 3000;

  const script = readFileSync(options.script ?? DEFAULT_SCRIPT, 'utf8');
  const hook = readHook(options.checkout, options.configure, options.sha);
  const instanceIds = await findInstances(ec2, options.project);
  if (instanceIds.length === 0) throw new Error(`no running instance is tagged Project=${options.project}`);

  const key = hookKey(options.project, options.app, options.sha);
  await s3.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: hook, ContentType: 'text/x-shellscript' }));
  out(`shukka: configure hook ${options.configure} from git uploaded to s3://${options.bucket}/${key}\n`);

  const sent = await ssm.send(new SendCommandCommand({
    DocumentName: DOCUMENT,
    InstanceIds: instanceIds,
    Comment: `shukka release ${options.project}/${options.app} ${options.sha}`.slice(0, 100),
    Parameters: {
      commands: buildCommands(script, scriptArgs(options)),
      executionTimeout: [String(timeoutSeconds)],
    },
  }));
  const commandId = sent.Command?.CommandId;
  if (!commandId) throw new Error('SSM did not return a command id');
  out(`shukka: sent release of ${options.project}/${options.app} ${options.sha} to ${instanceIds.join(', ')} (command ${commandId})\n`);

  // A little longer than the execution timeout, so the agent reports its own timeout first.
  const deadline = Date.now() + (timeoutSeconds + 60) * 1000;
  /** @type {InstanceResult[]} */
  const results = [];
  for (const instanceId of instanceIds) {
    const r = await waitFor(ssm, commandId, instanceId, pollMs, deadline);
    out(`----- ${instanceId}: ${r.status}, exit ${r.code}\n`);
    if (r.stdout) out(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
    if (r.stderr) out(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
    /** @type {string | null} */
    let message = null;
    if (r.status !== 'Success' || r.code !== 0) {
      if (r.status === 'TimedOut' && r.code < 0) message = `the release did not finish within ${timeoutSeconds} seconds`;
      else if (r.status === 'Cancelled') message = 'the release command was cancelled';
      else message = failureMessage(r.code < 0 ? 1 : r.code);
    }
    results.push({ instanceId, ...r, message });
  }

  const failed = results.filter((r) => r.message !== null);
  for (const r of failed) {
    out(`shukka: release failed on ${r.instanceId}: ${r.message} (${resultLine(r.stdout)})\n`);
  }
  const first = failed[0];
  const code = !first ? 0 : (first.code >= 10 && first.code <= 13 ? first.code : 1);
  return { ok: failed.length === 0, code, commandId, results };
}

const USAGE = 'usage: node scripts/release.mjs --bucket <bucket> --sha <sha> --checkout <git-checkout> '
  + '(--config <shukka.json> --app <name> | --project <p> --app <a> --region <r> --configure <path> --units "u1 u2" --health <url>) '
  + '[--keep 5] [--health-timeout 60] [--timeout <seconds>] [--script <path>]';

const FLAGS = ['bucket', 'sha', 'checkout', 'config', 'app', 'project', 'region', 'configure', 'units', 'health', 'keep', 'health-timeout', 'timeout', 'script'];

/**
 * @param {string | undefined} value
 * @returns {number | undefined}
 */
function int(value) {
  if (value === undefined) return undefined;
  return /^[0-9]+$/.test(value) ? Number(value) : NaN;
}

/**
 * @param {string[]} argv
 * @param {{ s3?: AwsLike, ssm?: AwsLike, ec2?: AwsLike, pollMs?: number, out?: (text: string) => void }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const parsed = parseFlags(argv, FLAGS);
  if ('error' in parsed) {
    process.stderr.write(`release: ${parsed.error}\n${USAGE}\n`);
    return 2;
  }
  const v = parsed.values;
  let { project, region, configure, units, health } = v;
  if (v.config !== undefined) {
    if (project !== undefined || configure !== undefined || units !== undefined || health !== undefined) {
      process.stderr.write(`release: --config replaces --project, --configure, --units and --health\n${USAGE}\n`);
      return 2;
    }
    const { config, problems } = loadConfig(v.config);
    if (!config) {
      for (const problem of problems) process.stderr.write(`${problem}\n`);
      return 1;
    }
    const app = config.apps.find((a) => a.name === v.app);
    if (!app) {
      process.stderr.write(`release: no app "${v.app ?? ''}" in ${v.config}\n`);
      return 1;
    }
    project = config.project;
    region = region ?? config.aws.region;
    configure = app.server.configure;
    units = app.server.units.join(' ');
    health = app.server.health;
  }
  const missing = ['bucket', 'sha', 'checkout', 'app'].filter((name) => v[name] === undefined);
  if (project === undefined) missing.push('project');
  if (region === undefined) missing.push('region');
  if (configure === undefined) missing.push('configure');
  if (units === undefined) missing.push('units');
  if (health === undefined) missing.push('health');
  if (missing.length > 0) {
    process.stderr.write(`release: missing ${missing.map((m) => `--${m}`).join(', ')}\n${USAGE}\n`);
    return 2;
  }
  const keep = int(v.keep);
  const healthTimeout = int(v['health-timeout']);
  const timeoutSeconds = int(v.timeout);
  if (timeoutSeconds !== undefined && !(timeoutSeconds >= 30 && timeoutSeconds <= 172800)) {
    process.stderr.write('release: --timeout must be 30 to 172800 seconds\n');
    return 2;
  }
  try {
    const result = await release({
      project: /** @type {string} */ (project),
      app: /** @type {string} */ (v.app),
      sha: /** @type {string} */ (v.sha),
      bucket: /** @type {string} */ (v.bucket),
      region: /** @type {string} */ (region),
      checkout: /** @type {string} */ (v.checkout),
      configure: /** @type {string} */ (configure),
      units: /** @type {string} */ (units).split(/\s+/).filter(Boolean),
      health: /** @type {string} */ (health),
      ...(keep !== undefined ? { keep } : {}),
      ...(healthTimeout !== undefined ? { healthTimeout } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      ...(v.script !== undefined ? { script: v.script } : {}),
      ...(deps.s3 ? { s3: deps.s3 } : {}),
      ...(deps.ssm ? { ssm: deps.ssm } : {}),
      ...(deps.ec2 ? { ec2: deps.ec2 } : {}),
      ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
      ...(deps.out ? { out: deps.out } : {}),
    });
    return result.code;
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n`);
    return 1;
  }
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
