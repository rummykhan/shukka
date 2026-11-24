#!/usr/bin/env node
// Upload one app's bundle directory to s3://<bucket>/<project>/<app>/<sha>.tgz, where
// box/shukka-release.sh downloads it from.
//
// A bundle holding any .env* file (at any depth) is refused: local settings must never reach the
// server. The server unpacks it as root, so only regular files, directories and symbolic links
// that stay inside the bundle are accepted, and nothing setuid or setgid. Every entry in the
// tarball is owned by 0:0, and it carries no macOS extended attributes, ACLs or AppleDouble (._*) files.
// The configure hook is not part of this: release.mjs takes it from the git checkout.
//
// CLI:
//   node scripts/upload.mjs --dir <bundle-dir> --bucket <bucket> --sha <sha>
//        (--config <shukka.json> --app <name> | --project <p> --app <a>) [--region <r>]
//   With --config, project and region come from the config.
//   Prints the tarball's sha256 (for release.mjs --bundle-sha256) as "sha256 <hex>" and
//   s3://<bucket>/<key> on the last line of stdout.
//   exit 0: uploaded; exit 1: refused or failed (one line per problem on stderr); exit 2: usage error

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from './config.mjs';

// The same formats shukka.json and box/shukka-release.sh accept.
export const PROJECT_RE = /^[a-z][a-z0-9-]{1,20}$/;
export const APP_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const SHA_RE = /^[0-9a-f]{7,40}$/;
export const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
export const REGION_RE = /^[a-z]{2}(-[a-z]+)+-[0-9]+$/;

/**
 * @typedef {{ send(command: PutObjectCommand): Promise<unknown> }} S3Like
 * @typedef {{ dir: string, bucket: string, project: string, app: string, sha: string, region?: string, s3?: S3Like }} UploadOptions
 * @typedef {{ bucket: string, key: string, url: string, bytes: number, sha256: string }} UploadResult
 */

/**
 * @param {string} project
 * @param {string} app
 * @param {string} sha
 * @returns {string}
 */
export function bundleKey(project, app, sha) {
  return `${project}/${app}/${sha}.tgz`;
}

/**
 * Problems with the names that end up in the S3 key and on the server.
 * @param {{ bucket: string, project: string, app: string, sha: string }} names
 * @returns {string[]}
 */
export function checkNames({ bucket, project, app, sha }) {
  /** @type {string[]} */
  const problems = [];
  if (!BUCKET_RE.test(bucket)) problems.push(`bucket: "${bucket}" is not a bucket name`);
  if (!PROJECT_RE.test(project)) problems.push(`project: "${project}" must match ${PROJECT_RE.source}`);
  if (!APP_RE.test(app)) problems.push(`app: "${app}" must match ${APP_RE.source}`);
  if (!SHA_RE.test(sha)) problems.push(`sha: "${sha}" must be 7 to 40 lowercase hex characters`);
  return problems;
}

/**
 * Paths (relative to dir) of every .env* entry at any depth. Symbolic links are listed, never followed.
 * @param {string} dir
 * @returns {string[]}
 */
export function findEnvFiles(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.name.startsWith('.env')) found.push(relative(dir, join(entry.parentPath, entry.name)));
  }
  return found.sort();
}

/**
 * Whether a relative link target, followed from the link's directory `depth` levels below the
 * bundle root, ever climbs above the root.
 * @param {string} target
 * @param {number} depth
 * @returns {boolean}
 */
function climbsOut(target, depth) {
  let level = depth;
  for (const part of target.split('/')) {
    if (part === '..') level--;
    else if (part !== '' && part !== '.') level++;
    if (level < 0) return true;
  }
  return false;
}

/**
 * Everything in the bundle the server must not unpack as root: .env* entries, symbolic links that
 * are absolute or lead outside the bundle (or nowhere), anything that is not a regular file,
 * directory or such a link, and setuid or setgid files. One line per problem, paths relative to dir.
 * @param {string} dir
 * @returns {string[]}
 */
export function checkBundle(dir) {
  const root = realpathSync(dir);
  /** @type {string[]} */
  const problems = [];
  for (const rel of findEnvFiles(dir)) problems.push(`refused: ${rel} is a .env file; local settings must never reach the server`);
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    const rel = relative(dir, path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      const depth = rel.split(sep).length - 1;
      let real;
      try {
        real = realpathSync(path);
      } catch {
        real = '';
      }
      if (isAbsolute(target)) {
        problems.push(`refused: ${rel} is a symbolic link to an absolute path`);
      } else if (climbsOut(target, depth) || real === '' || (real !== root && !real.startsWith(root + sep))) {
        problems.push(`refused: ${rel} is a symbolic link that leads outside the bundle`);
      }
    } else if (!stat.isFile() && !stat.isDirectory()) {
      problems.push(`refused: ${rel} is not a regular file, directory or symbolic link`);
    } else if (stat.isFile() && (stat.mode & 0o6000) !== 0) {
      problems.push(`refused: ${rel} is setuid or setgid`);
    }
  }
  return problems;
}

