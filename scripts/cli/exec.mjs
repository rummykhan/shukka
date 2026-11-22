// How the CLI runs other programs (cdk, aws, gh, git, npm, the project's own commands) and how it talks.
//
// Every command is printed before it runs, as `+ <command>`, so a real run shows what it does and a dry run
// (--dry-run) is the same list with nothing changed: commands marked `mutates` are printed and skipped. Read-only
// commands (git, `aws sts get-caller-identity`) still run in a dry run, because what is printed depends on them.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{
 *   cwd?: string,
 *   env?: Record<string, string | undefined>,
 *   fullEnv?: Record<string, string>,
 *   input?: string,
 *   mutates?: boolean,
 *   capture?: false | 'stdout' | 'merged',
 *   display?: string,
 * }} RunOptions
 * @typedef {{ status: number, stdout: string }} RunResult
 * @typedef {(cmd: string, args: string[], options: RunOptions) => RunResult} Spawn
 * @typedef {{
 *   dryRun: boolean,
 *   out: (text: string) => void,
 *   err: (text: string) => void,
 *   spawn: Spawn,
 *   run: (cmd: string, args: string[], options?: RunOptions) => RunResult,
 *   say: (line: string) => void,
 *   warn: (line: string) => void,
 * }} Io
 */

/** Temp directories this process made; main removes them when a command ends (cleanTemps). */
const temps = new Set();

/**
 * A new temp directory, removed by cleanTemps().
 * @param {string} name
 * @returns {string}
 */
export function tempDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `shukka-${name}-`));
  temps.add(dir);
  return dir;
}

/** Remove every directory tempDir() made. */
export function cleanTemps() {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps.clear();
}

/** A failure the CLI reports as one `shukka: ...` message and exit code (1: refused or failed). */
export class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} [code]
   */
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/**
 * Quote one word for display, so a printed command can be pasted into a shell.
 * @param {string} word
 * @returns {string}
 */
export function quote(word) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @returns {string}
 */
export function commandLine(cmd, args) {
  return [cmd, ...args].map(quote).join(' ');
}

/**
 * Run a program for real. `capture: 'merged'` sends stdout and stderr to one file, in the order written (what
 * `2>&1` does), and returns it; `capture: 'stdout'` returns stdout and lets stderr through.
 * @type {Spawn}
 */
