// `shukka diff` and `shukka deploy`: the emergency path from a laptop (design C7, D11, Key flows "GitHub down").
//
// Both refuse unless the working tree is clean and HEAD is origin/main, then work in a fresh detached worktree of
// that commit (submodules at their recorded commits), so files git does not show (ignored, skip-worktree,
// assume-unchanged) cannot change what is built. shukka.json is read from that tree.
//
// `deploy` takes the steps the workflows take, in the same order:
//   checks (pipeline.yml "check", skippable with --skip-checks) -> build and bundle (pipeline.yml "build") ->
//   synth, assembly and policy checks, cdk diff, guard, cdk deploy with the shukka:revision tag (infra.yml "deploy") ->
//   upload and release each app (ec2.yml "release": scripts/upload.mjs, scripts/release.mjs) -> smoke.
// Credentials, as in CI: the project's own code (checks, build, bundle, npm ci, synth, smoke) runs in a throwaway
// Docker container with only the fresh worktree mounted and nothing of the caller's environment or home
// (projectSteps, exec.mjs containerArgs); without Docker it runs here with no AWS variables (projectEnv), only when
// --trust-project-code says so. cdk diff and deploy run with shukka's pinned cdk and only a session of the project's bootstrap
// deploy role (which trusts the emergency principals named at bootstrap), so they are fenced like the pipeline.
// Upload and release are shukka's own code and use the caller's credentials in this process.
// Every part deploys, whatever changed: an emergency deploy makes AWS match origin/main. The release script
// redeploys a commit that is already live without harm, and an unchanged stack is a no-op for cdk.

import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { guard, report } from '../guard.mjs';
import { githubRepoFromUrl, policyGuard, report as policyReport } from '../policy-guard.mjs';
import { release } from '../release.mjs';
import { upload } from '../upload.mjs';
import {
  CliError, HOST_CODE_WARNING, NPM_SAFE, cdkBin, cdkPlace, containerArgs, dockerAvailable, ensureProjectImage, mustRun, projectEnv, refuseSymlink,
  startServices, tempDir,
} from './exec.mjs';

const SHUKKA_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const REVISION_TAG = 'shukka:revision';
export const SESSION_NAME = 'shukka-emergency';

/**
 * @typedef {import('./exec.mjs').Io} Io
 * @typedef {import('./aws.mjs').Aws} Aws
 * @typedef {import('./aws.mjs').Session} Session
 * @typedef {import('../config.mjs').Config} Config
 * @typedef {{ profile?: string, region?: string }} Target
 * @typedef {{ root: string, sha: string, tree: string, config: Config, aws: Aws }} Prepared
 * @typedef {{ cwd: string, env?: Record<string, string>, capture?: false | 'stdout', network?: string }} StepOptions network: a container whose network the step joins (container mode only)
 * @typedef {import('./exec.mjs').RunResult} RunResult
 * @typedef {{
 *   inContainer: boolean,
 *   exec: (cmd: string, args: string[], options: StepOptions) => RunResult,
 *   run: (what: string, cmd: string, args: string[], options: StepOptions) => RunResult,
 *   services: (check: string, names: string[]) => { network?: string, stop: () => void },
 * }} ProjectSteps exec returns the result; run fails with `<what> failed (exit N)` on a non-zero exit
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
 * The config's path relative to the repository root; refuses a path outside the repository.
 * @param {string} root
 * @param {string} cwd
 * @param {string} configPath
 * @returns {string}
 */
export function configInRepo(root, cwd, configPath) {
  const full = resolve(cwd, configPath);
  let real;
  try {
    real = join(realpathSync(dirname(full)), basename(full));
  } catch {
    throw new CliError(`--config ${configPath}: no such directory`);
  }
  const rel = relative(realpathSync(root), real);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new CliError(`refusing: --config ${configPath} is outside the repository at ${root}`);
  return rel;
}

/**
 * A fresh detached worktree of `sha` (submodules at their recorded commits), in a new temp directory.
 * @param {Io} io
 * @param {string} root
 * @param {string} sha
 * @returns {string}
 */
