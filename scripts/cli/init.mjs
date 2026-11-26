// shukka init <project> (shu-cio.1): scaffold a project's shukka.json and caller workflow, and print the CDK wiring.
// It reads what it can from the repository (package.json workspaces, an app's package.json scripts, cdk.json) and
// writes TODO into every value it could not read, then lists them. It touches nothing but the two files it writes,
// never overwrites one without --force, and calls neither AWS nor GitHub.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { validateConfig } from '../config.mjs';
import { ciStackName } from '../assembly.mjs';
import { CliError, refuseSymlink } from './exec.mjs';

/** A release tag: lightweight `vX.Y.Z`, or a candidate `vX.Y.Z-rc.N` (only when asked for with --ref). */
const RELEASE = /^v\d+\.\d+\.\d+$/;
const CANDIDATE = /^v\d+\.\d+\.\d+-rc\.\d+$/;
const PROJECT = /^[a-z][a-z0-9-]{1,20}$/;
const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const ACCOUNT = /^[0-9]{12}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]+$/;
/** No AWS account has this id: shukka.json stays schema-valid and bootstrap cannot reach anything with it. */
const NO_ACCOUNT = '000000000000';
const CONFIG_FILE = 'shukka.json';
const WORKFLOW_FILE = '.github/workflows/ci.yml';
/** Directories never searched for cdk.json. */
const SKIP = new Set(['node_modules', '.git', 'cdk.out', 'dist', 'build', '.next']);

/**
 * The tag the caller workflow, $schema and constructs are pinned to: --ref when given, else v<this shukka's version>.
 * Pins are release tags only (AWS refuses a branch or SHA; a candidate needs allowPrerelease, so only on request).
 * @param {{ version: string, ref?: string }} options
 * @returns {string}
 */
export function releaseRef({ version, ref }) {
  if (ref !== undefined) {
    if (RELEASE.test(ref) || CANDIDATE.test(ref)) return ref;
    throw new CliError(`init: --ref ${JSON.stringify(ref)} is not a release tag (vX.Y.Z, or vX.Y.Z-rc.N for a candidate)`, 2);
  }
  const tag = `v${version}`;
  if (!RELEASE.test(tag) || version === '0.0.0') {
    throw new CliError(`init: this shukka (version ${version}) is not a release; give the tag to pin with --ref vX.Y.Z`, 2);
  }
  return tag;
}

/**
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function isDir(dir) {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Workspace directories from the root package.json: literal entries and `dir/*` patterns, each with a package.json.
 * @param {string} cwd
 * @returns {string[]} paths relative to cwd, posix
 */
function workspaceDirs(cwd) {
  const pkg = readJson(join(cwd, 'package.json'));
  const raw = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const dirs = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const clean = entry.replace(/^\.\//, '').replace(/\/$/, '');
    if (clean.endsWith('/*') && !clean.slice(0, -2).includes('*')) {
      const parent = clean.slice(0, -2);
      if (!isDir(join(cwd, parent))) continue;
      for (const name of readdirSync(join(cwd, parent)).sort()) dirs.push(posix.join(parent, name));
    } else if (!clean.includes('*')) {
      dirs.push(clean);
    }
  }
  return dirs.filter((d) => existsSync(join(cwd, d, 'package.json')) && !d.split('/').includes('..'));
}

/**
 * The shallowest cdk.json in the repository (at most three levels down).
 * @param {string} cwd
 * @returns {{ dir: string, others: string[] } | null}
 */
function findCdk(cwd) {
  /** @type {string[]} */
  let level = ['.'];
  for (let depth = 0; depth <= 3 && level.length > 0; depth++) {
    const found = level.filter((d) => existsSync(join(cwd, d, 'cdk.json')));
    if (found.length > 0) return { dir: /** @type {string} */ (found[0]), others: found.slice(1) };
    /** @type {string[]} */
    const next = [];
    for (const d of level) {
      for (const name of readdirSync(join(cwd, d)).sort()) {
        if (SKIP.has(name) || name.startsWith('.')) continue;
        if (isDir(join(cwd, d, name))) next.push(d === '.' ? name : `${d}/${name}`);
      }
    }
    level = next;
  }
  return null;
}

/**
 * @param {string} what
 * @returns {string} a command that fails, saying what to fill in
 */
const todoCommand = (what) => `echo 'TODO: ${what}' >&2; exit 1`;

/**
 * An app: name and build dir, from a workspace or an --apps name.
 * @param {string} cwd
 * @param {string} name
 * @param {string} dir
 * @param {string} project
 * @param {string} infraDir
 */
