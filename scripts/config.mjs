#!/usr/bin/env node
// Load and validate shukka.json, the single config read by the workflows and the CLI.
// The rules live in schema/shukka.schema.json; this file interprets the subset of
// JSON Schema that schema uses, adds the rules a schema cannot say (unique app and
// check names, project-name prefixes), fills defaults and derives role names.
// Every problem line is prefixed and escaped (formatProblem): values reach CI logs.
//
// CLI: node scripts/config.mjs <path> [--json] [--known name1,name2]
//   exit 0: valid (with --json, prints the normalised config)
//   exit 1: invalid, one line per problem on stderr
//   exit 2: usage error

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {{ name: string, dir: string, run: string[], services: string[] }} Check
 * @typedef {{ dir: string, run: string[], bundle: string, env: Record<string, string>, buildEnv: string[] }} Build
 * @typedef {{ configure: string, units: string[], health: string }} Server
 * @typedef {{ name: string, paths: string[], build: Build, server: Server }} App
 * @typedef {{ infra: string, app: string, diff: string }} DerivedNames
 * @typedef {{
 *   project: string,
 *   qualifier: string,
 *   aws: { account: string, region: string, deployBucket: string },
 *   node: string,
 *   checks: Check[],
 *   infra: { dir: string, paths: string[] },
 *   apps: App[],
 *   smoke: { run: string } | null,
 *   alwaysDeploy: boolean,
 *   derived: DerivedNames,
 * }} Config
 * @typedef {{ config: Config | null, problems: string[] }} Result
 * @typedef {{ knownProjects?: string[] }} Options
 * @typedef {Record<string, any>} Schema
 */

const DEFAULT_NODE = '22';

/** Every problem line starts with this, so none begins with text from the file. */
export const PROBLEM_PREFIX = 'shukka.json: ';

/**
 * Make a problem safe to print in a CI log: one line, prefixed, control characters
 * escaped and `::` broken up, so text from the file can never form a workflow command.
 * @param {string} problem
 * @returns {string}
 */
export function formatProblem(problem) {
  const oneLine = problem.replace(
    // eslint-disable-next-line no-control-regex -- finding control characters is the point
    /[\u0000-\u001f\u007f\u2028\u2029]/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `${PROBLEM_PREFIX}${oneLine.replace(/:(?=:)/g, ': ')}`;
}

/** @type {Schema} */
export const schema = JSON.parse(
  readFileSync(new URL('../schema/shukka.schema.json', import.meta.url), 'utf8'),
);

/**
 * Role (and role-named stack) names for a project. Derived, never written in shukka.json.
 * @param {string} project
 * @returns {DerivedNames}
 */
export function derivedNames(project) {
  return {
    infra: `${project}-shukka-infra`,
    app: `${project}-shukka-app`,
    diff: `${project}-shukka-diff`,
  };
}

/**
 * The fence is a name prefix, so no project name may be a prefix of another's.
 * @param {string} project
 * @param {string[]} knownProjects
 * @returns {string[]}
 */
export function checkProjectName(project, knownProjects) {
  /** @type {string[]} */
  const problems = [];
  for (const known of knownProjects) {
    if (known === project) continue;
    if (known.startsWith(project)) {
      problems.push(`project: "${project}" is a prefix of known project "${known}"`);
    } else if (project.startsWith(known)) {
      problems.push(`project: known project "${known}" is a prefix of "${project}"`);
    }
  }
  return problems;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

/**
 * @param {string} path
 * @param {string} key
 * @returns {string}
 */
function child(path, key) {
  return path ? `${path}.${key}` : key;
}

/**
 * @param {string} ref
 * @returns {Schema}
 */
function resolveRef(ref) {
  const prefix = '#/definitions/';
  const name = ref.slice(prefix.length);
  const definitions = schema.definitions ?? {};
  const target = ref.startsWith(prefix) && Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  if (!target) throw new Error(`schema: unresolved $ref ${ref}`);
  return target;
}

/**
 * Check a value against the JSON Schema subset used by shukka.schema.json.
 * @param {unknown} value
 * @param {Schema} node
 * @param {string} path
 * @param {string[]} problems
 */
function check(value, node, path, problems) {
  if (node.$ref) {
    check(value, resolveRef(node.$ref), path, problems);
    return;
  }
  const at = path || '(root)';
  if (node.type) {
    const actual = typeOf(value);
    const ok = actual === node.type || (node.type === 'number' && actual === 'integer');
    if (!ok) {
      problems.push(`${at}: expected ${node.type}, got ${actual}`);
      return;
    }
  }
  if (node.allOf) {
    for (const sub of node.allOf) check(value, sub, path, problems);
  }
  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) {
      problems.push(`${at}: must not be empty`);
    }
    if (node.pattern !== undefined && !new RegExp(node.pattern, 'u').test(value)) {
      problems.push(`${at}: ${JSON.stringify(value)} does not match ${node.pattern}`);
    }
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      problems.push(`${at}: needs at least ${node.minItems} item${node.minItems === 1 ? '' : 's'}`);
    }
    if (node.items) {
      value.forEach((item, i) => check(item, node.items, `${path}[${i}]`, problems));
    }
  }
  if (typeOf(value) === 'object') {
    const object = /** @type {Record<string, unknown>} */ (value);
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(object, key)) problems.push(`${at}: missing required key "${key}"`);
    }
    const properties = node.properties ?? {};
    for (const [key, item] of Object.entries(object)) {
      if (node.propertyNames) check(key, node.propertyNames, `${child(path, key)} (name)`, problems);
      if (Object.hasOwn(properties, key)) {
        check(item, properties[key], child(path, key), problems);
      } else if (node.additionalProperties === false) {
        problems.push(`${child(path, key)}: unknown key`);
      } else if (typeof node.additionalProperties === 'object') {
        check(item, node.additionalProperties, child(path, key), problems);
      }
    }
  }
}

