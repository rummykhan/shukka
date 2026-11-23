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
// The templates CloudFormation is given (deployedTemplates, which policy-guard.mjs reads too) must be the ones
// checked: cdk deploys the file asset that a stack's stackTemplateAssetObjectUrl names, not templateFile, so
//   - that URL must name file assets (bucket and key) whose source is the stack's own templateFile;
//   - two file assets published to one bucket and key must have the same source;
//   - a stack template, and any file asset ending .json, .yaml, .yml or .template, must be a JSON object.
// Stack artifacts (in every manifest) also name things the deploy step hands to cdk on its command line, so
// none of them may be read as an option or break a line of GITHUB_OUTPUT:
//   - an id or displayName (the stack selector) not matching SELECTOR;
//   - a stackName (or, without one, the id) not matching STACK_NAME;
//   - tags that are not an object of strings, or a key or value that starts with -, breaks CloudFormation's
//     tag rules (key 1-128 characters, not aws:..., value at most 256, letters, digits, spaces and _ . : / = + - @)
//     or, for a key, contains = (cdk splits --tags=k=v at the first =).
//
// With --project (the workflows and `shukka deploy` always pass it), every stack must also deploy through the
// project's bootstrap (a deploy role and an execution role in its manifest entry): only the top-level stack named
// <Project>-Ci may name neither (shukkaCiSynthesizer: deployed by hand with admin credentials, never by the pipeline;
// deployCommands leaves it out).
//
// CLI:
//   node scripts/assembly.mjs check <dir> [--project <name>]
//                                            exit 0: safe; exit 1: refused, one line per problem
//   node scripts/assembly.mjs stacks <dir>   prints the top-level stacks' CloudFormation names, comma-separated;
//                                            exit 1, printing nothing, when any is not a valid stack name
//   exit 2: usage error

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What a stack's id or displayName must look like to be passed to cdk as a stack selector. */
export const SELECTOR = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;
/** A CloudFormation stack name. */
export const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
// CloudFormation's tag characters, with only plain spaces (no line or paragraph separators).
const TAG_CHARS = /^[\p{L}\p{Zs}\p{N}_.:/=+\-@]*$/u;

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
 * Problems with a stack's synthesized tags (`properties.tags`), which the deploy step passes as --tags=k=v.
 * @param {unknown} tags
 * @param {string} where
 * @param {string} id
 * @returns {string[]}
 */
export function tagProblems(tags, where, id) {
  if (tags === undefined) return [];
  const at = `assembly: ${where}: stack ${id}`;
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return [`${at}: tags must be an object of strings`];
  /** @type {string[]} */
  const problems = [];
  for (const [key, value] of Object.entries(tags)) {
    const k = JSON.stringify(key);
    const length = [...key].length;
    if (length < 1 || length > 128) problems.push(`${at}: tag key ${k} must be 1 to 128 characters`);
    if (key.startsWith('-')) problems.push(`${at}: tag key ${k} starts with -`);
    if (/^aws:/i.test(key)) problems.push(`${at}: tag key ${k} uses the reserved aws: prefix`);
    if (key.includes('=')) problems.push(`${at}: tag key ${k} contains =`);
    if (!TAG_CHARS.test(key)) problems.push(`${at}: tag key ${k} has characters CloudFormation tags do not allow`);
    if (typeof value !== 'string') {
      problems.push(`${at}: tag ${key} value ${JSON.stringify(value)} is not a string`);
      continue;
    }
    const v = JSON.stringify(value);
    if ([...value].length > 256) problems.push(`${at}: tag ${key} value ${v} must be at most 256 characters`);
    if (value.startsWith('-')) problems.push(`${at}: tag ${key} value ${v} starts with -`);
    if (!TAG_CHARS.test(value)) problems.push(`${at}: tag ${key} value ${v} has characters CloudFormation tags do not allow`);
  }
  return problems;
}

/**
 * Problems with the names a stack artifact gives cdk and GITHUB_OUTPUT: its selector (id, displayName), its
 * CloudFormation name and its tags.
 * @param {string} id
 * @param {any} artifact
 * @param {string} where
 * @returns {string[]}
 */
