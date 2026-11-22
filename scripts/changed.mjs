#!/usr/bin/env node
// What changed since the last deployed commit (design D7). The last deployed revisions are
// read from AWS, never from the push event: the `shukka:revision` tag on each of the
// project's CloudFormation stacks, and each app's `current/REVISION` on the servers tagged
// Project=<project>, read through SSM Run Command. A part whose last revision is unknown
// (first deploy, missing tag, unreachable server, a commit not in this checkout) is changed.
//
// CLI: node scripts/changed.mjs <shukka.json> [--force] [--head <ref>] [--repo <dir>] [--stacks a,b]
//   prints {"infra": bool, "apps": {"<name>": bool}, "base": {"infra": sha|null, "apps": {"<name>": sha|null}}}
//   exit 0: printed; exit 1: config invalid or git failed; exit 2: usage error
//   --stacks names the project's stacks instead of listing every stack whose name starts with the project
//
// The config's globs are matched only against the git-relative names printed by
// `git diff --name-only`; they are never expanded on the filesystem.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { GetCommandInvocationCommand, SSMClient, SendCommandCommand } from '@aws-sdk/client-ssm';
import { loadConfig } from './config.mjs';

/**
 * @typedef {import('./config.mjs').Config} Config
 * @typedef {{ send: (command: any) => Promise<any> }} Client
 * @typedef {{ cfn: Client, ec2: Client, ssm: Client }} Clients
 * @typedef {{ infra: boolean, apps: Record<string, boolean>, base: { infra: string | null, apps: Record<string, string | null> } }} Changes
 * @typedef {(string | null)[]} Revisions one entry per stack or server; null where it could not be read
 * @typedef {{ sleep?: (ms: number) => Promise<void>, timeoutMs?: number, intervalMs?: number }} Wait
 * @typedef {{
 *   config: Config,
 *   repo: string,
 *   head?: string,
 *   force?: boolean,
 *   stacks?: string[],
 *   clients: Clients,
 *   wait?: Wait,
 *   warn?: (line: string) => void,
 * }} Options
 */

export const REVISION_TAG = 'shukka:revision';
const SHA = /^[0-9a-f]{7,40}$/;
const RUNNING = new Set(['Pending', 'InProgress', 'Delayed']);

