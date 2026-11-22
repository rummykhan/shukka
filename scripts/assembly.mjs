#!/usr/bin/env node
// Read a synthesized CDK cloud assembly (cdk.out) that the project's own code produced in a job
// without credentials, before shukka's credentialed jobs hand it to shukka's own cdk CLI.
//
// The assembly is untrusted data. cdk-assets runs on the deploy runner with the deploy role's
// credentials, so anything in the assembly that makes it run a command or read outside the
// assembly is refused:
//   - a file asset with `source.executable` (cdk-assets runs that command on the host);
//   - any Docker image asset (it runs `docker build` on the host; v1 has no image-publishing role);
//   - an asset source path, template file, asset manifest file or nested assembly directory that is
//     absolute or climbs out with `..`;
//   - a symbolic link in the assembly whose target lies outside it.
//
// CLI:
//   node scripts/assembly.mjs check <dir>    exit 0: safe; exit 1: refused, one line per problem
//   node scripts/assembly.mjs stacks <dir>   prints the top-level stacks' CloudFormation names, comma-separated
//   exit 2: usage error

import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} path
 * @returns {boolean}
 */
function staysInside(path) {
  return typeof path === 'string' && path !== '' && !isAbsolute(path) && !path.split(/[\\/]/).includes('..');
}

/**
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Every file under dir (no following of links), relative paths.
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  const visit = (/** @type {string} */ rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel === '' ? name : join(rel, name);
      const st = lstatSync(join(dir, path));
      out.push(path);
      if (st.isDirectory()) visit(path);
    }
  };
  visit('');
  return out;
}

/**
 * Problems that make the assembly unsafe to publish and deploy with credentials.
 * @param {string} dir
 * @returns {string[]}
 */
export function checkAssembly(dir) {
  /** @type {string[]} */
  const problems = [];
  let root;
  try {
    root = realpathSync(dir);
    readJson(join(root, 'manifest.json'));
  } catch (error) {
    return [`assembly: cannot read ${dir}/manifest.json: ${/** @type {Error} */ (error).message}`];
  }
  for (const path of walk(root)) {
    const full = join(root, path);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      let target;
      try {
        target = realpathSync(full);
      } catch {
        problems.push(`assembly: ${path} is a broken symbolic link`);
        continue;
      }
      const rel = relative(root, target);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) problems.push(`assembly: ${path} links outside the assembly`);
      continue;
    }
    if (!st.isFile()) continue;
    if (path.endsWith('manifest.json')) {
      let manifest;
      try {
        manifest = readJson(full);
      } catch {
        continue;
      }
      for (const [id, artifact] of Object.entries(manifest.artifacts ?? {})) {
        const props = /** @type {any} */ (artifact)?.properties ?? {};
        for (const key of ['templateFile', 'file', 'directoryName']) {
          if (props[key] !== undefined && !staysInside(props[key])) problems.push(`assembly: ${path}: artifact ${id} ${key} must stay inside the assembly`);
        }
      }
    }
    if (path.endsWith('.assets.json')) {
      let assets;
      try {
        assets = readJson(full);
      } catch (error) {
        problems.push(`assembly: ${path} is not JSON: ${/** @type {Error} */ (error).message}`);
        continue;
      }
      for (const [id, asset] of Object.entries(assets.files ?? {})) {
        const source = /** @type {any} */ (asset)?.source ?? {};
        if (source.executable !== undefined) problems.push(`assembly: ${path}: file asset ${id} is built by running a command (source.executable); refused`);
        if (source.path !== undefined && !staysInside(source.path)) problems.push(`assembly: ${path}: file asset ${id} source path must stay inside the assembly`);
      }
      for (const id of Object.keys(assets.dockerImages ?? {})) {
        problems.push(`assembly: ${path}: Docker image asset ${id} is not supported (it would run docker build with credentials)`);
      }
    }
  }
  return problems;
}

/**
 * The CloudFormation names of the assembly's top-level stacks.
 * @param {string} dir
 * @returns {string[]}
 */
export function stackNames(dir) {
  const { artifacts = {} } = readJson(join(dir, 'manifest.json'));
  return Object.entries(artifacts)
    .filter(([, a]) => /** @type {any} */ (a).type === 'aws:cloudformation:stack')
    .map(([id, a]) => /** @type {any} */ (a).properties?.stackName ?? id);
}

const USAGE = 'usage: node scripts/assembly.mjs check|stacks <dir>';

/**
 * @param {string[]} argv
 * @returns {number}
 */
export function main(argv) {
  const [command, dir, ...rest] = argv;
  if (!dir || rest.length > 0 || (command !== 'check' && command !== 'stacks')) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (command === 'stacks') {
    try {
      process.stdout.write(`${stackNames(dir).join(',')}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`assembly: ${/** @type {Error} */ (error).message}\n`);
      return 1;
    }
  }
  const problems = checkAssembly(dir);
  for (const problem of problems) process.stdout.write(`${problem}\n`);
  if (problems.length === 0) process.stdout.write('assembly: no asset runs a command, no Docker image, nothing outside the assembly\n');
  return problems.length === 0 ? 0 : 1;
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
