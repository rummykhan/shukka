// How the CLI runs other programs (cdk, aws, gh, git, npm, the project's own commands) and how it talks.
//
// Every command is printed before it runs, as `+ <command>`, so a real run shows what it does and a dry run
// (--dry-run) is the same list with nothing changed: commands marked `mutates` are printed and skipped. Read-only
// commands (git, `aws sts get-caller-identity`) still run in a dry run, because what is printed depends on them.

import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * @typedef {{
 *   cwd?: string,
 *   env?: Record<string, string | undefined>,
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
  const env = options.env ? { ...process.env, ...options.env } : process.env;
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
