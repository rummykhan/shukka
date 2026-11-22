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

const fixtures = join(import.meta.dirname, 'fixtures', 'assembly');

test('shu-9zr: the security review\'s hostile assembly (an executable asset in a manifest not named *.assets.json) is refused', () => {
  const problems = checkAssembly(join(fixtures, 'hostile')).join('\n');
  assert.match(problems, /Evil\.json: file asset abc is built by running a command/);
  assert.equal(main(['check', join(fixtures, 'hostile')]), 1);
});

test('shu-9zr: asset manifests are found through the manifest whatever their name, in nested assemblies too, and Docker entries refused there', () => {
  const dir = assembly(fileAsset({ path: 'asset.abc', packaging: 'zip' }), {
    'Other.assets': { type: 'cdk:asset-manifest', properties: { file: 'publish-plan.txt' } },
    Stage: { type: 'cdk:cloud-assembly', properties: { directoryName: 'assembly-Stage' } },
  });
  writeFileSync(join(dir, 'publish-plan.txt'), JSON.stringify({ version: '40.0.0', dockerImages: { img: { source: { directory: 'asset.abc' }, destinations: {} } } }));
  mkdirSync(join(dir, 'assembly-Stage'));
  writeFileSync(join(dir, 'assembly-Stage', 'manifest.json'), JSON.stringify({ artifacts: { 'S.assets': { type: 'cdk:asset-manifest', properties: { file: 'nested' } } } }));
  writeFileSync(join(dir, 'assembly-Stage', 'nested'), ' {"files":{"n":{"source":{"executable":["sh"]}}}}');
  const problems = checkAssembly(dir).join('\n');
  assert.match(problems, /publish-plan\.txt: Docker image asset img is not supported/);
  assert.match(problems, /assembly-Stage\/nested: file asset n is built by running a command/);
  const escape = assembly({}, { Out: { type: 'cdk:asset-manifest', properties: { file: '../outside.json' } } });
  assert.match(checkAssembly(escape).join('\n'), /artifact Out file must stay inside/);
});

test('shu-9zr: any JSON file carrying an executable or Docker asset is refused, even one no manifest names', () => {
  const dir = assembly(fileAsset({ path: 'asset.abc', packaging: 'zip' }));
  writeFileSync(join(dir, 'asset.abc', 'stray.json'), JSON.stringify({ files: { x: { source: { executable: ['sh'] } } } }));
  assert.match(checkAssembly(dir).join('\n'), /asset\.abc\/stray\.json: file asset x is built by running a command/);
});

test('shu-9zr: legacy aws:cdk:asset stack metadata and aws:asset:path outside the assembly are refused', () => {
  const legacy = assembly({}, { Old: { type: 'aws:cloudformation:stack', properties: { templateFile: 'Shukkatest-Box.template.json' }, metadata: { '/Old/Fn': [{ type: 'aws:cdk:asset', data: { path: 'asset.abc', packaging: 'zip' } }] } } });
  assert.match(checkAssembly(legacy).join('\n'), /stack Old carries legacy asset metadata/);
  const dir = assembly({});
  writeFileSync(join(dir, 'Shukkatest-Box.template.json'), JSON.stringify({ Resources: { Fn: { Type: 'AWS::Lambda::Function', Metadata: { 'aws:asset:path': '/home/runner/.ssh' } }, Ok: { Metadata: { 'aws:asset:path': 'asset.abc' } } } }));
  const problems = checkAssembly(dir);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0] as string, /resource Fn aws:asset:path must stay inside/);
});

// ---------- shu-9bj.5: stack selectors, stack names and tags never become cdk options ----------

/** An assembly whose single stack artifact is `id` with these fields merged in. */
function stackAssembly(id: string, artifact: Loose = {}): string {
  const dir = mkdtempSync(join(scratch, 'cdk.out-'));
  writeFileSync(join(dir, 'S.template.json'), '{}');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    version: '48.0.0',
    artifacts: { [id]: { type: 'aws:cloudformation:stack', ...artifact, properties: { templateFile: 'S.template.json', ...(artifact.properties ?? {}) } } },
  }));
  return dir;
}

test('shu-9bj.5: the security review\'s hostile assembly (displayName --plugin=<path>) is refused by check', () => {
  const dir = join(fixtures, 'plugin-selector');
  const problems = checkAssembly(dir);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0] as string, /manifest\.json: stack Demo displayName "--plugin=@ASSEMBLY@\/evil\.cjs" is not a stack selector/);
  assert.equal(main(['check', dir]), 1);
});

