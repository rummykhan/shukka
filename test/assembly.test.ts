import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAssembly, main, stackNames } from '../scripts/assembly.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'shu-9zr-assembly-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

function assembly(assets: Loose, manifestExtra: Loose = {}): string {
  const dir = mkdtempSync(join(scratch, 'cdk.out-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    version: '40.0.0',
    artifacts: {
      'Shukkatest-Box.assets': { type: 'cdk:asset-manifest', properties: { file: 'Shukkatest-Box.assets.json' } },
      'Shukkatest-Box': { type: 'aws:cloudformation:stack', properties: { templateFile: 'Shukkatest-Box.template.json', stackName: 'Shukkatest-Box' } },
      Named: { type: 'aws:cloudformation:stack', properties: { templateFile: 'Named.template.json', stackName: 'shukkatest-named' } },
      ...manifestExtra,
    },
  }));
  writeFileSync(join(dir, 'Shukkatest-Box.template.json'), '{}');
  writeFileSync(join(dir, 'Shukkatest-Box.assets.json'), JSON.stringify({ version: '40.0.0', files: {}, dockerImages: {}, ...assets }));
  mkdirSync(join(dir, 'asset.abc'));
  writeFileSync(join(dir, 'asset.abc', 'index.js'), 'x');
  return dir;
}

const fileAsset = (source: Loose) => ({ files: { abc: { source, destinations: {} } } });

test('shu-9zr: a plain assembly passes and lists its stacks by CloudFormation name', () => {
  const dir = assembly(fileAsset({ path: 'asset.abc', packaging: 'zip' }));
  assert.deepEqual(checkAssembly(dir), []);
  assert.deepEqual(stackNames(dir), ['Shukkatest-Box', 'shukkatest-named']);
  assert.equal(main(['check', dir]), 0);
});

test('shu-9zr: a file asset built by a command (source.executable) is refused', () => {
  const dir = assembly(fileAsset({ executable: ['sh', '-c', 'env > /tmp/x'], packaging: 'file' }));
  assert.match(checkAssembly(dir).join('\n'), /file asset abc is built by running a command/);
  assert.equal(main(['check', dir]), 1);
});

test('shu-9zr: Docker image assets are refused', () => {
  const dir = assembly({ dockerImages: { img: { source: { directory: 'asset.abc' }, destinations: {} } } });
  assert.match(checkAssembly(dir).join('\n'), /Docker image asset img is not supported/);
});

test('shu-9zr: asset sources and manifest files outside the assembly are refused', () => {
  assert.match(checkAssembly(assembly(fileAsset({ path: '/home/runner/.aws', packaging: 'zip' }))).join('\n'), /source path must stay inside/);
  assert.match(checkAssembly(assembly(fileAsset({ path: '../../.shukka', packaging: 'zip' }))).join('\n'), /source path must stay inside/);
  const nested = assembly({}, { Stage: { type: 'cdk:cloud-assembly', properties: { directoryName: '/etc' } } });
  assert.match(checkAssembly(nested).join('\n'), /artifact Stage directoryName must stay inside/);
  const template = assembly({}, { Evil: { type: 'aws:cloudformation:stack', properties: { templateFile: '/proc/self/environ' } } });
  assert.match(checkAssembly(template).join('\n'), /artifact Evil templateFile must stay inside/);
});

test('shu-9zr: a symbolic link out of the assembly is refused; one inside it is fine', () => {
  const dir = assembly(fileAsset({ path: 'asset.abc', packaging: 'zip' }));
  symlinkSync('index.js', join(dir, 'asset.abc', 'inside.js'));
  assert.deepEqual(checkAssembly(dir), []);
  symlinkSync(tmpdir(), join(dir, 'asset.abc', 'out'));
  assert.match(checkAssembly(dir).join('\n'), /asset\.abc\/out links outside the assembly/);
});

test('shu-9zr: a missing manifest and bad usage fail', () => {
  assert.match(checkAssembly(join(scratch, 'nope')).join('\n'), /cannot read/);
  assert.equal(main(['check']), 2);
  assert.equal(main(['run', scratch]), 2);
});