export function stackProblems(id, artifact, where) {
  const at = `assembly: ${where}: stack ${JSON.stringify(id)}`;
  /** @type {string[]} */
  const problems = [];
  if (!SELECTOR.test(id)) problems.push(`${at} is not a stack selector (${SELECTOR.source})`);
  const name = `assembly: ${where}: stack ${SELECTOR.test(id) ? id : JSON.stringify(id)}`;
  const display = artifact?.displayName;
  if (display !== undefined && (typeof display !== 'string' || !SELECTOR.test(display))) {
    problems.push(`${name} displayName ${JSON.stringify(display)} is not a stack selector (${SELECTOR.source})`);
  }
  const stackName = artifact?.properties?.stackName;
  if (stackName !== undefined) {
    if (typeof stackName !== 'string' || !STACK_NAME.test(stackName)) problems.push(`${name} stackName ${JSON.stringify(stackName)} is not a CloudFormation stack name (${STACK_NAME.source})`);
  } else if (!STACK_NAME.test(id)) {
    problems.push(`${name} has no stackName and its id is not a CloudFormation stack name (${STACK_NAME.source})`);
  }
  problems.push(...tagProblems(artifact?.properties?.tags, where, SELECTOR.test(id) ? id : JSON.stringify(id)));
  return problems;
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
 * The name of a project's CI stack, the one holding ShukkaAccess: `<Project>-Ci` (the project name capitalised, as
 * ShukkaAccess names its stacks' prefix). It is deployed by hand with admin credentials (lib/synthesizer.ts
 * shukkaCiSynthesizer), never by the pipeline or `shukka deploy`.
 * @param {string} project
 * @returns {string}
 */
export function ciStackName(project) {
  return `${project.charAt(0).toUpperCase()}${project.slice(1)}-Ci`;
}

/**
 * A stack's CloudFormation name: its stackName, or its artifact id.
 * @param {string} id
 * @param {any} artifact
 * @returns {string}
 */
function cfnName(id, artifact) {
  return artifact?.properties?.stackName ?? id;
}

/**
 * Problems with how a stack deploys. Every stack deploys through the project's bootstrap: cdk assumes a deploy role
 * and CloudFormation runs as the execution role (shukkaSynthesizer). The one exception is the top-level stack named
 * `<project's>-Ci`, which may name neither (shukkaCiSynthesizer: an admin deploys it by hand with their own
 * credentials); the pipeline and `shukka deploy` leave it out (deployCommands).
 * @param {string} id
 * @param {any} artifact
 * @param {string} where
 * @param {{ project: string, topLevel: boolean }} options
 * @returns {string[]}
 */
export function synthesizerProblems(id, artifact, where, { project, topLevel }) {
  const props = artifact?.properties ?? {};
  const roles = ['assumeRoleArn', 'cloudFormationExecutionRoleArn'];
  const missing = roles.filter((key) => typeof props[key] !== 'string' || props[key] === '');
  if (missing.length === 0) return [];
  const name = cfnName(id, artifact);
  const ci = ciStackName(project);
  if (topLevel && name === ci && missing.length === roles.length) return [];
  const at = `assembly: ${where}: stack ${SELECTOR.test(id) ? id : JSON.stringify(id)}`;
  return [
    `${at} names no ${missing.join(' and no ')}: only ${ci} may deploy with the caller's own credentials (shukkaCiSynthesizer); every other stack deploys through the project's bootstrap (shukkaSynthesizer); refused`,
  ];
}

/**
 * The cdk deploy argument lists the pipeline (infra.yml) and `shukka deploy` run for an assembly's top-level stacks,
 * with the shukka:revision tag: one `--all` when every stack has the same tags, otherwise each stack alone
 * (`--exclusively`) after its dependencies, so each keeps its own tags. The CI stack (ciStackName) is left out: it is
 * deployed by hand with admin credentials. When it is in the assembly, the stacks are named with `--exclusively`
 * instead of `--all`, so cdk neither deploys it nor pulls it in as a dependency.
 * Throws when a stack selector could be read as a cdk option.
 * @param {Record<string, any>} artifacts the top-level manifest's artifacts
 * @param {string} project
 * @param {string} sha
 * @returns {{ commands: string[][], skipped: string[] }} skipped: the selectors left out
 */
export function deployCommands(artifacts, project, sha) {
  const all = Object.entries(artifacts).filter(([, a]) => a?.type === 'aws:cloudformation:stack');
  /** @param {string} id */
  const selector = (id) => artifacts[id].displayName ?? id;
  for (const [id] of all) {
    const s = selector(id);
    if (typeof s !== 'string' || !SELECTOR.test(s)) throw new Error(`refusing stack selector ${JSON.stringify(s)}: it could be read as a cdk option`);
  }
  const ci = ciStackName(project);
  const stacks = all.filter(([id, a]) => cfnName(id, a) !== ci);
  const skipped = all.filter(([id, a]) => cfnName(id, a) === ci).map(([id]) => selector(id));
  const ids = new Set(stacks.map(([id]) => id));
  /** @param {any} a */
  const tagArgs = (a) => Object.entries({ ...(a.properties?.tags ?? {}), 'shukka:revision': sha }).map(([k, v]) => `--tags=${k}=${v}`);
  const keys = new Set(stacks.map(([, a]) => JSON.stringify(Object.entries(a.properties?.tags ?? {}).sort())));
  /** @type {string[][]} */
  const commands = [];
  if (stacks.length === 0) return { commands, skipped };
  if (keys.size === 1) {
    const first = /** @type {[string, any]} */ (stacks[0]);
    commands.push(skipped.length === 0 ? ['--all', ...tagArgs(first[1])] : ['--exclusively', ...stacks.map(([id]) => selector(id)), ...tagArgs(first[1])]);
    return { commands, skipped };
  }
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
    commands.push(['--exclusively', selector(id), ...tagArgs(a)]);
    done.add(id);
  };
  for (const [id] of stacks) visit(id);
  return { commands, skipped };
}