function freshTree(io, root, sha) {
  const tree = join(tempDir('tree'), 'tree');
  mustRun(io, 'git worktree add', 'git', ['worktree', 'add', '--quiet', '--detach', tree, sha], { cwd: root, mutates: false, capture: 'merged' });
  mustRun(io, 'git submodule update', 'git', ['submodule', 'update', '--init', '--recursive', '--quiet'], { cwd: tree, mutates: false, capture: 'merged' });
  return tree;
}

/**
 * @param {Io} io
 * @param {string} root
 * @param {string} tree
 */
function removeTree(io, root, tree) {
  io.run('git', ['worktree', 'remove', '--force', tree], { cwd: root, mutates: false, capture: 'merged' });
}

/**
 * Environment for the project's own code when it runs on this machine (--trust-project-code): no AWS credentials,
 * the config's account and region for CDK.
 * @param {Config} config
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
function codeEnv(config, extra = {}) {
  return projectEnv({ CDK_DEFAULT_ACCOUNT: config.aws.account, CDK_DEFAULT_REGION: config.aws.region, ...extra });
}

/** Why diff and deploy stop when there is no Docker. */
export const NO_DOCKER = 'refusing: Docker is not available, and the project\'s own code (npm ci, cdk synth, checks, build, bundle, smoke) '
  + 'runs only in a container, away from your home directory and credentials. Start Docker, or pass --trust-project-code '
  + 'to run that code on this machine as you (it can then read ~/.aws, the AWS SSO cache and gh\'s token)';

/**
 * How the project's own code runs (every npm ci, synth, check, build, bundle and smoke command): in a throwaway
 * container of the project image (exec.mjs ensureProjectImage, built here when missing) when Docker answers
 * (exec.mjs containerArgs: only `tree` mounted, no home directory, only the variables given here; a check's services
 * as sibling containers, exec.mjs startServices), else on this machine with projectEnv when `trust` is set (services
 * are then the caller's to start), else refused.
 * @param {Io} io
 * @param {string} tree
 * @param {Config} config
 * @param {boolean} trust --trust-project-code
 * @returns {ProjectSteps}
 */
export function projectSteps(io, tree, config, trust) {
  const base = { CDK_DEFAULT_ACCOUNT: config.aws.account, CDK_DEFAULT_REGION: config.aws.region };
  /** @type {(cmd: string, args: string[], options: StepOptions) => RunResult} */
  let exec;
  /** @type {ProjectSteps['services']} */
  let services;
  const inContainer = dockerAvailable(io);
  if (inContainer) {
    const image = ensureProjectImage(io);
    io.say(`the project's code (npm ci, cdk synth, checks, build, bundle, smoke) runs in throwaway containers of ${image}: `
      + `only ${tree} is mounted, no home directory, no AWS or GitHub credentials`);
    exec = (cmd, args, options) => io.run('docker', containerArgs({
      image, tree, cwd: options.cwd, env: { ...base, ...options.env }, cmd, args, label: config.project,
      ...(options.network ? { network: options.network } : {}),
    }), options.capture ? { capture: options.capture } : {});
    services = (check, names) => startServices(io, check, names, `${config.project}-${randomBytes(4).toString('hex')}`);
  } else {
    if (!trust) throw new CliError(NO_DOCKER);
    io.warn(HOST_CODE_WARNING);
    exec = (cmd, args, options) => io.run(cmd, args, {
      cwd: options.cwd, fullEnv: codeEnv(config, options.env), ...(options.capture ? { capture: options.capture } : {}),
    });
    services = (check, names) => {
      io.warn(`check ${check} uses services (${names.join(', ')}) that CI starts; without Docker shukka does not, start them yourself`);
      return { stop: () => {} };
    };
  }
  return {
    inContainer,
    exec,
    services,
    run(what, cmd, args, options) {
      const r = exec(cmd, args, options);
      if (r.status !== 0) throw new CliError(`${what} failed (exit ${r.status})`);
      return r;
    },
  };
}