/**
 * Names in `items` that appear more than once, each reported at its later position.
 * @param {unknown} items
 * @param {string} path
 * @param {string} noun
 * @param {string[]} problems
 */
function checkUnique(items, path, noun, problems) {
  if (!Array.isArray(items)) return;
  /** @type {Set<string>} */
  const seen = new Set();
  items.forEach((item, i) => {
    const name = item && typeof item === 'object' ? item.name : undefined;
    if (typeof name !== 'string') return;
    if (seen.has(name)) problems.push(`${path}[${i}].name: duplicate ${noun} name "${name}"`);
    seen.add(name);
  });
}

/**
 * @param {Record<string, any>} raw a value that passed validation
 * @returns {Config}
 */
function normalise(raw) {
  return {
    project: raw.project,
    qualifier: raw.qualifier,
    aws: {
      account: raw.aws.account,
      region: raw.aws.region,
      deployBucket: raw.aws.deployBucket ?? `${raw.project}-deploy-${raw.aws.account}`,
    },
    node: raw.node ?? DEFAULT_NODE,
    checks: (raw.checks ?? []).map((/** @type {Record<string, any>} */ c) => ({
      name: c.name,
      dir: c.dir,
      run: [...c.run],
      services: [...(c.services ?? [])],
    })),
    infra: { dir: raw.infra.dir, paths: [...raw.infra.paths] },
    apps: raw.apps.map((/** @type {Record<string, any>} */ a) => ({
      name: a.name,
      paths: [...a.paths],
      build: {
        dir: a.build.dir,
        run: [...a.build.run],
        bundle: a.build.bundle,
        env: { ...(a.build.env ?? {}) },
        buildEnv: [...(a.build.buildEnv ?? [])],
      },
      server: {
        configure: a.server.configure,
        units: [...a.server.units],
        health: a.server.health,
      },
    })),
    smoke: raw.smoke ? { run: raw.smoke.run } : null,
    alwaysDeploy: raw.alwaysDeploy ?? false,
    derived: derivedNames(raw.project),
  };
}

/**
 * Validate a parsed shukka.json.
 * @param {unknown} raw
 * @param {Options} [options]
 * @returns {Result}
 */
export function validateConfig(raw, options = {}) {
  /** @type {string[]} */
  const problems = [];
  check(raw, schema, '', problems);
  if (typeOf(raw) === 'object') {
    const object = /** @type {Record<string, unknown>} */ (raw);
    checkUnique(object.apps, 'apps', 'app', problems);
    checkUnique(object.checks, 'checks', 'check', problems);
    if (options.knownProjects && typeof object.project === 'string') {
      problems.push(...checkProjectName(object.project, options.knownProjects));
    }
  }
  if (problems.length > 0) return { config: null, problems: problems.map(formatProblem) };
  return { config: normalise(/** @type {Record<string, any>} */ (raw)), problems };
}

/**
 * Read and validate a shukka.json file.
 * @param {string} path
 * @param {Options} [options]
 * @returns {Result}
 */
export function loadConfig(path, options = {}) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { config: null, problems: [formatProblem(`cannot read ${path}: ${/** @type {Error} */ (error).message}`)] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { config: null, problems: [formatProblem(`not valid JSON: ${/** @type {Error} */ (error).message.split('\n')[0]}`)] };
  }
  return validateConfig(raw, options);
}

const USAGE = 'usage: node scripts/config.mjs <path> [--json] [--known name1,name2]';

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  /** @type {string | undefined} */
  let path;
  let json = false;
  /** @type {string[] | undefined} */
  let knownProjects;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--known') {
      const list = argv[++i];
      if (list === undefined) {
        process.stderr.write(`${USAGE}\n`);
        return 2;
      }
      knownProjects = list.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === undefined || arg.startsWith('-') || path !== undefined) {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    } else {
      path = arg;
    }
  }
  if (path === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const { config, problems } = loadConfig(path, knownProjects ? { knownProjects } : {});
  if (!config) {
    for (const problem of problems) process.stderr.write(`${problem.replace(/\s*\n\s*/g, ' ')}\n`);
    return 1;
  }
  if (json) process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  return 0;
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
