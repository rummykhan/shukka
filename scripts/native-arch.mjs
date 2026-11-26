#!/usr/bin/env node
// Refuse a bundle whose native Node.js modules (.node files) cannot load on the app's servers
// (shukka.json apps[].server.arch): a bundle built on an x64 runner for an arm64 (Graviton) server
// carries, for example, @img/sharp-linux-x64, and sharp fails to load there.
//
// Each .node file must be a Linux ELF shared object for the server's machine (x64: EM_X86_64,
// arm64: EM_AARCH64). The one exception is the prebuilds/<platform>-<arch>/ layout (node-gyp-build,
// prebuildify): such packages ship every platform's binary and pick one at run time by that
// directory name, so a file there is checked only when the directory names this server's target.
//
// CLI: node scripts/native-arch.mjs <bundle-dir> <x64|arm64>
//   exit 0: every native module fits (prints how many were checked)
//   exit 1: one line per wrong file on stderr
//   exit 2: usage error

import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** ELF e_machine values for the architectures shukka.json can name. */
export const ELF_MACHINE = Object.freeze({ x64: 62, arm64: 183 });

/** @type {Record<number, string>} */
const MACHINE_NAMES = { 3: 'x86', 40: 'arm', 62: 'x64', 183: 'arm64' };

/**
 * What a .node file was built for, from its first bytes.
 * @param {Buffer} head at least the first 20 bytes of the file
 * @returns {{ elf: true, machine: number } | { elf: false, kind: string }}
 */
export function nativeKind(head) {
  if (head.length >= 20 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
    // EI_DATA (byte 5): 1 little-endian, 2 big-endian; e_machine is the 16-bit field at offset 18.
    const machine = head[5] === 2 ? head.readUInt16BE(18) : head.readUInt16LE(18);
    return { elf: true, machine };
  }
  const magic = head.length >= 4 ? head.readUInt32BE(0) : 0;
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) return { elf: false, kind: 'a macOS (Mach-O) binary' };
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return { elf: false, kind: 'a Windows (PE) binary' };
  return { elf: false, kind: 'not a Linux (ELF) binary' };
}

/**
 * The target a prebuilds/<platform>-<arch>/ directory names, when `rel` sits in one; else null.
 * @param {string} rel path relative to the bundle, with / separators
 * @returns {string | null}
 */
function prebuildTarget(rel) {
  const m = /(?:^|\/)prebuilds\/([^/]+)\//.exec(rel);
  return m ? /** @type {string} */ (m[1]) : null;
}

/**
 * Every .node file under `dir` (symbolic links are not followed: upload.mjs refuses links that leave the bundle).
 * @param {string} dir
 * @returns {string[]}
 */
function nodeFiles(dir) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} d */
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.node')) found.push(path);
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * @param {string} path
 * @returns {Buffer}
 */
function head(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(20);
    const n = readSync(fd, buf, 0, 20, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * Check the native modules of a bundle against the servers' architecture.
 * @param {string} dir the bundle directory
 * @param {'x64' | 'arm64'} arch
 * @returns {{ checked: number, problems: string[] }}
 */
export function checkNativeArch(dir, arch) {
  const want = ELF_MACHINE[arch];
  if (want === undefined) throw new Error(`unknown architecture ${JSON.stringify(arch)} (x64 or arm64)`);
  /** @type {string[]} */
  const problems = [];
  let checked = 0;
  for (const path of nodeFiles(dir)) {
    const rel = relative(dir, path).split(sep).join('/');
    const target = prebuildTarget(rel);
    if (target !== null && !target.startsWith(`linux-${arch}`)) continue; // picked at run time by directory name
    checked += 1;
    // File names come from the project's dependencies and reach CI logs: quoted, escaped, no `::` workflow command.
    const show = JSON.stringify(rel).replace(/:(?=:)/g, ': ');
    const kind = nativeKind(head(path));
    if (!kind.elf) {
      problems.push(`${show}: ${kind.kind}, the servers run Linux ${arch}`);
    } else if (kind.machine !== want) {
      problems.push(`${show}: built for ${MACHINE_NAMES[kind.machine] ?? `ELF machine ${kind.machine}`}, the servers are ${arch}`);
    }
  }
  return { checked, problems };
}

const USAGE = 'usage: node scripts/native-arch.mjs <bundle-dir> <x64|arm64>';

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  const [dir, arch] = argv;
  if (argv.length !== 2 || !dir || (arch !== 'x64' && arch !== 'arm64')) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write(`native-arch: ${dir} is not a directory\n`);
    return 2;
  }
  const { checked, problems } = checkNativeArch(dir, arch);
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`native-arch: ${p}\n`);
    process.stderr.write(`native-arch: ${problems.length} native module(s) cannot load on ${arch} servers; build on a ${arch} machine `
      + `(apps[].server.arch in shukka.json chooses the runner)\n`);
    return 1;
  }
  process.stdout.write(`native-arch: ${checked} native module(s), all linux ${arch}\n`);
  return 0;
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