/**
 * Environment for shukka's cdk child: no inherited AWS settings, only the fenced session's keys.
 * @param {Config} config
 * @param {Session | null} session
 * @returns {Record<string, string>}
 */
function cdkEnv(config, session) {
  return projectEnv({
    ...NPM_SAFE,
    CDK_DEFAULT_ACCOUNT: config.aws.account,
    CDK_DEFAULT_REGION: config.aws.region,
    AWS_REGION: config.aws.region,
    AWS_DEFAULT_REGION: config.aws.region,
    ...(session ? { AWS_ACCESS_KEY_ID: session.accessKeyId, AWS_SECRET_ACCESS_KEY: session.secretAccessKey, AWS_SESSION_TOKEN: session.sessionToken } : {}),
  });
}

/**
 * The project's bootstrap deploy role.
 * @param {Config} config
 * @returns {string}
 */
export function deployRoleArn(config) {
  const { account, region } = config.aws;
  return `arn:aws:iam::${account}:role/cdk-${config.qualifier}-deploy-role-${account}-${region}`;
}

/**
 * A session of the deploy role for cdk (null in a dry run, where nothing is diffed or deployed).
 * @param {Io} io
 * @param {Aws} aws
 * @param {Config} config
 * @returns {Promise<Session | null>}
 */
async function fencedSession(io, aws, config) {
  const role = deployRoleArn(config);
  if (io.dryRun) {
    io.out(`+ assume ${role} as ${SESSION_NAME}; cdk gets only that session   [dry run: not run]\n`);
    return null;
  }
  const session = await aws.assumeRole(role, SESSION_NAME);
  io.say(`cdk runs as ${role} (session ${SESSION_NAME})`);
  return session;
}

/**
 * npm ci and cdk synth in the infra directory, as project code (cdk.context.json is committed, so the synth needs
 * no lookup); returns the assembly directory, in a new directory inside the fresh tree (all the container can write).
 * @param {ProjectSteps} steps
 * @param {string} tree
 * @param {Config} config
 * @returns {string}
 */
function synth(steps, tree, config) {
  const infra = join(tree, config.infra.dir);
  const assembly = join(mkdtempSync(join(tree, '.shukka-cdk-')), 'cdk.out');
  steps.run('npm ci in the infra directory', 'npm', ['ci'], { cwd: infra });
  steps.run('cdk synth', 'npx', ['--no-install', 'cdk', 'synth', '--quiet', '--output', assembly], { cwd: infra });
  return assembly;
}

/**
 * shukka's cdk with the fenced session, from an empty temp directory with an empty HOME (no cdk.json plugins from
 * the directory or from ~/.cdk.json); the assembly is passed with --app.
 * @param {Io} io
 * @param {Config} config
 * @param {Session | null} session
 * @param {string} assembly
 * @param {string[]} args
 * @param {import('./exec.mjs').RunOptions} [options]
 */
function cdk(io, config, session, assembly, args, options = {}) {
  const place = cdkPlace();
  return io.run(process.execPath, [cdkBin(), ...args], { cwd: place.cwd, fullEnv: { ...cdkEnv(config, session), HOME: place.home }, ...options });
}

/**
 * The assembly checks the workflows use (scripts/assembly.mjs: no file asset built by a command, no Docker image
 * asset, nothing outside the assembly), loaded by path so this file does not fail to load where it is absent.
 * @returns {Promise<(dir: string) => string[]>}
 */
async function loadAssemblyCheck() {
  const specifier = '../assembly.mjs';
  try {
    const mod = await import(specifier);
    return mod.checkAssembly;
  } catch (error) {
    const e = /** @type {{ code?: string, message?: string }} */ (error);
    if (e.code === 'ERR_MODULE_NOT_FOUND' && /assembly\.mjs/.test(e.message ?? '')) {
      throw new CliError('refusing: this shukka has no scripts/assembly.mjs, so the synthesized assembly cannot be checked for assets that run commands');
    }
    throw error;
  }
}

