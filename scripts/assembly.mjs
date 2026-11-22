#!/usr/bin/env node
// Read a synthesized CDK cloud assembly (cdk.out) that the project's own code produced in a job
// without credentials, before shukka's credentialed jobs hand it to shukka's own cdk CLI.
//
// The assembly is untrusted data. cdk-assets runs on the deploy runner with the deploy role's
// credentials, so anything in the assembly that makes it run a command or read outside the
// assembly is refused. Asset manifests are found through every manifest.json (top level and
// nested assemblies: each `cdk:asset-manifest` artifact's `properties.file`, whatever its name), and
// every JSON file in the assembly with `files` or `dockerImages` is checked the same way:
//   - a file asset with `source.executable` (cdk-assets runs that command on the host);
//   - any Docker image asset (it runs `docker build` on the host; v1 has no image-publishing role);
//   - a stack carrying legacy `aws:cdk:asset` metadata (assets the CLI builds itself);
//   - an asset source path, template file, asset manifest file, nested assembly directory or a
//     template's `aws:asset:path` metadata that is absolute or climbs out with `..`;
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
 * The asset checks for one parsed asset manifest (or any JSON carrying `files` or `dockerImages`).
 * @param {any} assets
 * @param {string} where
 * @param {string[]} problems
 */
function checkAssets(assets, where, problems) {
  if (!assets || typeof assets !== 'object') return;
  const files = assets.files;
  if (files && typeof files === 'object') {
    for (const [id, asset] of Object.entries(files)) {
      const source = /** @type {any} */ (asset)?.source ?? {};
      if (source.executable !== undefined) problems.push(`assembly: ${where}: file asset ${id} is built by running a command (source.executable); refused`);
      if (source.path !== undefined && !staysInside(source.path)) problems.push(`assembly: ${where}: file asset ${id} source path must stay inside the assembly`);
    }
  }
  const images = assets.dockerImages;
  if (images && typeof images === 'object') {
    for (const id of Object.keys(images)) {
      problems.push(`assembly: ${where}: Docker image asset ${id} is not supported (it would run docker build with credentials)`);
    }
  }
}

/**
 * `aws:asset:path` in a template's resource metadata (what `sam local` and the CLI read) must stay inside.
 * @param {any} template
 * @param {string} where
 * @param {string[]} problems
 */
function checkTemplate(template, where, problems) {
  const resources = template?.Resources;
  if (!resources || typeof resources !== 'object') return;
  for (const [id, resource] of Object.entries(resources)) {
    const path = /** @type {any} */ (resource)?.Metadata?.['aws:asset:path'];
    if (path !== undefined && !staysInside(path)) problems.push(`assembly: ${where}: resource ${id} aws:asset:path must stay inside the assembly`);
  }
}

/**
 * A path named in a manifest, resolved against the manifest's directory, still inside the assembly root.
 * @param {string} root
 * @param {string} base directory of the manifest, relative to root
 * @param {unknown} path
 * @returns {string | null} the path relative to root, or null when it leaves
 */
function inside(root, base, path) {
  if (typeof path !== 'string' || !staysInside(path)) return null;
  const rel = relative(root, join(root, base, path));
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel;
}

/**
 * Problems that make the assembly unsafe to publish and deploy with credentials.
 * Asset manifests are found by what the manifests say (any `cdk:asset-manifest` artifact's
 * `properties.file`), never by file name; and every JSON file in the assembly that carries `files`
 * or `dockerImages` is checked as an asset manifest too.
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

  // Every file: links that leave, and every JSON document (asset manifests under any name, templates).
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
    if (!st.isFile() || st.size > 50 * 1024 * 1024) continue;
    let doc;
    try {
      const text = readFileSync(full, 'utf8');
      if (!/^\s*\{/.test(text)) continue;
      doc = JSON.parse(text);
    } catch {
      continue;
    }
    checkAssets(doc, path, problems);
    checkTemplate(doc, path, problems);
  }

  // Every manifest reachable from the top one, through nested assemblies.
  /** @type {string[]} */
  const queue = [''];
  const seen = new Set();
  while (queue.length > 0) {
    const base = /** @type {string} */ (queue.shift());
    if (seen.has(base)) continue;
    seen.add(base);
    const where = base === '' ? 'manifest.json' : join(base, 'manifest.json');
    let manifest;
    try {
      manifest = readJson(join(root, base, 'manifest.json'));
    } catch (error) {
      problems.push(`assembly: cannot read ${where}: ${/** @type {Error} */ (error).message}`);
      continue;
    }
    for (const [id, artifact] of Object.entries(manifest?.artifacts ?? {})) {
      const a = /** @type {any} */ (artifact) ?? {};
      const props = a.properties ?? {};
      for (const key of ['templateFile', 'file', 'directoryName']) {
        if (props[key] !== undefined && inside(root, base, props[key]) === null) problems.push(`assembly: ${where}: artifact ${id} ${key} must stay inside the assembly`);
      }
      if (a.type === 'cdk:asset-manifest') {
        const file = inside(root, base, props.file);
        if (file === null) {
          if (props.file === undefined) problems.push(`assembly: ${where}: asset manifest ${id} names no file`);
          continue;
        }
        try {
          checkAssets(readJson(join(root, file)), file, problems);
        } catch (error) {
          problems.push(`assembly: ${where}: asset manifest ${id} (${file}) cannot be read: ${/** @type {Error} */ (error).message}`);
        }
      }
      if (a.type === 'cdk:cloud-assembly') {
        const nested = inside(root, base, props.directoryName);
        if (nested !== null) queue.push(nested);
      }
      if (a.type === 'aws:cloudformation:stack') {
        for (const [path, entries] of Object.entries(a.metadata ?? {})) {
          if (Array.isArray(entries) && entries.some((e) => e?.type === 'aws:cdk:asset')) {
            problems.push(`assembly: ${where}: stack ${id} carries legacy asset metadata (aws:cdk:asset at ${path}); refused`);
          }
        }
      }
    }
  }
  return [...new Set(problems)];
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