function appEntry(cwd, name, dir, project, infraDir) {
  const pkg = readJson(join(cwd, dir, 'package.json'));
  const scripts = pkg?.scripts ?? {};
  const next = ['next.config.js', 'next.config.mjs', 'next.config.ts'].some((f) => existsSync(join(cwd, dir, f)));
  const box = infraDir === '.' ? 'box' : `${infraDir}/box`;
  return {
    name,
    paths: [`${dir}/**`],
    build: {
      dir,
      run: typeof scripts.build === 'string' ? ['npm ci', 'npm run build'] : [todoCommand(`build ${name} in ${dir}`)],
      // shukka provides scripts/bundle.sh for Next.js output: 'standalone' when the app has none of its own.
      bundle: next ? 'scripts/bundle.sh' : 'TODO-bundle.sh',
    },
    server: {
      configure: `${box}/TODO-configure-${name}.sh`,
      units: [`${project}-${name}`],
      health: 'http://127.0.0.1:3000/TODO-health',
    },
  };
}

/**
 * A check from a package.json's lint, typecheck and test scripts, or null when it has none.
 * @param {string} cwd
 * @param {string} name
 * @param {string} dir
 * @param {boolean} [typescript] add `npx tsc --noEmit` when there is no typecheck script (the CDK app)
 */
function checkEntry(cwd, name, dir, typescript = false) {
  const pkg = readJson(join(cwd, dir, 'package.json'));
  if (!pkg) return null;
  const scripts = pkg.scripts ?? {};
  /** @type {string[]} */
  const run = [];
  if (typeof scripts.lint === 'string') run.push('npm run lint');
  if (typeof scripts.typecheck === 'string') run.push('npm run typecheck');
  else if (typescript && existsSync(join(cwd, dir, 'tsconfig.json'))) run.push('npx tsc --noEmit');
  if (typeof scripts.test === 'string') run.push('npm test');
  return run.length > 0 ? { name, dir, run: ['npm ci', ...run] } : null;
}

/**
 * A qualifier CDK accepts (at most 10 lowercase alphanumerics), from the project name.
 * @param {string} project
 * @returns {string}
 */
function qualifierFor(project) {
  return project.replace(/-/g, '').slice(0, 10);
}

/**
 * @param {string} ref
 * @returns {string}
 */
export function callerWorkflow(ref) {
  return [
    '# The whole CI file: shukka (https://github.com/rummykhan/shukka) runs the checks, builds, infrastructure diff and',
    '# deploy, app release and smoke test from shukka.json. Written by shukka init; keep the pin on a release tag, the',
    '# same one as $schema in shukka.json and shukka in the infra package.json.',
    'name: CI',
    'on:',
    '  pull_request:',
    '  push: { branches: [main] }',
    '  workflow_dispatch:',
    '    inputs:',
    '      allow_replacement:',
    '        description: "Let the infrastructure deploy delete or replace resources (read the diff first)"',
    '        type: boolean',
    '        default: false',
    '      force:',
    '        description: "Deploy the infrastructure and every app, whatever changed"',
    '        type: boolean',
    '        default: false',
    'jobs:',
    '  shukka:',
    `    uses: rummykhan/shukka/.github/workflows/pipeline.yml@${ref}`,
    '    permissions: { contents: read, id-token: write, pull-requests: write }',
    '    with:',
    '      allow_replacement: ${{ inputs.allow_replacement || false }}',
    '      force: ${{ inputs.force || false }}',
    '',
  ].join('\n');
}

/**
 * The CDK wiring for the project's app: the CI stack with ShukkaAccess, the synthesizers, tags and boundary.
 * @param {{ project: string, qualifier: string, account: string, region: string, ref: string, bucket: string }} p
 * @returns {string}
 */