/**
 * Refuse an assembly with executable or Docker assets (or paths leaving it) before cdk gets credentials.
 * @param {Io} io
 * @param {string} assembly
 * @param {((dir: string) => string[]) | undefined} check
 */
async function checkAssemblySafe(io, assembly, check) {
  if (io.dryRun) {
    io.out(`+ node scripts/assembly.mjs check ${assembly}   [dry run: not run]\n`);
    return;
  }
  const problems = (check ?? (await loadAssemblyCheck()))(assembly);
  if (problems.length > 0) throw new CliError(`refusing to deploy the synthesized assembly:\n${problems.join('\n')}`);
  io.say('assembly checked: no asset runs a command, no Docker image asset');
}

/**
 * Stop, as the workflows do (scripts/policy-guard.mjs), when a trust or resource policy in the assembly lets a
 * principal outside the project in; --allow-replacement goes ahead. The project's repository, which a GitHub trust
 * must name, is origin's.
 * @param {Io} io
 * @param {string} root
 * @param {string} assembly
 * @param {Config} config
 * @param {boolean} allow
 */
function checkPoliciesSafe(io, root, assembly, config, allow) {
  const remote = io.run('git', ['remote', 'get-url', 'origin'], { cwd: root, mutates: false, capture: 'stdout' });
  const repo = remote.status === 0 ? githubRepoFromUrl(remote.stdout) : null;
  const mailDomains = config.fence.mailDomains;
  const args = ['--account', config.aws.account, ...(repo ? ['--repo', repo] : []), ...mailDomains.flatMap((d) => ['--mail-domain', d]), ...(allow ? ['--allow'] : [])];
  if (io.dryRun) {
    io.out(`+ node scripts/policy-guard.mjs ${assembly} ${args.join(' ')}   [dry run: not run]\n`);
    return;
  }
  if (!repo) io.warn('origin is not a GitHub repository, so a GitHub trust in the assembly cannot be checked against it and stops the deploy');
  const result = policyGuard(assembly, { account: config.aws.account, repos: repo ? [repo] : [], mailDomains, allow });
  io.out(policyReport(result));
  if (result.code !== 0) {
    throw new CliError(result.verdict === 'unreadable'
      ? 'the policy guard stopped the deploy: the assembly cannot be read'
      : 'the policy guard stopped the deploy: a trust or resource policy lets a principal outside the project in, or cannot be checked; run again with --allow-replacement if that is intended');
  }
}

/**
 * cdk diff of the assembly, then the guard. Returns the guard's result; prints the diff and the verdict.
 * @param {Io} io
 * @param {Config} config
 * @param {Session | null} session
 * @param {string} assembly
 * @param {boolean} allow
 */
