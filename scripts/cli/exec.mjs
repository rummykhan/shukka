// How the CLI runs other programs (cdk, aws, gh, git, npm, the project's own commands) and how it talks.
//
// Every command is printed before it runs, as `+ <command>`, so a real run shows what it does and a dry run
// (--dry-run) is the same list with nothing changed: commands marked `mutates` are printed and skipped. Read-only
// commands (git, `aws sts get-caller-identity`) still run in a dry run, because what is printed depends on them.

import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