export function cdkSnippet({ project, qualifier, account, region, ref, bucket }) {
  const Project = `${project.charAt(0).toUpperCase()}${project.slice(1)}`;
  const accountText = account === NO_ACCOUNT ? 'TODO-account' : account;
  return [
    "import { App, Stack } from 'aws-cdk-lib';",
    "import * as s3 from 'aws-cdk-lib/aws-s3';",
    "import { ShukkaAccess, applyBoundary, shukkaCiSynthesizer, shukkaSynthesizer, tagProject } from 'shukka';",
    '',
    'const app = new App();',
    `const env = { account: '${accountText}', region: '${region}' };`,
    `const synthesizer = shukkaSynthesizer('${qualifier}');`,
    '',
    `// The CI stack: exactly ${ciStackName(project)}, nothing in it but ShukkaAccess; an admin deploys it with shukka deploy-ci ${project}.`,
    `const ci = new Stack(app, '${ciStackName(project)}', { env, synthesizer: shukkaCiSynthesizer('${qualifier}') });`,
    "new ShukkaAccess(ci, 'Access', {",
    `  project: '${project}',`,
    "  // TODO githubRepo: the subject your tokens carry, from: gh api repos/<owner>/<name> --jq '\"\\(.owner.login)@\\(.owner.id)/\\(.name)@\\(.id)\"'",
    "  githubRepo: 'TODO-owner@ownerId/name@repoId',",
    `  deployBucket: s3.Bucket.fromBucketName(ci, 'DeployBucket', '${bucket}'),`,
    '});',
    '',
    `// Your stacks: each with { env, synthesizer }, named ${Project}-... or ${project}-...`,
    `// new BoxStack(app, '${Project}-Box', { env, synthesizer });`,
    '',
    `tagProject(app, '${project}');`,
    `applyBoundary(app, '${project}');`,
    '',
    `// Constructs from the same release as the caller workflow (in the infra directory):`,
    `//   npm install --save github:rummykhan/shukka#${ref} aws-cdk-lib constructs tsx`,
  ].join('\n');
}

/**
 * Every string value in `value` that holds TODO, with its path (`apps[1].build.run`).
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]}
 */
function todoPaths(value, path = '') {
  if (typeof value === 'string') return value.includes('TODO') ? [path] : [];
  if (Array.isArray(value)) {
    const inner = value.flatMap((v, i) => todoPaths(v, `${path}[${i}]`));
    return inner.length > 0 && value.every((v) => typeof v === 'string') ? [path] : inner;
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => todoPaths(v, path ? `${path}.${k}` : k));
  }
  return [];
}

/**
 * @typedef {{
 *   cwd: string,
 *   out: (text: string) => void,
 *   project: string | undefined,
 *   apps?: string,
 *   account?: string,
 *   region?: string,
 *   ref?: string,
 *   force: boolean,
 *   env: Record<string, string | undefined>,
 *   version?: string,
 * }} InitOptions
 */

/**
 * @param {InitOptions} o
 * @returns {number} exit code
 */
