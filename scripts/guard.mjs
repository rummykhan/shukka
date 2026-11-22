#!/usr/bin/env node
// Reads full `cdk diff --no-color` output on stdin and fails if any resource would be deleted or replaced.
// A replaced server or table is downtime or an empty table, so a merge must not do it by accident;
// run the workflow by hand with allow_replacement (`--allow`) to go ahead on purpose.
// Port of Trendigle's diff-guard.sh with the same rules, plus: a removed stack Output is not destructive.
//
// Usage: npx cdk diff --no-color 2>&1 | node scripts/guard.mjs [--allow] [--summary <file>]
// Exit 0: nothing is deleted or replaced (or it was allowed). Exit 1: something is, or the diff is incomplete.
// Exit 2: bad arguments.
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CLOSING_LINE = 'Number of stacks with differences:';
// Colour codes would hide the markers below, so they are removed first.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const REMOVED = /^\[-\] /;
const REMOVED_OUTPUT = /^\[-\] Output /;
const REPLACED = /^\[~\] .* (replace|may be replaced)$/;
const PROPERTY_REPLACED = /\((requires|may cause) replacement\)/;

/**
 * @typedef {'safe' | 'destructive' | 'allowed' | 'incomplete'} Verdict
 * @typedef {{ verdict: Verdict, code: 0 | 1, found: string[] }} GuardResult
 */

/**
 * @param {string} text
 * @returns {string}
 */
export function stripColour(text) {
  return text.replace(ANSI, '');
}

/**
 * Lines of the diff that delete or replace a resource.
 * @param {string} text colour-free diff
 * @returns {string[]}
 */
export function destructiveLines(text) {
  return text.split(/\r?\n/).filter((line) => {
    if (REMOVED.test(line)) return !REMOVED_OUTPUT.test(line);
    return REPLACED.test(line) || PROPERTY_REPLACED.test(line);
  });
}

/**
 * @param {string} diff full `cdk diff` output, colour codes allowed
 * @param {{ allow?: boolean }} [options]
 * @returns {GuardResult}
 */
export function guard(diff, options = {}) {
  const text = stripColour(diff);
  // A diff that failed part-way, or printed nothing, proves nothing: only a complete one may pass.
  if (!text.includes(CLOSING_LINE)) return { verdict: 'incomplete', code: 1, found: [] };
  const found = destructiveLines(text);
  if (found.length === 0) return { verdict: 'safe', code: 0, found };
  if (options.allow) return { verdict: 'allowed', code: 0, found };
  return { verdict: 'destructive', code: 1, found };
}

/**
 * The text printed to stdout for a result.
 * @param {GuardResult} result
 * @returns {string}
 */
export function report(result) {
  switch (result.verdict) {
    case 'incomplete':
      return 'guard: the diff is incomplete (no closing line from cdk). Stopping.\n';
    case 'safe':
      return 'guard: nothing is deleted or replaced\n';
    case 'allowed':
      return [
        'guard: these changes delete or replace a resource:',
        ...result.found,
        'guard: allowed by the person who started this run (--allow)',
        '',
      ].join('\n');
    case 'destructive':
      return [
        'guard: these changes delete or replace a resource:',
        ...result.found,
        'guard: stopping. If this is intended, run the workflow by hand on main with allow_replacement ticked.',
        '',
      ].join('\n');
  }
}

/**
 * A markdown `### Guard` section for the GitHub step summary.
 * @param {GuardResult} result
 * @returns {string}
 */
export function summary(result) {
  /** @type {Record<Verdict, string>} */
  const headline = {
    incomplete: '**Stopped:** the diff is incomplete (no closing line from cdk).',
    safe: 'Nothing is deleted or replaced.',
    allowed: '**Allowed by the person who started this run:** these changes delete or replace a resource.',
    destructive:
      '**Stopped:** these changes delete or replace a resource. If this is intended, run the workflow by hand on `main` with `allow_replacement` ticked.',
  };
  const parts = ['### Guard', '', headline[result.verdict], ''];
  if (result.found.length > 0) {
    const body = result.found.join('\n');
    // The fence must be longer than any run of backticks in the lines it holds.
    const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    parts.push(fence, body, fence, '');
  }
  return parts.join('\n') + '\n';
}

/**
 * @param {string[]} args
 * @returns {{ allow: boolean, summaryFile?: string } | { error: string }}
 */
export function parseArgs(args) {
  let allow = false;
  /** @type {string | undefined} */
  let summaryFile;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--allow') {
      allow = true;
    } else if (arg === '--summary') {
      const file = args[i + 1];
      if (file === undefined || file === '' || file.startsWith('--')) return { error: '--summary needs a file' };
      summaryFile = file;
      i++;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return summaryFile === undefined ? { allow } : { allow, summaryFile };
}

/**
 * @param {string[]} args
 * @returns {number} exit code
 */
export function main(args) {
  const parsed = parseArgs(args);
  if ('error' in parsed) {
    process.stderr.write(`guard: ${parsed.error}\nusage: node guard.mjs [--allow] [--summary <file>] < cdk-diff.txt\n`);
    return 2;
  }
  const result = guard(readFileSync(0, 'utf8'), { allow: parsed.allow });
  process.stdout.write(report(result));
  if (parsed.summaryFile !== undefined) appendFileSync(parsed.summaryFile, summary(result));
  return result.code;
}

// Node resolves symlinks for the entry module, so compare against the real path.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