test('shu-9bj.5: a stack id or displayName that is not ^[A-Za-z0-9][A-Za-z0-9/_.-]*$ is refused; Stage/Stack names pass', () => {
  assert.deepEqual(checkAssembly(stackAssembly('Shukkatest-Box', { displayName: 'Stage/Shukkatest_Box.v2', properties: { stackName: 'Shukkatest-Box' } })), []);
  for (const bad of ['-p', '--plugin=x', 'Demo\nevil', 'a b', '', '/abs', 'é']) {
    const asId = checkAssembly(stackAssembly(bad, { properties: { stackName: 'Ok' } })).join('\n');
    assert.match(asId, / is not a stack selector/, JSON.stringify(bad));
    const asName = checkAssembly(stackAssembly('Ok', { displayName: bad, properties: { stackName: 'Ok' } })).join('\n');
    assert.match(asName, /displayName .* is not a stack selector/, JSON.stringify(bad));
  }
  assert.match(checkAssembly(stackAssembly('Ok', { displayName: 7, properties: { stackName: 'Ok' } })).join('\n'), /displayName 7 is not a stack selector/);
});

test('shu-9bj.5: a stackName that is not ^[A-Za-z][A-Za-z0-9-]{0,127}$ is refused, and so is an id used as the name', () => {
  for (const bad of ['-x', '1stack', 'a_b', 'a\nb', 'x'.repeat(129), 'a,b']) {
    assert.match(checkAssembly(stackAssembly('Ok', { properties: { stackName: bad } })).join('\n'), /stackName .* is not a CloudFormation stack name/, JSON.stringify(bad));
  }
  assert.deepEqual(checkAssembly(stackAssembly('Ok', { properties: { stackName: `a${'b'.repeat(127)}` } })), []);
  assert.match(checkAssembly(stackAssembly('Stack.v2')).join('\n'), /stack Stack\.v2 has no stackName and its id is not a CloudFormation stack name/);
});

test('shu-9bj.5: tag keys and values that start with -, break CloudFormation tag rules or cannot be one k=v token are refused', () => {
  const tagged = (tags: unknown) => checkAssembly(stackAssembly('Ok', { properties: { stackName: 'Ok', tags } })).join('\n');
  assert.equal(tagged({ Project: 'shukkatest', 'shukka:part': 'web app/v1 +@=.', 'Größe': '', [`k${'x'.repeat(127)}`]: 'v'.repeat(256) }), '');
  const cases: [unknown, RegExp][] = [
    [{ '--plugin': 'x' }, /tag key "--plugin" starts with -/],
    [{ a: '--plugin=x' }, /tag a value "--plugin=x" starts with -/],
    [{ '': 'x' }, /tag key "" must be 1 to 128 characters/],
    [{ [`k${'x'.repeat(128)}`]: 'v' }, /must be 1 to 128 characters/],
    [{ a: 'v'.repeat(257) }, /tag a value .* must be at most 256 characters/],
    [{ 'aws:cloudformation:stack-name': 'x' }, /tag key "aws:cloudformation:stack-name" uses the reserved aws: prefix/],
    [{ 'a=b': 'x' }, /tag key "a=b" contains =/],
    [{ a: 'line\nbreak' }, /tag a value "line\\nbreak" has characters CloudFormation tags do not allow/],
    [{ 'a;b': 'x' }, /tag key "a;b" has characters CloudFormation tags do not allow/],
    [{ a: 1 }, /tag a value 1 is not a string/],
    [['a=1'], /tags must be an object of strings/],
  ];
  for (const [tags, expected] of cases) assert.match(tagged(tags), expected, JSON.stringify(tags));
});

test('shu-9bj.5: stack checks reach nested assemblies too', () => {
  const dir = assembly({}, { Stage: { type: 'cdk:cloud-assembly', properties: { directoryName: 'assembly-Stage' } } });
  mkdirSync(join(dir, 'assembly-Stage'));
  writeFileSync(join(dir, 'assembly-Stage', 'manifest.json'), JSON.stringify({ artifacts: { Inner: { type: 'aws:cloudformation:stack', displayName: '--app=x', properties: { stackName: 'Inner' } } } }));
  assert.match(checkAssembly(dir).join('\n'), /assembly-Stage\/manifest\.json: stack Inner displayName "--app=x" is not a stack selector/);
});

test('shu-9bj.5: stacks (the GITHUB_OUTPUT value) contains only validated names and fails, printing nothing, on any other', () => {
  assert.deepEqual(stackNames(stackAssembly('Ok', { properties: { stackName: 'Shukkatest-Box' } })), ['Shukkatest-Box']);
  const writes: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((t: string) => { writes.push(t); return true; }) as typeof process.stdout.write;
  const errWrite = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    for (const bad of ['Box\nstacks=Evil', 'a,b', '--plugin=x']) {
      const dir = stackAssembly('Ok', { properties: { stackName: bad } });
      assert.throws(() => stackNames(dir), /is not a CloudFormation stack name/);
      assert.equal(main(['stacks', dir]), 1);
    }
    assert.equal(main(['stacks', stackAssembly('Box\nstacks=Evil')]), 1, 'an id used as the name is checked too');
  } finally {
    process.stdout.write = write;
    process.stderr.write = errWrite;
  }
  assert.deepEqual(writes, [], 'nothing reaches stdout (and so GITHUB_OUTPUT)');
});
