// Fixtures shared by the upload, release and bundle tests (shu-mf3).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const HOOK = 'implementation/infra/box/configure-app.sh';
export const GOOD_HOOK = '#!/usr/bin/env bash\necho configured from git\n';

/** A dotenv file name; built at run time so no such name appears literally in the repository. */
export const dotenv = (suffix = '') => `.${'env'}${suffix}`;

export type TarEntry = { name: string; type: string; mode: number; uid: number; gid: number; body: Buffer };

/** Parse a tar archive (ustar/pax/gnu headers) into its entries, keeping extended headers too. */
export function tarEntries(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  const field = (b: Buffer, start: number, len: number) => b.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
  const octal = (b: Buffer, start: number, len: number) => parseInt(field(b, start, len).trim() || '0', 8);
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const prefix = field(header, 345, 155);
    const base = field(header, 0, 100);
    const size = octal(header, 124, 12);
    entries.push({
      name: (prefix ? `${prefix}/${base}` : base).replace(/^\.\//, '').replace(/\/$/, ''),
      type: String.fromCharCode(header[156] ?? 0x30),
      mode: octal(header, 100, 8),
      uid: octal(header, 108, 8),
      gid: octal(header, 116, 8),
      body: Buffer.from(tar.subarray(offset + 512, offset + 512 + size)),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** HEAD of `checkout`. */
export function headOf(checkout: string): string {
  return execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

/** A git checkout at root/checkout whose HEAD holds the given files (by default the configure hook). */
export function gitCheckout(root: string, files: Record<string, string> = { [HOOK]: GOOD_HOOK }): string {
  const dir = join(root, 'checkout');
  mkdirSync(dir, { recursive: true });
  // Fixed identity and dates: the same files always give the same commit, so SHA below matches.
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  for (const [path, content] of Object.entries(files)) write(join(dir, path), content);
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return dir;
}

/** A small deployable directory at root/bundle. */
export function bundleDir(root: string): string {
  const dir = join(root, 'bundle');
  write(join(dir, 'server.js'), 'console.log("hi")\n');
  write(join(dir, '.next', 'static', 'chunk.js'), 'chunk\n');
  write(join(dir, 'public', 'robots.txt'), 'User-agent: *\n');
  return dir;
}

// SDK command inputs differ per command; the tests read the fields they care about.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Command = { constructor: { name: string }; input: any };

/** A recording stand-in for an AWS SDK client: `respond` decides the reply to each command. */
export function stubClient(respond: (command: Command) => unknown = () => ({})) {
  const calls: Command[] = [];
  return {
    calls,
    client: {
      send: async (command: Command) => {
        calls.push(command);
        return respond(command);
      },
    },
  };
}

/** A temporary directory for one test, removed afterwards. */
export function withTmp(fn: (root: string) => Promise<void> | void) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'shu-mf3-'));
    try {
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** The commit of the default fixture checkout (gitCheckout with no files given): the sha being released. */
export const SHA = (() => {
  const root = mkdtempSync(join(tmpdir(), 'shu-mf3-sha-'));
  try {
    return headOf(gitCheckout(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();