export function realSpawn(cmd, args, options) {
  // fullEnv is the child's whole environment (nothing inherited); env is merged over this process's.
  const env = options.fullEnv ?? (options.env ? { ...process.env, ...options.env } : process.env);
  const base = { cwd: options.cwd, env, encoding: /** @type {const} */ ('utf8'), maxBuffer: 256 * 1024 * 1024 };
  if (options.capture === 'merged') {
    const dir = mkdtempSync(join(tmpdir(), 'shukka-out-'));
    const file = join(dir, 'out.txt');
    const fd = openSync(file, 'w');
    try {
      const r = spawnSync(cmd, args, { ...base, stdio: [options.input === undefined ? 'ignore' : 'pipe', fd, fd], input: options.input });
      if (r.error) throw new CliError(`cannot run ${cmd}: ${r.error.message}`);
      closeSync(fd);
      return { status: r.status ?? 1, stdout: readFileSync(file, 'utf8') };
    } finally {
      try { closeSync(fd); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const stdin = options.input === undefined ? 'ignore' : 'pipe';
  const stdout = options.capture === 'stdout' ? 'pipe' : 'inherit';
  const r = spawnSync(cmd, args, { ...base, stdio: [stdin, stdout, 'inherit'], input: options.input });
  if (r.error) throw new CliError(`cannot run ${cmd}: ${r.error.message}`);
  return { status: r.status ?? 1, stdout: options.capture === 'stdout' ? String(r.stdout ?? '') : '' };
}

/**
 * @param {{ dryRun?: boolean, out?: (text: string) => void, err?: (text: string) => void, spawn?: Spawn }} [options]
 * @returns {Io}
 */
export function createIo(options = {}) {
  const dryRun = options.dryRun ?? false;
  const out = options.out ?? ((text) => process.stdout.write(text));
  const err = options.err ?? ((text) => process.stderr.write(text));
  const spawn = options.spawn ?? realSpawn;
  /** @type {Io} */
  const io = {
    dryRun,
    out,
    err,
    spawn,
    say: (line) => out(`shukka: ${line}\n`),
    warn: (line) => err(`shukka: warning: ${line}\n`),
    run(cmd, args, runOptions = {}) {
      const mutates = runOptions.mutates ?? true;
      const shown = runOptions.display ?? commandLine(cmd, args);
      const where = runOptions.cwd ? `(in ${runOptions.cwd}) ` : '';
      if (dryRun && mutates) {
        out(`+ ${where}${shown}   [dry run: not run]\n`);
        return { status: 0, stdout: '' };
      }
      out(`+ ${where}${shown}\n`);
      return spawn(cmd, args, runOptions);
    },
  };
  return io;
}

/**
 * Run a command and fail with a message when it exits non-zero.
 * @param {Io} io
 * @param {string} what
 * @param {string} cmd
 * @param {string[]} args
 * @param {RunOptions} [options]
 * @returns {RunResult}
 */
export function mustRun(io, what, cmd, args, options = {}) {
  const r = io.run(cmd, args, options);
  if (r.status !== 0) throw new CliError(`${what} failed (exit ${r.status})`);
  return r;
}

/**
 * The environment for the project's own code (checks, build, npm ci, synth, smoke): this process's environment
 * without any AWS_* variable, the AWS config and credentials files pointed at empty files, and the instance
 * metadata service off, so the SDKs and CLIs in that code find no credentials. Code that reads ~/.aws itself by
 * path is not stopped by this.
 * @param {Record<string, string | undefined>} [extra] added after stripping
 * @param {Record<string, string | undefined>} [from] the environment to strip (default process.env)
 * @returns {Record<string, string>}
 */
export function projectEnv(extra = {}, from = process.env) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(from)) {
    if (v !== undefined && !/^AWS_/i.test(k)) env[k] = v;
  }
  const dir = tempDir('noaws');
  writeFileSync(join(dir, 'config'), '');
  writeFileSync(join(dir, 'credentials'), '');
  env.AWS_CONFIG_FILE = join(dir, 'config');
  env.AWS_SHARED_CREDENTIALS_FILE = join(dir, 'credentials');
  env.AWS_EC2_METADATA_DISABLED = 'true';
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

/** node:22 (Debian bookworm) by its multi-platform index digest: the base of the project image (image/Dockerfile). */
export const PROJECT_BASE_IMAGE = 'node:22@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb';

/** The Dockerfile of the image the project's own code runs in. */
export const PROJECT_DOCKERFILE = fileURLToPath(new URL('./image/Dockerfile', import.meta.url));

/**
 * The platform every project container (and the services of a check) is built and run for: linux/amd64, the
 * architecture of the GitHub-hosted runners that run the same steps in CI, so native modules and binaries come out
 * the same. On an arm64 machine Docker emulates it (slower).
 */
export const PROJECT_PLATFORM = 'linux/amd64';

/** The local tag of the project image: shukka-project:<first 16 hex of the Dockerfile's SHA-256>. */
export function projectImage() {
  return `shukka-project:${createHash('sha256').update(readFileSync(PROJECT_DOCKERFILE)).digest('hex').slice(0, 16)}`;
}

/**
 * Build the project image unless this Docker already has it (`docker image inspect`, read-only); returns its tag.
 * The build context is an empty directory: the Dockerfile copies nothing in.
 * @param {Io} io
 * @returns {string}
 */
export function ensureProjectImage(io) {
  const tag = projectImage();
  if (io.run('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { mutates: false, capture: 'merged' }).status === 0) return tag;
  mustRun(io, `docker build of ${tag}`, 'docker', ['build', '--platform', PROJECT_PLATFORM, '--tag', tag, '--file', PROJECT_DOCKERFILE, tempDir('image')]);
  return tag;
}

/**
 * Services a check may name (shukka.json checks[].services), as pipeline.yml's "Start services" step starts them:
 * the same image and the port the check reaches on localhost. A test keeps the two in step.
 */
export const SERVICES = Object.freeze({
  'dynamodb-local': { image: 'amazon/dynamodb-local:3.3.1@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab', port: 8000 },
});

/** Variable names never passed into the project's container: credentials and the caller's home. */
const NOT_PASSED = /^(AWS_|GH_|GITHUB_|HOME$)/i;

/**
 * What `shukka diff` and `shukka deploy` print, and their --help says, when the project's code runs on this machine.
 */
export const HOST_CODE_WARNING = '--trust-project-code: Docker is not available, so the project\'s own code (npm ci, cdk synth, '
  + 'checks, build, bundle, smoke) runs on this machine as you. It gets no AWS_* variables, but it can read your home '
  + 'directory: ~/.aws, the AWS SSO cache, gh\'s token. Use this only for code you trust';

/**
 * Whether a Docker daemon answers (`docker info`, read-only; also run in a dry run).
 * @param {Io} io
 * @returns {boolean}
 */
export function dockerAvailable(io) {
  try {
    return io.run('docker', ['info', '--format', '{{.ServerVersion}}'], { mutates: false, capture: 'merged' }).status === 0;
  } catch {
    return false; // no docker program
  }
}

let containers = 0;

/**
 * The `docker run` arguments (after `docker`) that run `cmd args` in a throwaway container of `image` (the project
 * image) for PROJECT_PLATFORM: only `tree` mounted, read-write, at its own path (so paths printed inside mean the
 * same outside); as the caller's user and group, so files written back are the caller's; HOME=/tmp inside the
 * container (nothing of the caller's home); no capabilities, no privilege gain; the default network (npm needs it),
 * or with `network` the network of that container (a check's services, reached on localhost). The container sees no
 * variable of this process: only HOME, CI=true and `env`, which is written to an --env-file in a shukka temp
 * directory (values stay off the command line).
 * @param {{ image: string, tree: string, cwd: string, env: Record<string, string>, cmd: string, args: string[], label?: string, network?: string }} spec
 * @returns {string[]}
 */
export function containerArgs(spec) {
  const rel = relative(spec.tree, spec.cwd);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new CliError(`refusing: ${spec.cwd} is outside the checkout ${spec.tree}, which is all the container has`);
  if (spec.tree.includes(',')) throw new CliError(`refusing: the checkout path ${spec.tree} has a comma, which docker --mount cannot take`);
  const lines = [];
  for (const [k, v] of Object.entries(spec.env)) {
    if (NOT_PASSED.test(k)) throw new CliError(`refusing: ${k} is never passed into the project's container (AWS_*, GH_*, GITHUB_* and HOME are not)`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new CliError(`refusing: ${JSON.stringify(k)} is not a variable name`);
    if (/[\r\n\0]/.test(v)) throw new CliError(`refusing: the value of ${k} has a line break, which docker --env-file cannot carry`);
    lines.push(`${k}=${v}`);
  }
  const envFile = join(tempDir('env'), 'container.env');
  writeFileSync(envFile, lines.length > 0 ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  containers += 1;
  return [
    'run', '--rm', '--platform', PROJECT_PLATFORM,
    '--name', `shukka-${spec.label ?? 'step'}-${process.pid}-${containers}`,
    '--user', `${uid}:${gid}`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...(spec.network ? ['--network', `container:${spec.network}`] : []),
    '--mount', `type=bind,source=${spec.tree},target=${spec.tree}`,
    '--workdir', spec.cwd,
    '--env', 'HOME=/tmp', '--env', 'CI=true', '--env-file', envFile,
    spec.image, spec.cmd, ...spec.args,
  ];
}

/**
 * Start a check's services as sibling containers for PROJECT_PLATFORM (detached, removed when stopped, nothing
 * mounted, names carrying `runId`): the first on the default network, the others in its network, so the check,
 * run with `--network container:<first>`, reaches each on localhost:<port> as in CI. Returns the first container's
 * name (the network) and a stop() that removes them all. Refuses a service shukka does not know.
 * @param {Io} io
 * @param {string} check the check's name, for messages
 * @param {string[]} services
 * @param {string} runId
 * @returns {{ network: string, stop: () => void }}
 */
export function startServices(io, check, services, runId) {
  /** @type {Record<string, { image: string, port: number }>} */
  const known = SERVICES;
  for (const s of services) {
    if (!Object.hasOwn(known, s)) {
      throw new CliError(`check ${check} uses service "${s}", which shukka cannot start (known: ${Object.keys(known).join(', ')}); `
        + 'run with --skip-checks to deploy without the checks');
    }
  }
  /** @type {string[]} */
  const names = [];
  const stop = () => {
    if (names.length > 0) io.run('docker', ['rm', '--force', ...names], { capture: 'merged' });
  };
  try {
    for (const s of services) {
      const name = `shukka-${runId}-${s}`;
      const network = names[0] ? ['--network', `container:${names[0]}`] : [];
      mustRun(io, `starting service ${s} for check ${check}`, 'docker', [
        'run', '--detach', '--rm', '--platform', PROJECT_PLATFORM, '--name', name, ...network, /** @type {{ image: string }} */ (known[s]).image,
      ], { capture: 'merged' });
      names.push(name);
    }
  } catch (error) {
    stop();
    throw error;
  }
  return { network: /** @type {string} */ (names[0]), stop };
}

/** npm settings for the cdk child: no project .npmrc can choose the shell or the registry. */
export const NPM_SAFE = Object.freeze({ npm_config_script_shell: '/bin/sh', npm_config_registry: 'https://registry.npmjs.org/' });

/**
 * Path of the cdk CLI shukka depends on (aws-cdk, pinned in package.json), run as `node <path>`: never npx, which
 * would read the project's .npmrc, and never the project's own cdk.
 * @returns {string}
 */
export function cdkBin() {
  const require = createRequire(import.meta.url);
  const pkgFile = require.resolve('aws-cdk/package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.cdk;
  return join(dirname(pkgFile), bin);
}

/**
 * Where cdk runs: a fresh empty directory as its cwd and another as its HOME, so no cdk.json (with `plugin`
 * entries, which cdk loads and runs) is read from the directory it runs in or from ~/.cdk.json.
 * @returns {{ cwd: string, home: string }}
 */
export function cdkPlace() {
  return { cwd: tempDir('cdk-cwd'), home: tempDir('cdk-home') };
}

/**
 * The AWS config and credentials files of this process, by real path, so a child whose HOME is moved still finds
 * the caller's profile.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ AWS_CONFIG_FILE: string, AWS_SHARED_CREDENTIALS_FILE: string }}
 */
export function awsFiles(env = process.env) {
  return {
    AWS_CONFIG_FILE: env.AWS_CONFIG_FILE ?? join(homedir(), '.aws', 'config'),
    AWS_SHARED_CREDENTIALS_FILE: env.AWS_SHARED_CREDENTIALS_FILE ?? join(homedir(), '.aws', 'credentials'),
  };
}

/**
 * Refuse a config file that is, or sits under, a symbolic link below `base` (it could point anywhere).
 * @param {string} base
 * @param {string} file
 */
export function refuseSymlink(base, file) {
  const rel = relative(base, resolve(base, file));
  const parts = rel.startsWith('..') || isAbsolute(rel) ? [resolve(base, file)] : rel.split(/[\\/]/);
  let at = rel.startsWith('..') || isAbsolute(rel) ? '' : base;
  for (const part of parts) {
    at = at === '' ? part : join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) throw new CliError(`refusing: ${file} is or is under a symbolic link (${at})`);
  }
}