/**
 * Write a gzipped tarball of dir's contents, every entry owned by 0:0, without extended attributes,
 * ACLs or AppleDouble files.
 * @param {string} dir
 * @param {string} outFile
 */
export function makeTarball(dir, outFile) {
  const version = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  const bsd = /bsdtar/.test(version.stdout ?? '');
  const flags = ['--no-xattrs', '--no-acls'];
  if (bsd) flags.push('--no-mac-metadata', '--no-fflags', '--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root');
  // GNU tar: setuid and setgid files are refused by checkBundle; --mode clears the bits anyway.
  else flags.push('--owner=0', '--group=0', '--numeric-owner', '--mode=u-s,g-s');
  const result = spawnSync('tar', ['-czf', outFile, ...flags, '-C', dir, '.'], {
    encoding: 'utf8',
    // Stops macOS tar from adding AppleDouble (._*) entries for extended attributes.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (result.error) throw new Error(`tar: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr.trim().split('\n')[0] ?? ''}`);
}

/**
 * Check, pack and upload one bundle.
 * @param {UploadOptions} options
 * @returns {Promise<UploadResult>}
 */
export async function upload(options) {
  const { dir, bucket, project, app, sha } = options;
  const problems = checkNames({ bucket, project, app, sha });
  if (problems.length > 0) throw new Error(problems.join('\n'));

  let isDir;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new Error(`dir: ${dir} is not a directory`);

  const refused = checkBundle(dir);
  if (refused.length > 0) throw new Error(refused.join('\n'));

  const work = mkdtempSync(join(tmpdir(), 'shukka-bundle-'));
  try {
    const tgz = join(work, `${sha}.tgz`);
    makeTarball(dir, tgz);
    const body = readFileSync(tgz);
    const key = bundleKey(project, app, sha);
    const s3 = options.s3 ?? new S3Client(options.region ? { region: options.region } : {});
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/gzip' }));
    return { bucket, key, url: `s3://${bucket}/${key}`, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Parse `--name value` pairs; every flag needs a value and may appear once.
 * @param {string[]} argv
 * @param {string[]} names allowed flag names, without --
 * @returns {{ values: Record<string, string> } | { error: string }}
 */
export function parseFlags(argv, names) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const name = arg.startsWith('--') ? arg.slice(2) : '';
    if (!names.includes(name)) return { error: `unknown argument: ${arg}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
    if (Object.hasOwn(values, name)) return { error: `${arg} given twice` };
    values[name] = value;
    i++;
  }
  return { values };
}

const USAGE = 'usage: node scripts/upload.mjs --dir <bundle-dir> --bucket <bucket> --sha <sha> '
  + '(--config <shukka.json> --app <name> | --project <p> --app <a>) [--region <r>]';

const FLAGS = ['dir', 'bucket', 'sha', 'config', 'app', 'project', 'region'];

/**
 * @param {string[]} argv
 * @param {{ s3?: S3Like, out?: (text: string) => void }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const parsed = parseFlags(argv, FLAGS);
  if ('error' in parsed) {
    process.stderr.write(`upload: ${parsed.error}\n${USAGE}\n`);
    return 2;
  }
  const v = parsed.values;
  let { project, region } = v;
  if (v.config !== undefined) {
    if (project !== undefined) {
      process.stderr.write(`upload: --config replaces --project\n${USAGE}\n`);
      return 2;
    }
    const { config, problems } = loadConfig(v.config);
    if (!config) {
      for (const problem of problems) process.stderr.write(`${problem}\n`);
      return 1;
    }
    if (!config.apps.some((a) => a.name === v.app)) {
      process.stderr.write(`upload: no app "${v.app ?? ''}" in ${v.config}\n`);
      return 1;
    }
    project = config.project;
    region = region ?? config.aws.region;
  }
  const missing = ['dir', 'bucket', 'sha', 'app'].filter((name) => v[name] === undefined);
  if (project === undefined) missing.push('project');
  if (missing.length > 0) {
    process.stderr.write(`upload: missing ${missing.map((m) => `--${m}`).join(', ')}\n${USAGE}\n`);
    return 2;
  }
  try {
    const result = await upload({
      dir: /** @type {string} */ (v.dir),
      bucket: /** @type {string} */ (v.bucket),
      sha: /** @type {string} */ (v.sha),
      app: /** @type {string} */ (v.app),
      project: /** @type {string} */ (project),
      ...(region !== undefined ? { region } : {}),
      ...(deps.s3 ? { s3: deps.s3 } : {}),
    });
    (deps.out ?? ((text) => process.stdout.write(text)))(`uploaded ${result.bytes} bytes\nsha256 ${result.sha256}\n${result.url}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n`);
    return 1;
  }
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