export function initCommand(o) {
  const { cwd, out, project } = o;
  if (project === undefined) throw new CliError('init: give the project name (shukka init <project>)', 2);
  if (!PROJECT.test(project)) throw new CliError(`init: project ${JSON.stringify(project)} must be 2 to 21 lowercase letters, digits and -, starting with a letter`, 2);
  if (o.account !== undefined && !ACCOUNT.test(o.account)) throw new CliError('init: --account must be a 12-digit AWS account id', 2);
  const region = o.region ?? o.env.AWS_REGION ?? o.env.AWS_DEFAULT_REGION;
  if (region !== undefined && !REGION.test(region)) throw new CliError(`init: region ${JSON.stringify(region)} is not an AWS region`, 2);
  /** @type {string[]} */
  const appNames = o.apps === undefined ? [] : o.apps.split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of appNames) {
    if (!NAME.test(name)) throw new CliError(`init: app ${JSON.stringify(name)} must be lowercase letters, digits and -, starting with a letter`, 2);
  }
  const version = o.version ?? readJson(new URL('../../package.json', import.meta.url).pathname)?.version ?? '0.0.0';
  const ref = releaseRef({ version, ...(o.ref !== undefined ? { ref: o.ref } : {}) });

  // Refuse before reading or writing anything else: every file must be free (or --force), and none a symbolic link.
  const existing = [];
  for (const file of [CONFIG_FILE, WORKFLOW_FILE]) {
    refuseSymlink(cwd, file);
    if (existsSync(join(cwd, file))) existing.push(file);
  }
  if (existing.length > 0 && !o.force) {
    throw new CliError(`init: ${existing.join(' and ')} already exist${existing.length === 1 ? 's' : ''}; nothing written (--force overwrites)`);
  }

  /** @type {string[]} */
  const todos = [];
  const cdk = findCdk(cwd);
  const infraDir = cdk?.dir ?? 'infra';
  if (!cdk) todos.push(`no cdk.json found: create your CDK app in ${infraDir}/ (or set infra.dir), README step 3`);
  else if (cdk.others.length > 0) todos.push(`more than one cdk.json (${[cdk.dir, ...cdk.others].join(', ')}): infra.dir is ${cdk.dir}; change it if that is wrong`);
  const cdkApp = cdk ? readJson(join(cwd, cdk.dir, 'cdk.json'))?.app : undefined;
  const entry = typeof cdkApp === 'string' ? cdkApp.split(/\s+/).reverse().find((w) => /\.(?:[cm]?[jt]s)$/.test(w)) : undefined;
  if (cdk && typeof cdkApp === 'string' && !/\btsx\b/.test(cdkApp)) {
    todos.push(`cdk.json runs "${cdkApp}": shukka's constructs are TypeScript source, run the app with tsx ("app": "npx tsx ${entry ?? 'bin/app.ts'}")`);
  }

  // Apps: --apps names (their dir from a workspace of that name, else <name>/ or apps/<name>/), else every workspace.
  const workspaces = workspaceDirs(cwd).filter((d) => d !== infraDir);
  /** @type {{ name: string, dir: string }[]} */
  const apps = [];
  if (appNames.length > 0) {
    for (const name of appNames) {
      const dir = workspaces.find((d) => basename(d) === name)
        ?? [name, `apps/${name}`].find((d) => isDir(join(cwd, d)));
      if (!dir) todos.push(`app ${name}: no directory ${name}/ or apps/${name}/; set apps[].build.dir and apps[].paths`);
      apps.push({ name, dir: dir ?? name });
    }
  } else {
    for (const dir of workspaces) {
      const name = basename(dir).toLowerCase();
      if (NAME.test(name) && !apps.some((a) => a.name === name)) apps.push({ name, dir });
    }
    if (apps.length === 0) todos.push('no apps found in package.json workspaces: name them with --apps a,b, or add them to apps');
  }

  const appEntries = apps.map((a) => appEntry(cwd, a.name, a.dir, project, infraDir));
  const checks = apps.map((a) => checkEntry(cwd, a.name, a.dir)).filter((c) => c !== null);
  const infraCheck = cdk ? checkEntry(cwd, apps.some((a) => a.name === 'infra') ? 'infra-cdk' : 'infra', infraDir, true) : null;
  if (infraCheck) checks.push(infraCheck);

  const account = o.account ?? NO_ACCOUNT;
  if (account === NO_ACCOUNT) todos.push(`aws.account is ${NO_ACCOUNT}: set your 12-digit account id (or run again with --account)`);
  if (region === undefined) todos.push('aws.region is us-east-1 (no --region, AWS_REGION or AWS_DEFAULT_REGION): set yours');
  const qualifier = qualifierFor(project);

  const config = {
    $schema: `https://raw.githubusercontent.com/rummykhan/shukka/${ref}/schema/shukka.schema.json`,
    project,
    qualifier,
    aws: { account, region: region ?? 'us-east-1' },
    node: '22',
    checks,
    infra: { dir: infraDir, paths: [infraDir === '.' ? '**' : `${infraDir}/**`] },
    apps: appEntries,
    smoke: { run: todoCommand('smoke test the live site') },
    alwaysDeploy: false,
  };
  const { problems } = validateConfig(config);
  if (problems.length > 0) throw new CliError(`init: the shukka.json it would write is not valid (a bug in shukka init):\n${problems.join('\n')}`);
  for (const path of todoPaths(config)) todos.push(`${path} in shukka.json`);
  for (const a of appEntries) todos.push(`apps.${a.name}.server.units is ${a.server.units.join(', ')}: the systemd units your configure hook installs`);
  todos.push('githubRepo in the CDK wiring above: your repository\'s token subject');

  writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
  mkdirSync(join(cwd, '.github/workflows'), { recursive: true });
  writeFileSync(join(cwd, WORKFLOW_FILE), callerWorkflow(ref));

  const snippet = cdkSnippet({ project, qualifier, account, region: config.aws.region, ref, bucket: `${project}-deploy-${account === NO_ACCOUNT ? 'TODO-account' : account}` });
  const target = entry ? posix.join(infraDir, entry) : `${infraDir}/bin/app.ts`;
  out([
    `wrote ${CONFIG_FILE} and ${WORKFLOW_FILE} (pinned to shukka ${ref})`,
    '',
    `CDK wiring for ${target} (merge it into your app; README step 3):`,
    '',
    ...snippet.split('\n').map((l) => (l ? `  ${l}` : '')),
    '',
    'TODO (search the files for TODO):',
    ...todos.map((t) => `  TODO ${t}`),
    '',
  ].join('\n'));
  return 0;
}