function diffAndGuard(io, config, session, assembly, allow) {
  // In a dry run nothing was synthesized, so there is nothing to diff: the step is printed, not run.
  const r = cdk(io, config, session, assembly, ['diff', '--app', assembly, '--no-color'], { capture: 'merged' });
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
 * @param {Config} config
 * @param {Session | null} session
 * @param {string} assembly
 * @param {string} sha
 */
function deployStacks(io, config, session, assembly, sha) {
  const manifestFile = join(assembly, 'manifest.json');
  /** @type {Record<string, any>} */
  const artifacts = existsSync(manifestFile) ? (JSON.parse(readFileSync(manifestFile, 'utf8')).artifacts ?? {}) : {};
  const stacks = Object.entries(artifacts).filter(([, a]) => a.type === 'aws:cloudformation:stack');
  const ids = new Set(stacks.map(([id]) => id));
  /** @param {any} a */
  const tagArgs = (a) => Object.entries({ ...(a.properties?.tags ?? {}), [REVISION_TAG]: sha }).map(([k, v]) => `--tags=${k}=${v}`);
  // Nothing from the assembly may become a cdk option: each tag is one --tags=k=v token (above), and every stack
  // selector is checked again (scripts/assembly.mjs SELECTOR) before cdk starts.
  /** @param {string} id */
  const selector = (id) => artifacts[id].displayName ?? id;
  for (const [id] of stacks) {
    const s = selector(id);
    if (typeof s !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(s)) throw new CliError(`refusing stack selector ${JSON.stringify(s)}: it could be read as a cdk option`);
  }
  /** @param {string[]} args */
  const deploy = (args) => {
    const r = cdk(io, config, session, assembly, ['deploy', '--app', assembly, '--require-approval', 'never', '--no-color', ...args]);
    if (r.status !== 0) throw new CliError(`cdk deploy failed (exit ${r.status})`);
  };
  const keys = new Set(stacks.map(([, a]) => JSON.stringify(Object.entries(a.properties?.tags ?? {}).sort())));
  if (io.dryRun && stacks.length === 0) {
    io.out('  (dry run: nothing was synthesized; the real cdk deploy commands depend on the synthesized assembly: one --all when every stack has the same tags, else one --exclusively per stack)\n');
    deploy(['--all', `--tags=${REVISION_TAG}=${sha}`]);
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
      deploy(['--exclusively', selector(id), ...tagArgs(a)]);
      done.add(id);
    };
    for (const [id] of stacks) visit(id);
  }
}

/**
 * Run each check's commands in its directory, as pipeline.yml's check job does, as project code.
 * @param {Io} io
 * @param {ProjectSteps} steps
 * @param {string} tree
 * @param {Config} config
 */
function runChecks(io, steps, tree, config) {
  for (const check of config.checks) {
    const services = check.services.length > 0 ? steps.services(check.name, check.services) : { stop: () => {} };
    try {
      check.run.forEach((command, i) => {
        io.say(`check ${check.name}, command ${i + 1} of ${check.run.length}`);
        steps.run(`check ${check.name} (command ${i + 1})`, 'bash', ['-eo', 'pipefail', '-c', command], {
          cwd: join(tree, check.dir), ...(services.network ? { network: services.network } : {}),
        });
      });
    } finally {
      services.stop();
    }
  }
}

/**
 * Build one app and run its bundle script, as pipeline.yml's build job does, as project code; returns the
 * bundle directory. buildEnv values come from the environment when set (CI reads them from repository variables,
 * which a laptop cannot), otherwise from Parameter Store /<project>/prod/<NAME>, where `shukka bootstrap` copied
 * them from.
 * shukka's own bundle script (outside the tree, so outside the container) is copied into the tree first.
 * @param {Io} io
 * @param {ProjectSteps} steps
 * @param {Aws} aws
 * @param {string} tree
 * @param {Config} config
 * @param {import('../config.mjs').App} app
 * @param {Record<string, string | undefined>} env the caller's environment, for buildEnv values
 * @returns {Promise<string>}
 */
async function build(io, steps, aws, tree, config, app, env) {
  /** @type {Record<string, string>} */
  const values = { ...app.build.env };
  for (const name of app.build.buildEnv) {
    const fromEnv = env[name];
    if (fromEnv !== undefined) {
      values[name] = fromEnv;
      continue;
    }
    const path = `/${config.project}/prod/${name}`;
    const p = await aws.getParameter(path);
    if (!p) throw new CliError(`build ${app.name} needs ${name}: set it in the environment or in ${path}`);
    if (p.type === 'SecureString') throw new CliError(`build ${app.name}: ${path} is a SecureString; build-time values must not be secret`);
    values[name] = p.value;
  }
  const cwd = join(tree, app.build.dir);
  app.build.run.forEach((command, i) => {
    io.say(`build ${app.name}, command ${i + 1} of ${app.build.run.length}`);
    steps.run(`build ${app.name} (command ${i + 1})`, 'bash', ['-eo', 'pipefail', '-c', command], { cwd, env: values });
  });
  let script = resolve(cwd, app.build.bundle);
  if (!existsSync(script) && app.build.bundle === 'scripts/bundle.sh') script = join(SHUKKA_DIR, 'scripts', 'bundle.sh');
  if (!io.dryRun && !existsSync(script)) throw new CliError(`build ${app.name}: no bundle script ${app.build.bundle} in ${app.build.dir}`);
  if (steps.inContainer && !inside(tree, script)) {
    // shukka's own script is outside the checkout, so outside the container: a copy goes into a new directory there.
    const copy = join(mkdtempSync(join(tree, '.shukka-bundle-')), basename(script));
    copyFileSync(script, copy);
    script = copy;
  }
  const r = steps.run(`build ${app.name}: the bundle script`, 'bash', [script], { cwd, env: values, capture: 'stdout' });
  if (io.dryRun) return `<directory printed by ${app.build.bundle}>`;
  const dir = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  if (!dir) throw new CliError(`build ${app.name}: the bundle script did not print a directory`);
  return checkBundlePath(tree, resolve(cwd, dir), app.name);
}

