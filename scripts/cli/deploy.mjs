// `shukka diff` and `shukka deploy`: the emergency path from a laptop (design C7, D11, Key flows "GitHub down").
//
// Both refuse unless the working tree is clean and HEAD is origin/main, so what is deployed is exactly what CI
// would deploy. `deploy` then takes the steps the workflows take, in the same order, with the caller's profile
// (which the roles' trust policies would refuse, so no role is assumed by shukka; cdk assumes the project's
// bootstrap roles, which trust the emergency principals named at bootstrap):
//   checks (pipeline.yml "check", skippable with --skip-checks) -> build and bundle (pipeline.yml "build") ->
//   synth, cdk diff, guard, cdk deploy with the shukka:revision tag (infra.yml "deploy") ->
//   upload and release each app (ec2.yml "release": scripts/upload.mjs, scripts/release.mjs) -> smoke.
// Every part deploys, whatever changed: an emergency deploy makes AWS match origin/main. The release script
// redeploys a commit that is already live without harm, and an unchanged stack is a no-op for cdk.

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { guard, report } from '../guard.mjs';
import { release } from '../release.mjs';
import { upload } from '../upload.mjs';
import { CliError, mustRun } from './exec.mjs';

const SHUKKA_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const REVISION_TAG = 'shukka:revision';

/**
 * @typedef {import('./exec.mjs').Io} Io
 * @typedef {import('./aws.mjs').Aws} Aws
 * @typedef {import('../config.mjs').Config} Config
 * @typedef {{ profile?: string, region?: string }} Target
 */

/**
 * @param {Io} io
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function gitRead(io, cwd, args) {
  const r = io.run('git', args, { cwd, mutates: false, capture: 'stdout' });
  if (r.status !== 0) throw new CliError(`git ${args[0]} failed in ${cwd}`);
  return r.stdout.trim();
}

/**
 * Refuse unless the working tree is clean and HEAD equals origin/main. Fetches origin's main first; when that fails
 * (GitHub down) it compares with the last fetched origin/main and says so.
 * @param {Io} io
 * @param {string} cwd
 * @returns {{ root: string, sha: string }}
 */