/**
 * A path glob as used in shukka.json: `**` crosses directories, `*` and `?` stay inside one
 * path segment, a trailing `/**` also matches the directory's contents at any depth,
 * `{a,b}` is alternation (nestable), `[abc]`, `[a-z]` and `[!abc]` (or `[^abc]`) are
 * character classes that never match `/`. A stray `]`, `}` or `,` is a literal character.
 * Throws on a pattern it cannot parse (an unclosed `[` or `{`, a reversed range).
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  const { source, pos } = parseGlob(glob, 0, false);
  if (pos !== glob.length) throw new Error(`glob ${JSON.stringify(glob)}: unexpected ${JSON.stringify(glob[pos])}`);
  try {
    return new RegExp(`^${source}$`, 'u');
  } catch (error) {
    throw new Error(`glob ${JSON.stringify(glob)}: ${/** @type {Error} */ (error).message}`, { cause: error });
  }
}

/** @param {string} c */
const escapeLiteral = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Parse a run of the glob from `pos`. Inside braces it stops before a `,` or `}`.
 * @param {string} glob
 * @param {number} pos
 * @param {boolean} inBrace
 * @returns {{ source: string, pos: number }}
 */
function parseGlob(glob, pos, inBrace) {
  let source = '';
  let i = pos;
  while (i < glob.length) {
    const c = /** @type {string} */ (glob[i]);
    if (inBrace && (c === ',' || c === '}')) break;
    if (c === '*' && glob[i + 1] === '*') {
      i += 2;
      if (glob[i] === '/') {
        i++;
        source += '(?:.*/)?';
      } else {
        source += '.*';
      }
    } else if (c === '*') {
      source += '[^/]*';
      i++;
    } else if (c === '?') {
      source += '[^/]';
      i++;
    } else if (c === '[') {
      let j = i + 1;
      const negated = glob[j] === '!' || glob[j] === '^';
      if (negated) j++;
      const first = j;
      // A `]` right after the opening (or after `!`) is a member, as in POSIX.
      if (glob[j] === ']') j++;
      while (j < glob.length && glob[j] !== ']') j++;
      if (j >= glob.length) throw new Error(`glob ${JSON.stringify(glob)}: unclosed [`);
      const members = [...glob.slice(first, j)]
        .map((m, k, all) => (m === '-' ? (k > 0 && k < all.length - 1 ? '-' : '\\-') : escapeLiteral(m)))
        .join('');
      source += negated ? `[^/${members}]` : `(?!/)[${members}]`;
      i = j + 1;
    } else if (c === '{') {
      /** @type {string[]} */
      const alternatives = [];
      let j = i + 1;
      for (;;) {
        const part = parseGlob(glob, j, true);
        alternatives.push(part.source);
        j = part.pos;
        if (j >= glob.length) throw new Error(`glob ${JSON.stringify(glob)}: unclosed {`);
        j++;
        if (glob[j - 1] === '}') break;
      }
      source += `(?:${alternatives.join('|')})`;
      i = j;
    } else {
      source += escapeLiteral(c);
      i++;
    }
  }
  return { source, pos: i };
}

/**
 * Whether a path matches any glob. A glob that cannot be parsed counts as matching, with a
 * warning: an unreadable pattern must make its part deploy, never skip it.
 * @param {string} path a repository-relative path with forward slashes
 * @param {string[]} globs
 * @param {(line: string) => void} [warn]
 * @returns {boolean}
 */
export function matchesAny(path, globs, warn = () => {}) {
  return globs.some((glob) => {
    try {
      return globToRegExp(glob).test(path);
    } catch (error) {
      warn(`${/** @type {Error} */ (error).message}; treating it as matching`);
      return true;
    }
  });
}

/**
 * @param {string} repo
 * @param {string[]} args
 * @returns {string}
 */
function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * @param {string} repo
 * @param {string} sha
 * @returns {boolean}
 */
function isCommit(repo, sha) {
  try {
    git(repo, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} repo
 * @param {string} ancestor
 * @param {string} descendant
 * @returns {boolean}
 */
function isAncestor(repo, ancestor, descendant) {
  try {
    git(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Paths that differ between two commits (renames listed under both names).
 * @param {string} repo
 * @param {string} base
 * @param {string} head
 * @returns {string[]}
 */
export function changedPaths(repo, base, head) {
  return git(repo, ['diff', '--name-only', '--no-renames', '-z', base, head, '--'])
    .split('\0')
    .filter(Boolean);
}

/**
 * Decide one part. Every revision must be known and present in the checkout; the part is
 * changed when the diff from any of them touches its globs. The base reported is the
 * oldest revision (one that is an ancestor of the others), else the first.
 * @param {string} repo
 * @param {string} head
 * @param {Revisions} revisions
 * @param {string[]} globs
 * @param {string} label
 * @param {(line: string) => void} warn
 * @returns {{ changed: boolean, base: string | null }}
 */
export function decidePart(repo, head, revisions, globs, label, warn) {
  if (revisions.length === 0) {
    warn(`${label}: no last deployed revision found; treating as changed`);
    return { changed: true, base: null };
  }
  const distinct = [...new Set(revisions)];
  for (const revision of distinct) {
    if (revision === null) {
      warn(`${label}: last deployed revision unknown; treating as changed`);
      return { changed: true, base: null };
    }
    if (!SHA.test(revision) || !isCommit(repo, revision)) {
      warn(`${label}: last deployed revision ${JSON.stringify(revision)} is not a commit in this checkout; treating as changed`);
      return { changed: true, base: null };
    }
  }
  const shas = /** @type {string[]} */ (distinct);
  const changed = shas.some((sha) => changedPaths(repo, sha, head).some((path) => matchesAny(path, globs, (line) => warn(`${label}: ${line}`))));
  const base = shas.find((sha) => shas.every((other) => other === sha || isAncestor(repo, sha, other))) ?? shas[0];
  return { changed, base: base ?? null };
}

/**
 * The `shukka:revision` tag of each of the project's stacks; null for a stack without it.
 * Without `stacks`, the project's stacks are every stack whose name starts with the project
 * name (any case), the same prefix the fence uses.
 * @param {Client} cfn
 * @param {string} project
 * @param {string[]} [stacks]
 * @returns {Promise<Revisions>}
 */
export async function readStackRevisions(cfn, project, stacks) {
  /** @type {any[]} */
  const found = [];
  if (stacks) {
    for (const name of stacks) {
      try {
        const out = await cfn.send(new DescribeStacksCommand({ StackName: name }));
        found.push(...(out.Stacks ?? []));
      } catch {
        found.push({ StackName: name, Tags: [] });
      }
    }
  } else {
    /** @type {string | undefined} */
    let token;
    do {
      const out = await cfn.send(new DescribeStacksCommand(token ? { NextToken: token } : {}));
      const prefix = project.toLowerCase();
      found.push(...(out.Stacks ?? []).filter((/** @type {any} */ s) => String(s.StackName ?? '').toLowerCase().startsWith(prefix)));
      token = out.NextToken;
    } while (token);
  }
  return found.map((stack) => {
    const tag = (stack.Tags ?? []).find((/** @type {any} */ t) => t.Key === REVISION_TAG);
    return typeof tag?.Value === 'string' && tag.Value !== '' ? tag.Value : null;
  });
}

/**
 * The shell run on each server: one line per app, `<app>\t<contents of current/REVISION>`.
 * Project and app names are validated by the config schema (lowercase, digits, hyphens).
 * @param {string} project
 * @param {string[]} apps
 * @returns {string}
 */
export function revisionScript(project, apps) {
  return apps
    .map((app) => `printf '%s\\t%s\\n' '${app}' "$(cat '/opt/${project}/${app}/current/REVISION' 2>/dev/null | head -n 1)"`)
    .join('\n');
}

/**
 * Each app's `current/REVISION` on every running instance tagged Project=<project>. An app
 * gets an empty list when there is no instance, and null entries where an instance did not
 * answer or has no REVISION.
 * @param {Client} ec2
 * @param {Client} ssm
 * @param {string} project
 * @param {string[]} apps
 * @param {Wait} [wait]
 * @param {(line: string) => void} [warn]
 * @returns {Promise<Record<string, Revisions>>}
 */
export async function readAppRevisions(ec2, ssm, project, apps, wait = {}, warn = () => {}) {
  const sleep = wait.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = wait.timeoutMs ?? 60_000;
  const intervalMs = wait.intervalMs ?? 2_000;
  /** @type {Record<string, Revisions>} */
  const result = Object.fromEntries(apps.map((app) => [app, []]));
  /** @param {string} why */
  const unknownEverywhere = (why) => {
    warn(`servers: ${why}`);
    for (const app of apps) result[app] = [null];
    return result;
  };

  /** @type {string[]} */
  const instances = [];
  try {
    /** @type {string | undefined} */
    let token;
    do {
      const out = await ec2.send(new DescribeInstancesCommand({
        Filters: [
          { Name: `tag:Project`, Values: [project] },
          { Name: 'instance-state-name', Values: ['running'] },
        ],
        ...(token ? { NextToken: token } : {}),
      }));
      for (const reservation of out.Reservations ?? []) {
        for (const instance of reservation.Instances ?? []) {
          if (instance.InstanceId) instances.push(instance.InstanceId);
        }
      }
      token = out.NextToken;
    } while (token);
  } catch (error) {
    return unknownEverywhere(`cannot list instances: ${/** @type {Error} */ (error).message}`);
  }
  if (instances.length === 0) {
    warn(`servers: no running instance tagged Project=${project}`);
    return result;
  }

  let commandId;
  try {
    const out = await ssm.send(new SendCommandCommand({
      DocumentName: 'AWS-RunShellScript',
      InstanceIds: instances,
      Parameters: { commands: [revisionScript(project, apps)] },
      TimeoutSeconds: Math.max(30, Math.ceil(timeoutMs / 1000)),
      Comment: `shukka: read ${project} revisions`,
    }));
    commandId = out.Command?.CommandId;
  } catch (error) {
    return unknownEverywhere(`cannot send the revision command: ${/** @type {Error} */ (error).message}`);
  }
  if (!commandId) return unknownEverywhere('SendCommand returned no command id');

  // One deadline for all instances, so a slow fleet waits timeoutMs in total, not per instance.
  let waited = 0;
  for (const instance of instances) {
    /** @type {string | null} */
    let output = null;
    for (;;) {
      let status = 'Pending';
      try {
        const out = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instance }));
        status = out.Status ?? 'Pending';
        if (status === 'Success') output = out.StandardOutputContent ?? '';
      } catch (error) {
        // Right after SendCommand the invocation may not exist yet; anything else is fatal for this instance.
        if (/** @type {Error} */ (error).name !== 'InvocationDoesNotExist') status = 'Failed';
      }
      if (!RUNNING.has(status)) {
        if (status !== 'Success') warn(`servers: ${instance} did not answer (${status})`);
        break;
      }
      if (waited >= timeoutMs) {
        warn(`servers: ${instance} timed out`);
        break;
      }
      await sleep(intervalMs);
      waited += intervalMs;
    }
    /** @type {Map<string, string>} */
    const lines = new Map();
    for (const line of (output ?? '').split('\n')) {
      const tab = line.indexOf('\t');
      if (tab > 0) lines.set(line.slice(0, tab), line.slice(tab + 1).trim());
    }
    for (const app of apps) {
      const value = output === null ? '' : (lines.get(app) ?? '');
      /** @type {Revisions} */ (result[app]).push(value === '' ? null : value);
    }
  }
  return result;
}

/**
 * @param {Config} config
 * @param {boolean} value
 * @returns {Changes}
 */
function everything(config, value) {
  return {
    infra: value,
    apps: Object.fromEntries(config.apps.map((a) => [a.name, value])),
    base: { infra: null, apps: Object.fromEntries(config.apps.map((a) => [a.name, null])) },
  };
}

/**
 * @param {Options} options
 * @returns {Promise<Changes>}
 */
export async function computeChanges(options) {
  const { config, repo, clients } = options;
  const warn = options.warn ?? (() => {});
  if (options.force || config.alwaysDeploy) {
    warn(options.force ? 'forced: every part deploys' : 'alwaysDeploy: every part deploys');
    return everything(config, true);
  }
  const head = git(repo, ['rev-parse', '--verify', '--end-of-options', `${options.head ?? 'HEAD'}^{commit}`]).trim();

  /** @type {Revisions} */
  let stackRevisions;
  try {
    stackRevisions = await readStackRevisions(clients.cfn, config.project, options.stacks);
  } catch (error) {
    warn(`stacks: cannot read: ${/** @type {Error} */ (error).message}`);
    stackRevisions = [null];
  }
  const appRevisions = await readAppRevisions(
    clients.ec2, clients.ssm, config.project, config.apps.map((a) => a.name), options.wait, warn,
  );

  const infra = decidePart(repo, head, stackRevisions, config.infra.paths, 'infra', warn);
  /** @type {Changes} */
  const changes = { infra: infra.changed, apps: {}, base: { infra: infra.base, apps: {} } };
  for (const app of config.apps) {
    const part = decidePart(repo, head, appRevisions[app.name] ?? [], app.paths, `app ${app.name}`, warn);
    changes.apps[app.name] = part.changed;
    changes.base.apps[app.name] = part.base;
  }
  return changes;
}

/** @returns {Clients} */
function defaultClients() {
  return { cfn: new CloudFormationClient({}), ec2: new EC2Client({}), ssm: new SSMClient({}) };
}

const USAGE = 'usage: node scripts/changed.mjs <shukka.json> [--force] [--head <ref>] [--repo <dir>] [--stacks a,b]';

/**
 * @param {string[]} argv
 * @param {{ clients?: Clients, out?: (text: string) => void, err?: (text: string) => void, wait?: Wait }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const out = deps.out ?? ((text) => process.stdout.write(text));
  const err = deps.err ?? ((text) => process.stderr.write(text));
  /** @type {string | undefined} */
  let path;
  /** @type {string | undefined} */
  let head;
  /** @type {string | undefined} */
  let repo;
  /** @type {string[] | undefined} */
  let stacks;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') {
      force = true;
    } else if (arg === '--head' || arg === '--repo' || arg === '--stacks') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('-')) {
        err(`${USAGE}\n`);
        return 2;
      }
      if (arg === '--head') head = value;
      else if (arg === '--repo') repo = value;
      else stacks = value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === undefined || arg.startsWith('-') || path !== undefined) {
      err(`${USAGE}\n`);
      return 2;
    } else {
      path = arg;
    }
  }
  if (path === undefined) {
    err(`${USAGE}\n`);
    return 2;
  }
  const { config, problems } = loadConfig(path);
  if (!config) {
    for (const problem of problems) err(`${problem.replace(/\s*\n\s*/g, ' ')}\n`);
    return 1;
  }
  try {
    const changes = await computeChanges({
      config,
      repo: resolve(repo ?? dirname(resolve(path))),
      force,
      clients: deps.clients ?? defaultClients(),
      warn: (line) => err(`changed: ${line}\n`),
      ...(head !== undefined ? { head } : {}),
      ...(stacks !== undefined ? { stacks } : {}),
      ...(deps.wait ? { wait: deps.wait } : {}),
    });
    out(`${JSON.stringify(changes)}\n`);
    return 0;
  } catch (error) {
    err(`changed: ${/** @type {Error} */ (error).message.split('\n')[0]}\n`);
    return 1;
  }
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
