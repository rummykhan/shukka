// shu-njm: apps[].server.arch, and the check that a bundle's native modules (.node files) fit the servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { validateConfig } from '../scripts/config.mjs';
import { ELF_MACHINE, checkNativeArch, nativeKind } from '../scripts/native-arch.mjs';
import { PROJECT_PLATFORM, containerArgs, platformFor, projectImage } from '../scripts/cli/exec.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'native-arch.mjs');
const examplePath = join(root, 'test', 'fixtures', 'config', 'trendigle.json');

/** The first bytes of a 64-bit little-endian ELF shared object for `machine` (what the check reads of a .node file). */
function elf(machine: number): Buffer {
  const b = Buffer.alloc(64);
  b.write('\x7fELF', 0, 'latin1');
  b[4] = 2; // ELFCLASS64
  b[5] = 1; // little-endian
  b[6] = 1; // EV_CURRENT
  b.writeUInt16LE(3, 16); // ET_DYN
  b.writeUInt16LE(machine, 18);
  return b;
}

function withTmp(fn: (dir: string) => void) {
  return () => {
    const dir = mkdtempSync(join(tmpdir(), 'shu-njm-'));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function put(path: string, data: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function example(): Record<string, any> {
  return JSON.parse(readFileSync(examplePath, 'utf8'));
}

test('shu-njm: apps[].server.arch is x64 or arm64, x64 when absent', () => {
  const plain = validateConfig(example());
  assert.deepEqual(plain.problems, []);
  assert.ok(plain.config!.apps.every((a) => a.server.arch === 'x64'), 'files written before arch existed keep x64');

  const arm = example();
  arm.apps[0].server.arch = 'arm64';
  const r = validateConfig(arm);
  assert.deepEqual(r.problems, []);
  assert.equal(r.config!.apps[0]!.server.arch, 'arm64');

  for (const bad of ['amd64', 'aarch64', 'ARM64', '']) {
    const c = example();
    c.apps[0].server.arch = bad;
    assert.deepEqual(validateConfig(c).problems, [`shukka.json: apps[0].server.arch: ${JSON.stringify(bad)} is not one of x64, arm64`], bad);
  }
  const n = example();
  n.apps[0].server.arch = 64;
  assert.deepEqual(validateConfig(n).problems, ['shukka.json: apps[0].server.arch: expected string, got integer']);
});

test('shu-njm: a .node file is read as an ELF for its machine, or named as a macOS or Windows binary', () => {
  assert.deepEqual(nativeKind(elf(ELF_MACHINE.arm64)), { elf: true, machine: 183 });
  assert.deepEqual(nativeKind(elf(ELF_MACHINE.x64)), { elf: true, machine: 62 });
  const macho = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]);
  assert.deepEqual(nativeKind(macho), { elf: false, kind: 'a macOS (Mach-O) binary' });
  assert.deepEqual(nativeKind(Buffer.from('MZ\x90\x00', 'latin1')), { elf: false, kind: 'a Windows (PE) binary' });
  assert.deepEqual(nativeKind(Buffer.from('hi')), { elf: false, kind: 'not a Linux (ELF) binary' });
});

test('shu-njm: a bundle for arm64 servers passes with linux-arm64 native modules and is refused with linux-x64 ones', withTmp((dir) => {
  const arm = join(dir, 'arm');
  put(join(arm, 'server.js'), 'require("next")\n');
  put(join(arm, 'node_modules', '@img', 'sharp-linux-arm64', 'lib', 'sharp-linux-arm64.node'), elf(ELF_MACHINE.arm64));
  put(join(arm, 'node_modules', '@img', 'sharp-libvips-linux-arm64', 'lib', 'libvips-cpp.so.42'), elf(ELF_MACHINE.arm64));
  assert.deepEqual(checkNativeArch(arm, 'arm64'), { checked: 1, problems: [] });
  assert.deepEqual(checkNativeArch(arm, 'x64').problems, ['"node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64.node": built for arm64, the servers are x64']);

  const x64 = join(dir, 'x64');
  put(join(x64, 'node_modules', '@img', 'sharp-linux-x64', 'lib', 'sharp-linux-x64.node'), elf(ELF_MACHINE.x64));
  assert.deepEqual(checkNativeArch(x64, 'x64'), { checked: 1, problems: [] });
  assert.deepEqual(checkNativeArch(x64, 'arm64').problems, ['"node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64.node": built for x64, the servers are arm64']);

  // No native module at all: nothing to refuse.
  const none = join(dir, 'none');
  put(join(none, 'server.js'), '');
  assert.deepEqual(checkNativeArch(none, 'arm64'), { checked: 0, problems: [] });
}));

test('shu-njm: prebuilds/<platform>-<arch>/ binaries for other targets are left alone; the server\'s own target and loose binaries are checked', withTmp((dir) => {
  const pkg = join(dir, 'node_modules', 'bufferutil', 'prebuilds');
  put(join(pkg, 'darwin-x64+arm64', 'bufferutil.node'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  put(join(pkg, 'win32-x64', 'bufferutil.node'), Buffer.from('MZ\x90\x00', 'latin1'));
  put(join(pkg, 'linux-x64', 'bufferutil.node'), elf(ELF_MACHINE.x64));
  put(join(pkg, 'linux-arm64', 'bufferutil.node'), elf(ELF_MACHINE.arm64));
  assert.deepEqual(checkNativeArch(dir, 'arm64'), { checked: 1, problems: [] });
  assert.deepEqual(checkNativeArch(dir, 'x64'), { checked: 1, problems: [] });

  // A linux-arm64 prebuild that is really x64 is wrong; so is a macOS binary outside prebuilds/.
  put(join(pkg, 'linux-arm64', 'bufferutil.node'), elf(ELF_MACHINE.x64));
  put(join(dir, 'node_modules', 'fsevents', 'fsevents.node'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  assert.deepEqual(checkNativeArch(dir, 'arm64').problems, [
    '"node_modules/bufferutil/prebuilds/linux-arm64/bufferutil.node": built for x64, the servers are arm64',
    '"node_modules/fsevents/fsevents.node": a macOS (Mach-O) binary, the servers run Linux arm64',
  ]);
}));

test('shu-njm: native-arch.mjs exits 0 on a fitting bundle, 1 with one line per wrong file, 2 on bad usage; names stay one escaped line', withTmp((dir) => {
  put(join(dir, 'a', 'ok.node'), elf(ELF_MACHINE.arm64));
  let r = spawnSync(process.execPath, [script, dir, 'arm64'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'native-arch: 1 native module(s), all linux arm64\n');

  put(join(dir, 'b', '::error::x\nevil.node'), elf(ELF_MACHINE.x64));
  r = spawnSync(process.execPath, [script, dir, 'arm64'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  const lines = r.stderr.trim().split('\n');
  assert.equal(lines.length, 2, r.stderr);
  assert.equal(lines[0], 'native-arch: "b/: :error: :x\\nevil.node": built for x64, the servers are arm64');
  assert.match(lines[1]!, /1 native module\(s\) cannot load on arm64 servers/);
  assert.ok(!r.stderr.includes('::'), 'no workflow command can form');

  for (const argv of [[], [dir], [dir, 'amd64'], [dir, 'arm64', 'x'], [join(dir, 'missing'), 'x64']]) {
    assert.equal(spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8' }).status, 2, argv.join(' '));
  }
}));

test('shu-njm: the build job runs on ubuntu-24.04-arm for an app whose servers are arm64, ubuntu-24.04 otherwise', () => {
  const pipeline = parse(readFileSync(join(root, '.github', 'workflows', 'pipeline.yml'), 'utf8'));
  const runsOn = pipeline.jobs.build['runs-on'] as string;
  const m = /^\$\{\{ (.*) \}\}$/.exec(runsOn);
  assert.ok(m, runsOn);
  // The expression only uses ==, && and || on string literals, which mean the same in JavaScript.
  assert.match(m[1]!, /^[a-z.]+ == '[a-z0-9]+' && '[a-z0-9.-]+' \|\| '[a-z0-9.-]+'$/);
  const evaluate = (arch: string | undefined) => new Function('matrix', `return ${m[1]};`)({ app: { server: { arch } } });
  assert.equal(evaluate('arm64'), 'ubuntu-24.04-arm');
  assert.equal(evaluate('x64'), 'ubuntu-24.04');
  assert.equal(evaluate(undefined), 'ubuntu-24.04');
  // The other jobs need no particular architecture.
  for (const id of ['plan', 'checks', 'smoke']) assert.equal(pipeline.jobs[id]['runs-on'], 'ubuntu-24.04', id);
  // The build step checks the bundle with native-arch.mjs before it is tarred.
  const run = (pipeline.jobs.build.steps as { name?: string; run?: string }[]).find((s) => s.name === 'Build and bundle')!.run!;
  assert.ok(run.indexOf('scripts/native-arch.mjs" "$dir" "$arch"') > 0 && run.indexOf('native-arch.mjs') < run.indexOf('tar -C'), run);
});

test('shu-njm: the CLI runs an arm64 app\'s build in a linux/arm64 container of its own image tag; everything else stays linux/amd64', () => {
  assert.equal(platformFor('arm64'), 'linux/arm64');
  assert.equal(platformFor('x64'), PROJECT_PLATFORM);
  assert.equal(PROJECT_PLATFORM, 'linux/amd64');
  assert.match(projectImage(), /^shukka-project:[0-9a-f]{16}$/);
  assert.equal(projectImage('linux/arm64'), `${projectImage()}-arm64`);
  assert.equal(projectImage(PROJECT_PLATFORM), projectImage());
  const tree = mkdtempSync(join(tmpdir(), 'shu-njm-tree-'));
  try {
    const spec = { image: projectImage('linux/arm64'), tree, cwd: tree, env: {}, cmd: 'true', args: [] };
    const arm = containerArgs({ ...spec, platform: 'linux/arm64' });
    assert.equal(arm[arm.indexOf('--platform') + 1], 'linux/arm64');
    const plain = containerArgs(spec);
    assert.equal(plain[plain.indexOf('--platform') + 1], 'linux/amd64');
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});