/**
 * The bundle directory, refused unless it is a real directory inside the checkout: no part of its path below the
 * tree may be a symbolic link (one made by the bundle script, or committed, could point at ~/.aws, and the upload
 * would follow it), and its real path must be inside the tree's real path. Only the checkout outlives the container.
 * @param {string} tree
 * @param {string} bundle
 * @param {string} app
 * @returns {string}
 */
export function checkBundlePath(tree, bundle, app) {
  if (!inside(tree, bundle)) throw new CliError(`build ${app}: the bundle script printed ${bundle}, outside the checkout; only the checkout outlives the container`);
  let at = tree;
  for (const part of relative(tree, bundle).split(/[\\/]/).filter(Boolean)) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      throw new CliError(`build ${app}: the bundle directory ${bundle} does not exist`);
    }
    if (st.isSymbolicLink()) throw new CliError(`build ${app}: refusing the bundle ${bundle}: ${at} is a symbolic link`);
  }
  let real;
  try {
    real = realpathSync(bundle);
  } catch {
    throw new CliError(`build ${app}: the bundle directory ${bundle} does not exist`);
  }
  if (!inside(realpathSync(tree), real)) throw new CliError(`build ${app}: refusing the bundle ${bundle}: its real path ${real} is outside the checkout`);
  if (!lstatSync(real).isDirectory()) throw new CliError(`build ${app}: the bundle ${bundle} is not a directory`);
  return bundle;
}

/**
 * Whether `path` is `dir` or below it.
 * @param {string} dir
 * @param {string} path
 * @returns {boolean}
 */