/**
 * Problems that make the assembly unsafe to publish and deploy with credentials.
 * Asset manifests are found by what the manifests say (any `cdk:asset-manifest` artifact's
 * `properties.file`), never by file name; and every JSON file in the assembly that carries `files`
 * or `dockerImages` is checked as an asset manifest too.
 * With `project`, every stack must also deploy through the project's bootstrap, but for the CI stack
 * (synthesizerProblems).
 * @param {string} dir
 * @param {{ project?: string }} [options]
 * @returns {string[]}
 */
export function checkAssembly(dir, options = {}) {
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
        problems.push(...stackProblems(id, a, where));
        if (options.project !== undefined) problems.push(...synthesizerProblems(id, a, where, { project: options.project, topLevel: base === '' }));
        for (const [path, entries] of Object.entries(a.metadata ?? {})) {
          if (Array.isArray(entries) && entries.some((e) => e?.type === 'aws:cdk:asset')) {
            problems.push(`assembly: ${where}: stack ${id} carries legacy asset metadata (aws:cdk:asset at ${path}); refused`);
          }
        }
      }
    }
  }
  problems.push(...deployedTemplates(root).problems);
  return [...new Set(problems)];
}

/**
 * @typedef {{ bucket: string, key: string, source: string, where: string }} FileAsset
 * @typedef {{ where: string, id: string, file: string, template: any }} StackTemplate
 */

/**
 * A JSON object read from a file in the assembly, or undefined when it is missing or not a JSON object.
 * @param {string} root
 * @param {string} rel
 * @returns {any}
 */