export function checkCheckout(io, cwd) {
  const root = gitRead(io, cwd, ['rev-parse', '--show-toplevel']);
  const dirty = gitRead(io, root, ['status', '--porcelain', '--untracked-files=normal']);
  if (dirty !== '') {
    const lines = dirty.split('\n');
    throw new CliError(`refusing: the working tree is not clean (${lines.length} change(s): ${lines.slice(0, 5).map((l) => l.trim()).join('; ')}${lines.length > 5 ? '; ...' : ''}). Commit or stash, and deploy only what is on origin/main`);
  }
  const fetched = io.run('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: root, mutates: false, capture: 'merged' });
  if (fetched.status !== 0) io.warn('could not fetch origin main; comparing with the last fetched origin/main');
  const head = gitRead(io, root, ['rev-parse', 'HEAD']);
  const r = io.run('git', ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { cwd: root, mutates: false, capture: 'stdout' });
  const main = r.stdout.trim();
  if (r.status !== 0 || main === '') throw new CliError('refusing: there is no origin/main to compare HEAD with');
  if (head !== main) throw new CliError(`refusing: HEAD (${head.slice(0, 12)}) is not origin/main (${main.slice(0, 12)}); check out origin/main`);
  return { root, sha: head };
}

/**
 * @param {string} configPath
 * @returns {Config}
 */
function readConfig(configPath) {
  const { config, problems } = loadConfig(configPath);
  if (!config) throw new CliError(problems.join('\n'));
  return config;
}

/**
 * @param {Target} target
 * @returns {string[]}
 */
function profileArgs(target) {
  return target.profile ? ['--profile', target.profile] : [];
}

/**
 * Environment for cdk: the config's account and region (as infra.yml sets them), and the profile.
 * @param {Config} config
 * @param {Target} target
 * @returns {Record<string, string>}
 */
function cdkEnv(config, target) {
  return {
    CDK_DEFAULT_ACCOUNT: config.aws.account,
    CDK_DEFAULT_REGION: config.aws.region,
    AWS_REGION: config.aws.region,
    AWS_DEFAULT_REGION: config.aws.region,
    ...(target.profile ? { AWS_PROFILE: target.profile } : {}),
  };
}

/**
 * npm ci and cdk synth in the infra directory; returns the assembly directory.
 * @param {Io} io
 * @param {string} root
 * @param {Config} config
 * @param {Target} target
 * @returns {string}
 */
function synth(io, root, config, target) {
  const infra = join(root, config.infra.dir);
  const assembly = join(mkdtempSync(join(tmpdir(), 'shukka-cdk-')), 'cdk.out');
  const env = cdkEnv(config, target);
  mustRun(io, 'npm ci in the infra directory', 'npm', ['ci'], { cwd: infra, env });
  mustRun(io, 'cdk synth', 'npx', ['--no-install', 'cdk', 'synth', '--quiet', '--output', assembly], { cwd: infra, env });
  return assembly;
}

/**
 * cdk diff of the assembly, then the guard. Returns the guard's result; prints the diff and the verdict.
 * @param {Io} io
 * @param {string} root
 * @param {Config} config
 * @param {Target} target
 * @param {string} assembly
 * @param {boolean} allow
 */
function diffAndGuard(io, root, config, target, assembly, allow) {
  const infra = join(root, config.infra.dir);
  // In a dry run nothing was synthesized, so there is nothing to diff: the step is printed, not run.
  const r = io.run('npx', ['--no-install', 'cdk', 'diff', '--app', assembly, '--no-color', ...profileArgs(target)], {
    cwd: infra, env: cdkEnv(config, target), capture: 'merged',
  });
  if (io.dryRun) {
    io.out(`+ node scripts/guard.mjs${allow ? ' --allow' : ''} < the diff   [dry run: not run]\n`);
    return { result: /** @type {import('../guard.mjs').GuardResult} */ ({ verdict: 'safe', code: 0, found: [] }), diffStatus: 0 };
  }
  io.out(r.stdout.endsWith('\n') || r.stdout === '' ? r.stdout : `${r.stdout}\n`);
  const result = guard(r.stdout, { allow });
  io.out(report(result));
  return { result, diffStatus: r.status };
}

/**
 * Stack deploys with the shukka:revision tag, as infra.yml does: one `--all` when every stack has the same tags,
 * otherwise each stack alone after its dependencies, so each keeps its own tags.
 * @param {Io} io
 * @param {string} root
 * @param {Config} config
 * @param {Target} target
 * @param {string} assembly
 * @param {string} sha
 */
function deployStacks(io, root, config, target, assembly, sha) {
  const infra = join(root, config.infra.dir);
  const manifestFile = join(assembly, 'manifest.json');
  /** @type {Record<string, any>} */
  const artifacts = existsSync(manifestFile) ? (JSON.parse(readFileSync(manifestFile, 'utf8')).artifacts ?? {}) : {};
  const stacks = Object.entries(artifacts).filter(([, a]) => a.type === 'aws:cloudformation:stack');
  const ids = new Set(stacks.map(([id]) => id));
  /** @param {any} a */
  const tagArgs = (a) => Object.entries({ ...(a.properties?.tags ?? {}), [REVISION_TAG]: sha }).flatMap(([k, v]) => ['--tags', `${k}=${v}`]);
  /** @param {string[]} args */
  const deploy = (args) => mustRun(io, 'cdk deploy', 'npx', [
    '--no-install', 'cdk', 'deploy', '--app', assembly, '--require-approval', 'never', '--no-color', ...args, ...profileArgs(target),
  ], { cwd: infra, env: cdkEnv(config, target) });
  const keys = new Set(stacks.map(([, a]) => JSON.stringify(Object.entries(a.properties?.tags ?? {}).sort())));
  if (io.dryRun && stacks.length === 0) {
    deploy(['--all', '--tags', `${REVISION_TAG}=${sha}`]);
  } else if (stacks.length === 0) {
    io.say('the app has no stacks');
  } else if (keys.size === 1) {
    deploy(['--all', ...tagArgs(/** @type {[string, any]} */ (stacks[0])[1])]);
  } else {
    /** @type {Set<string>} */
    const done = new Set();
    /**
     * @param {string} id
     * @param {Set<string>} seen
     */
    const visit = (id, seen = new Set()) => {
      if (done.has(id) || seen.has(id)) return;
      seen.add(id);
      const a = artifacts[id];
      for (const dep of a.dependencies ?? []) if (ids.has(dep)) visit(dep, seen);
      deploy(['--exclusively', a.displayName ?? id, ...tagArgs(a)]);
      done.add(id);
    };
    for (const [id] of stacks) visit(id);
  }
}

/**
 * Run each check's commands in its directory, as pipeline.yml's check job does.
 * @param {Io} io
 * @param {string} root
 * @param {Config} config
 */
function runChecks(io, root, config) {
  for (const check of config.checks) {
    if (check.services.length > 0) {
      io.warn(`check ${check.name} uses services (${check.services.join(', ')}) that CI starts; shukka deploy does not, start them yourself`);
    }
    check.run.forEach((command, i) => {
      io.say(`check ${check.name}, command ${i + 1} of ${check.run.length}`);
      mustRun(io, `check ${check.name} (command ${i + 1})`, 'bash', ['-eo', 'pipefail', '-c', command], { cwd: join(root, check.dir) });
    });
  }
}

/**
 * Build one app and run its bundle script, as pipeline.yml's build job does; returns the bundle directory.
 * buildEnv values come from the environment when set (CI reads them from repository variables, which a laptop
 * cannot), otherwise from Parameter Store /<project>/prod/<NAME>, where `shukka bootstrap` copied them from.
 * @param {Io} io
 * @param {Aws} aws
 * @param {string} root
 * @param {Config} config
 * @param {import('../config.mjs').App} app
 * @returns {Promise<string>}
 */
async function build(io, aws, root, config, app) {
  /** @type {Record<string, string>} */
  const env = { ...app.build.env };
  for (const name of app.build.buildEnv) {
    const fromEnv = process.env[name];
    if (fromEnv !== undefined) {
      env[name] = fromEnv;
      continue;
    }
    const path = `/${config.project}/prod/${name}`;
    const p = await aws.getParameter(path);
    if (!p) throw new CliError(`build ${app.name} needs ${name}: set it in the environment or in ${path}`);
    if (p.type === 'SecureString') throw new CliError(`build ${app.name}: ${path} is a SecureString; build-time values must not be secret`);
    env[name] = p.value;
  }
  const cwd = join(root, app.build.dir);
  app.build.run.forEach((command, i) => {
    io.say(`build ${app.name}, command ${i + 1} of ${app.build.run.length}`);
    mustRun(io, `build ${app.name} (command ${i + 1})`, 'bash', ['-eo', 'pipefail', '-c', command], { cwd, env });
  });
  let script = resolve(cwd, app.build.bundle);
  if (!existsSync(script) && app.build.bundle === 'scripts/bundle.sh') script = join(SHUKKA_DIR, 'scripts', 'bundle.sh');
  if (!io.dryRun && !existsSync(script)) throw new CliError(`build ${app.name}: no bundle script ${app.build.bundle} in ${app.build.dir}`);
  const r = mustRun(io, `build ${app.name}: the bundle script`, 'bash', [script], { cwd, env, capture: 'stdout' });
  if (io.dryRun) return `<directory printed by ${app.build.bundle}>`;
  const dir = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  if (!dir) throw new CliError(`build ${app.name}: the bundle script did not print a directory`);
  return resolve(cwd, dir);
}

/**
 * Fail unless the caller's credentials are for the config's account.
 * @param {Io} io
 * @param {Aws} aws
 * @param {Config} config
 */
async function checkAccount(io, aws, config) {
  const caller = await aws.callerArn();
  if (caller.account !== config.aws.account) {
    throw new CliError(`the credentials are for account ${caller.account}, but shukka.json names ${config.aws.account}`);
  }
  io.say(`${config.project} in account ${caller.account}, region ${config.aws.region}, as ${caller.arn}`);
}

/**
 * @param {Target} target
 * @param {Config} config
 */
function checkRegion(target, config) {
  if (target.region !== undefined && target.region !== config.aws.region) {
    throw new CliError(`--region ${target.region} is not the region in shukka.json (${config.aws.region})`);
  }
}

/**
 * `shukka diff`: synth, cdk diff and the guard's verdict. Exit 0 when nothing is deleted or replaced.
 * @param {{ io: Io, aws: Aws, target: Target, configPath: string, cwd: string }} options
 * @returns {Promise<number>}
 */
export async function diffCommand({ io, aws, target, configPath, cwd }) {
  const { root } = checkCheckout(io, cwd);
  const config = readConfig(resolve(cwd, configPath));
  checkRegion(target, config);
  await checkAccount(io, aws, config);
  const assembly = synth(io, root, config, target);
  const { result, diffStatus } = diffAndGuard(io, root, config, target, assembly, false);
  if (diffStatus !== 0) throw new CliError(`cdk diff failed (exit ${diffStatus})`);
  return result.code;
}

/**
 * `shukka deploy`.
 * @param {{
 *   io: Io, aws: Aws, target: Target, configPath: string, cwd: string,
 *   bucket?: string, allowReplacement?: boolean, skipChecks?: boolean,
 * }} options
 * @returns {Promise<number>}
 */
export async function deployCommand(options) {
  const { io, aws, target, cwd } = options;
  const { root, sha } = checkCheckout(io, cwd);
  const config = readConfig(resolve(cwd, options.configPath));
  checkRegion(target, config);
  await checkAccount(io, aws, config);
  const bucket = options.bucket ?? `${config.project}-deploy-${config.aws.account}`;
  io.say(`deploying ${sha} (origin/main) to ${config.project}; bundles go to s3://${bucket}`);

  if (options.skipChecks) io.warn('--skip-checks: the project\'s checks are not run; you are deploying unchecked code');
  else runChecks(io, root, config);

  /** @type {Map<string, string>} */
  const bundles = new Map();
  for (const app of config.apps) bundles.set(app.name, await build(io, aws, root, config, app));

  const assembly = synth(io, root, config, target);
  const { result, diffStatus } = diffAndGuard(io, root, config, target, assembly, options.allowReplacement ?? false);
  if (result.code !== 0) {
    throw new CliError(result.verdict === 'incomplete'
      ? 'the guard stopped the deploy: the diff is incomplete'
      : 'the guard stopped the deploy: resources would be deleted or replaced; run again with --allow-replacement if that is intended');
  }
  if (diffStatus !== 0) throw new CliError(`cdk diff failed (exit ${diffStatus})`);
  deployStacks(io, root, config, target, assembly, sha);

  const clients = io.dryRun ? null : aws.clients();
  for (const app of config.apps) {
    const dir = /** @type {string} */ (bundles.get(app.name));
    if (!clients) {
      io.out(`+ upload ${dir} to s3://${bucket}/${config.project}/${app.name}/${sha}.tgz (scripts/upload.mjs)   [dry run: not run]\n`);
      io.out(`+ release ${config.project}/${app.name} ${sha} on instances tagged Project=${config.project} (scripts/release.mjs)   [dry run: not run]\n`);
      continue;
    }
    const uploaded = await upload({ dir, bucket, project: config.project, app: app.name, sha, region: config.aws.region, s3: clients.s3 });
    io.say(`uploaded ${uploaded.bytes} bytes to ${uploaded.url}`);
    const released = await release({
      project: config.project, app: app.name, sha, bucket, region: config.aws.region,
      checkout: root, configure: app.server.configure, units: app.server.units, health: app.server.health,
      s3: clients.s3, ssm: clients.ssm, ec2: clients.ec2, out: io.out,
    });
    if (!released.ok) throw new CliError(`release of ${app.name} failed`, released.code);
  }

  if (config.smoke) {
    const r = io.run('bash', ['-c', config.smoke.run], { cwd: root });
    if (r.status !== 0) throw new CliError(`the site is live but failing its smoke test (the smoke command exited ${r.status})`);
    io.say(io.dryRun ? 'dry run: smoke test not run' : 'smoke test passed');
  }
  io.say(io.dryRun ? `dry run: nothing was deployed` : `${config.project} deployed at ${sha}`);
  return 0;
}