function inside(dir, path) {
  const rel = relative(dir, path);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Check out origin/main into a fresh tree, read its shukka.json, and check the region and the account.
 * @param {{ io: Io, makeAws: (region: string) => Aws, target: Target, configPath: string, cwd: string }} options
 * @returns {Promise<Prepared>}
 */
async function prepare({ io, makeAws, target, configPath, cwd }) {
  const { root, sha } = checkCheckout(io, cwd);
  const rel = configInRepo(root, cwd, configPath);
  const tree = freshTree(io, root, sha);
  try {
    refuseSymlink(tree, rel);
    const { config, problems } = loadConfig(join(tree, rel));
    if (!config) throw new CliError(problems.join('\n'));
    if (target.region !== undefined && target.region !== config.aws.region) {
      throw new CliError(`--region ${target.region} is not the region in shukka.json (${config.aws.region})`);
    }
    const aws = makeAws(config.aws.region);
    const caller = await aws.callerArn();
    if (caller.account !== config.aws.account) {
      throw new CliError(`the credentials are for account ${caller.account}, but shukka.json names ${config.aws.account}`);
    }
    io.say(`${config.project} at ${sha} (origin/main, checked out fresh in ${tree}); account ${caller.account}, region ${config.aws.region}, as ${caller.arn}`);
    return { root, sha, tree, config, aws };
  } catch (error) {
    removeTree(io, root, tree);
    throw error;
  }
}

/**
 * `shukka diff`: synth, cdk diff and the guard's verdict. Exit 0 when nothing is deleted or replaced.
 * @param {{
 *   io: Io, makeAws: (region: string) => Aws, target: Target, configPath: string, cwd: string,
 *   trustProjectCode?: boolean, checkAssembly?: (dir: string) => string[],
 * }} options
 * @returns {Promise<number>}
 */
export async function diffCommand(options) {
  const { io } = options;
  const { root, tree, config, aws } = await prepare(options);
  try {
    const steps = projectSteps(io, tree, config, options.trustProjectCode ?? false);
    const assembly = synth(steps, tree, config);
    await checkAssemblySafe(io, assembly, options.checkAssembly);
    const session = await fencedSession(io, aws, config);
    const { result, diffStatus } = diffAndGuard(io, config, session, assembly, false);
    if (diffStatus !== 0) throw new CliError(`cdk diff failed (exit ${diffStatus})`);
    return result.code;
  } finally {
    removeTree(io, root, tree);
  }
}

/**
 * `shukka deploy`.
 * @param {{
 *   io: Io, makeAws: (region: string) => Aws, target: Target, configPath: string, cwd: string,
 *   bucket?: string, allowReplacement?: boolean, skipChecks?: boolean, trustProjectCode?: boolean,
 *   env?: Record<string, string | undefined>, checkAssembly?: (dir: string) => string[],
 * }} options
 * @returns {Promise<number>}
 */
export async function deployCommand(options) {
  const { io } = options;
  const { root, sha, tree, config, aws } = await prepare(options);
  try {
    const steps = projectSteps(io, tree, config, options.trustProjectCode ?? false);
    // aws.deployBucket is added to shukka.json by the workflows task; until then, the workflows' default.
    const configured = /** @type {{ deployBucket?: string }} */ (config.aws).deployBucket;
    const bucket = options.bucket ?? configured ?? `${config.project}-deploy-${config.aws.account}`;
    io.say(`deploying ${sha} to ${config.project}; bundles go to s3://${bucket}`);

    if (options.skipChecks) io.warn('--skip-checks: the project\'s checks are not run; you are deploying unchecked code');
    else runChecks(io, steps, tree, config);

    /** @type {Map<string, string>} */
    const bundles = new Map();
    for (const app of config.apps) bundles.set(app.name, await build(io, steps, aws, tree, config, app, options.env ?? process.env));

    const assembly = synth(steps, tree, config);
    await checkAssemblySafe(io, assembly, options.checkAssembly);
    checkPoliciesSafe(io, root, assembly, config, options.allowReplacement ?? false);
    const session = await fencedSession(io, aws, config);
    const { result, diffStatus } = diffAndGuard(io, config, session, assembly, options.allowReplacement ?? false);
    if (result.code !== 0) {
      throw new CliError(result.verdict === 'incomplete'
        ? 'the guard stopped the deploy: the diff is incomplete'
        : 'the guard stopped the deploy: resources would be deleted or replaced; run again with --allow-replacement if that is intended');
    }
    if (diffStatus !== 0) throw new CliError(`cdk diff failed (exit ${diffStatus})`);
    deployStacks(io, config, session, assembly, sha);

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
        checkout: tree, configure: app.server.configure, units: app.server.units, health: app.server.health,
        bundleSha256: uploaded.sha256,
        s3: clients.s3, ssm: clients.ssm, ec2: clients.ec2, out: io.out,
      });
      if (!released.ok) throw new CliError(`release of ${app.name} failed`, released.code);
    }

    if (config.smoke) {
      const r = steps.exec('bash', ['-c', config.smoke.run], { cwd: tree });
      if (r.status !== 0) throw new CliError(`the site is live but failing its smoke test (the smoke command exited ${r.status})`);
      io.say(io.dryRun ? 'dry run: smoke test not run' : 'smoke test passed');
    }
    io.say(io.dryRun ? 'dry run: nothing was deployed' : `${config.project} deployed at ${sha}`);
    return 0;
  } finally {
    removeTree(io, root, tree);
  }
}