function jsonObject(root, rel) {
  try {
    const doc = readJson(join(root, rel));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The stack templates CloudFormation will be given and the file assets cdk publishes, through every manifest
 * (nested assemblies included), with the problems that mean the templates read are not the ones deployed.
 * @param {string} dir the assembly
 * @returns {{ stacks: StackTemplate[], assets: FileAsset[], problems: string[] }}
 */
export function deployedTemplates(dir) {
  /** @type {StackTemplate[]} */
  const stacks = [];
  /** @type {FileAsset[]} */
  const assets = [];
  /** @type {string[]} */
  const problems = [];
  /** @type {{ where: string, id: string, file: string | null, url: unknown }[]} */
  const named = [];
  const root = realpathSync(dir);
  const queue = [''];
  const seen = new Set();
  while (queue.length > 0) {
    const base = /** @type {string} */ (queue.shift());
    if (seen.has(base)) continue;
    seen.add(base);
    const where = base === '' ? 'manifest.json' : join(base, 'manifest.json');
    const manifest = jsonObject(root, where);
    if (!manifest) continue;
    for (const [id, artifact] of Object.entries(manifest.artifacts ?? {})) {
      const a = /** @type {any} */ (artifact) ?? {};
      const props = a.properties ?? {};
      if (a.type === 'cdk:cloud-assembly') {
        const nested = inside(root, base, props.directoryName);
        if (nested !== null) queue.push(nested);
      } else if (a.type === 'cdk:asset-manifest') {
        const file = inside(root, base, props.file);
        const doc = file === null ? undefined : jsonObject(root, file);
        const manifestDir = file === null ? base : relative(root, join(root, file, '..'));
        for (const [assetId, asset] of Object.entries(doc?.files ?? {})) {
          const x = /** @type {any} */ (asset);
          if ((x?.source?.packaging ?? 'file') !== 'file') continue;
          const source = inside(root, manifestDir, x?.source?.path);
          if (source === null) continue;
          if (/\.(json|ya?ml|template)$/i.test(source) && !jsonObject(root, source)) {
            problems.push(`assembly: ${file}: file asset ${assetId} (${source}) looks like a template but is not a JSON object; it cannot be checked`);
          }
          for (const d of Object.values(x?.destinations ?? {})) {
            const dest = /** @type {any} */ (d);
            if (typeof dest?.bucketName === 'string' && typeof dest?.objectKey === 'string') {
              assets.push({ bucket: dest.bucketName, key: dest.objectKey, source, where: /** @type {string} */ (file) });
            }
          }
        }
      } else if (a.type === 'aws:cloudformation:stack') {
        named.push({ where, id, file: props.templateFile === undefined ? null : inside(root, base, props.templateFile), url: props.stackTemplateAssetObjectUrl });
        if (props.templateFile !== undefined) {
          const file = inside(root, base, props.templateFile);
          const template = file === null ? undefined : jsonObject(root, file);
          // A template that is not there cannot be deployed either (cdk fails); one that is there must be JSON.
          if (file !== null && !template && !existsSync(join(root, file))) continue;
          if (file === null || !template) problems.push(`assembly: ${where}: stack ${id} template ${JSON.stringify(props.templateFile)} is not a JSON template in the assembly; it cannot be checked`);
          else stacks.push({ where, id, file, template });
        }
      }
    }
  }
  // One bucket and key, one source: otherwise which file is published (and deployed) is not the one read.
  /** @type {Map<string, Set<string>>} */
  const byDestination = new Map();
  for (const x of assets) {
    const k = `${x.bucket}/${x.key}`;
    byDestination.set(k, (byDestination.get(k) ?? new Set()).add(x.source));
  }
  for (const [k, sources] of byDestination) {
    if (sources.size > 1) problems.push(`assembly: two file assets are published to ${k} from different files (${[...sources].sort().join(', ')}); refused`);
  }
  for (const s of named) {
    if (s.url === undefined) continue;
    const m = typeof s.url === 'string' ? /^s3:\/\/([^/]+)\/(.+)$/.exec(s.url) : null;
    const sources = m ? byDestination.get(`${m[1]}/${m[2]}`) : undefined;
    if (!m) problems.push(`assembly: ${s.where}: stack ${s.id} stackTemplateAssetObjectUrl ${JSON.stringify(s.url)} is not an s3:// URL`);
    else if (!sources) problems.push(`assembly: ${s.where}: stack ${s.id} deploys ${s.url}, which no file asset publishes`);
    else if (s.file === null || sources.size !== 1 || !sources.has(s.file)) {
      problems.push(`assembly: ${s.where}: stack ${s.id} deploys ${s.url}, published from ${[...sources].sort().join(', ')}, not its templateFile ${s.file ?? '(none)'}; refused`);
    }
  }
  return { stacks, assets, problems };
}

/**
 * The CloudFormation names of the assembly's top-level stacks. Throws when any is not a valid stack name, so
 * nothing else (a comma, a newline, an option) reaches the workflow's `stacks` output.
 * @param {string} dir
 * @returns {string[]}
 */
export function stackNames(dir) {
  const { artifacts = {} } = readJson(join(dir, 'manifest.json'));
  const names = Object.entries(artifacts)
    .filter(([, a]) => /** @type {any} */ (a).type === 'aws:cloudformation:stack')
    .map(([id, a]) => /** @type {any} */ (a).properties?.stackName ?? id);
  const bad = names.filter((n) => typeof n !== 'string' || !STACK_NAME.test(n));
  if (bad.length > 0) throw new Error(`${bad.map((n) => JSON.stringify(n)).join(', ')} is not a CloudFormation stack name (${STACK_NAME.source})`);
  return names;
}

const USAGE = 'usage: node scripts/assembly.mjs check <dir> [--project <name>] | stacks <dir>';
// A project name as shukka.json and ShukkaAccess take it.
const PROJECT = /^[a-z][a-z0-9-]{1,20}$/;

/**
 * @param {string[]} argv
 * @returns {number}
 */
export function main(argv) {
  const [command, dir, ...rest] = argv;
  const projectArg = command === 'check' && rest.length === 2 && rest[0] === '--project' ? rest[1] : undefined;
  if (!dir || (rest.length > 0 && projectArg === undefined) || (command !== 'check' && command !== 'stacks')) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (projectArg !== undefined && !PROJECT.test(projectArg)) {
    process.stderr.write(`assembly: --project ${JSON.stringify(projectArg)} is not a project name (${PROJECT.source})\n${USAGE}\n`);
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
  const problems = checkAssembly(dir, projectArg === undefined ? {} : { project: projectArg });
  for (const problem of problems) process.stdout.write(`${problem}\n`);
  if (problems.length === 0) process.stdout.write('assembly: no asset runs a command, no Docker image, nothing outside the assembly\n');
  return problems.length === 0 ? 0 : 1;
}

// Imported from a script on stdin (infra.yml's Deploy step), argv[1] is not a file.
const invoked = (() => {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) : '';
  } catch {
    return '';
  }
})();
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
