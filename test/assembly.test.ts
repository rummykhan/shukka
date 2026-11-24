import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapVersionArgs, checkAssembly, ciStackName, ciPublishProblems, ciStackPlan, deployCommands, main, stackNames } from '../scripts/assembly.mjs';

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

// A stack as shukkaSynthesizer emits it (deploy and execution roles) and as shukkaCiSynthesizer emits it (neither).
const ROLES = {
  assumeRoleArn: 'arn:${AWS::Partition}:iam::123456789012:role/cdk-shukkatest-deploy-role-123456789012-us-east-1',
  cloudFormationExecutionRoleArn: 'arn:${AWS::Partition}:iam::123456789012:role/cdk-shukkatest-cfn-exec-role-123456789012-us-east-1',
};
function rolesAssembly(stacks: Record<string, Loose>, nested?: Record<string, Loose>): string {
  const dir = mkdtempSync(join(scratch, 'cdk.out-'));
  const artifacts: Loose = {};
  for (const [id, props] of Object.entries(stacks)) {
    artifacts[id] = { type: 'aws:cloudformation:stack', properties: { templateFile: `${id}.template.json`, ...props } };
    writeFileSync(join(dir, `${id}.template.json`), '{}');
  }
  if (nested) {
    artifacts.Stage = { type: 'cdk:cloud-assembly', properties: { directoryName: 'stage' } };
    mkdirSync(join(dir, 'stage'));
    const inner: Loose = {};
    for (const [id, props] of Object.entries(nested)) {
      inner[id] = { type: 'aws:cloudformation:stack', properties: { templateFile: `${id}.template.json`, ...props } };
      writeFileSync(join(dir, 'stage', `${id}.template.json`), '{}');
    }
    writeFileSync(join(dir, 'stage', 'manifest.json'), JSON.stringify({ version: '40.0.0', artifacts: inner }));
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: '40.0.0', artifacts }));
  return dir;
}

test('shu-9bj.12: the CI stack is <Project>-Ci', () => {
  assert.equal(ciStackName('shukkatest'), 'Shukkatest-Ci');
  assert.equal(ciStackName('acme'), 'Acme-Ci');
});

test('shu-9bj.12: with --project only <Project>-Ci may name no deploy or execution role; any other stack name is refused', () => {
  const ok = rolesAssembly({ 'Shukkatest-Ci': {}, 'Shukkatest-Box': ROLES });
  assert.deepEqual(checkAssembly(ok, { project: 'shukkatest' }), []);
  assert.equal(main(['check', ok, '--project', 'shukkatest']), 0);

  const other = rolesAssembly({ 'Shukkatest-Ci': {}, 'Shukkatest-Box': {} });
  const problems = checkAssembly(other, { project: 'shukkatest' });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0]!, /stack Shukkatest-Box names no assumeRoleArn and no cloudFormationExecutionRoleArn: only Shukkatest-Ci may deploy with the caller's own credentials/);
  assert.equal(main(['check', other, '--project', 'shukkatest']), 1);

  // Another project's CI stack name, a stackName that is not the CI stack's, a CI stack in a nested assembly.
  assert.match(checkAssembly(rolesAssembly({ 'Acme-Ci': {} }), { project: 'shukkatest' }).join('\n'), /stack Acme-Ci names no assumeRoleArn/);
  assert.match(checkAssembly(rolesAssembly({ 'Shukkatest-Ci': { stackName: 'Shukkatest-Box' } }), { project: 'shukkatest' }).join('\n'), /stack Shukkatest-Ci names no assumeRoleArn/);
  assert.match(checkAssembly(rolesAssembly({}, { 'Shukkatest-Ci': {} }), { project: 'shukkatest' }).join('\n'), /stage\/manifest.json: stack Shukkatest-Ci names no/);
  // Half a synthesizer (a deploy role but CloudFormation acting as it) is refused, the CI stack included.
  for (const id of ['Shukkatest-Ci', 'Shukkatest-Box']) {
    assert.match(checkAssembly(rolesAssembly({ [id]: { assumeRoleArn: ROLES.assumeRoleArn } }), { project: 'shukkatest' }).join('\n'), /names no cloudFormationExecutionRoleArn: only Shukkatest-Ci/);
  }
  // The CI stack may still use shukkaSynthesizer (it is never deployed by the pipeline either way).
  assert.deepEqual(checkAssembly(rolesAssembly({ 'Shukkatest-Ci': ROLES }), { project: 'shukkatest' }), []);
  // Without --project the check is the asset check alone; a bad --project is a usage error.
  assert.deepEqual(checkAssembly(other), []);
  assert.equal(main(['check', ok, '--project', '--all']), 2);
  assert.equal(main(['check', ok, '--project']), 2);
});

test('shu-9bj.12: deployCommands leaves the CI stack out and never lets cdk pull it in', () => {
  const tags = { Project: 'shukkatest' };
  const same = {
    'Shukkatest-Ci.assets': { type: 'cdk:asset-manifest' },
    'Shukkatest-Ci': { type: 'aws:cloudformation:stack', displayName: 'Shukkatest-Ci', properties: { tags }, dependencies: ['Shukkatest-Box', 'Shukkatest-Ci.assets'] },
    'Shukkatest-Box': { type: 'aws:cloudformation:stack', displayName: 'Shukkatest-Box', properties: { tags }, dependencies: [] },
    'shukkatest-data': { type: 'aws:cloudformation:stack', properties: { tags, stackName: 'shukkatest-data' }, dependencies: ['Shukkatest-Ci'] },
  };
  assert.deepEqual(deployCommands(same, 'shukkatest', 'abc'), {
    commands: [['--exclusively', 'Shukkatest-Box', 'shukkatest-data', '--tags=Project=shukkatest', '--tags=shukka:revision=abc']],
    skipped: ['Shukkatest-Ci'],
  });
  const each = {
    'Shukkatest-Ci': { type: 'aws:cloudformation:stack', properties: { tags: { ...tags, Part: 'Ci' } } },
    'Shukkatest-Box': { type: 'aws:cloudformation:stack', properties: { tags: { ...tags, Part: 'Box' } }, dependencies: ['Shukkatest-Ci', 'shukkatest-data'] },
    'shukkatest-data': { type: 'aws:cloudformation:stack', properties: { tags: { ...tags, Part: 'Data' } } },
  };
  assert.deepEqual(deployCommands(each, 'shukkatest', 'abc'), {
    commands: [
      ['--exclusively', 'shukkatest-data', '--tags=Project=shukkatest', '--tags=Part=Data', '--tags=shukka:revision=abc'],
      ['--exclusively', 'Shukkatest-Box', '--tags=Project=shukkatest', '--tags=Part=Box', '--tags=shukka:revision=abc'],
    ],
    skipped: ['Shukkatest-Ci'],
  });
  // No CI stack in the app: unchanged, one --all.
  const noCi = Object.fromEntries(Object.entries(same).filter(([id]) => !id.startsWith('Shukkatest-Ci')));
  assert.deepEqual(deployCommands(noCi, 'shukkatest', 'abc').commands, [['--all', '--tags=Project=shukkatest', '--tags=shukka:revision=abc']]);
  // Only the CI stack: nothing to deploy.
  assert.deepEqual(deployCommands({ 'Shukkatest-Ci': same['Shukkatest-Ci'] }, 'shukkatest', 'abc'), { commands: [], skipped: ['Shukkatest-Ci'] });
  // The CI stack is matched by CloudFormation name, not by artifact id.
  assert.deepEqual(deployCommands({ X: { type: 'aws:cloudformation:stack', properties: { stackName: 'Shukkatest-Ci' } } }, 'shukkatest', 'abc').skipped, ['X']);
  assert.throws(() => deployCommands({ '--plugin=x': { type: 'aws:cloudformation:stack' } }, 'shukkatest', 'abc'), /could be read as a cdk option/);
});

test('shu-ecn: ciStackPlan deploys exactly <Project>-Ci, synthesized for the caller\'s credentials and depending on nothing but its own assets', () => {
  const stack = (extra: Loose = {}) => ({ type: 'aws:cloudformation:stack', displayName: 'Shukkatest-Ci', properties: {}, dependencies: ['Shukkatest-Ci.assets'], ...extra });
  const base = { 'Shukkatest-Ci.assets': { type: 'cdk:asset-manifest' }, 'Shukkatest-Box.assets': { type: 'cdk:asset-manifest' }, 'Shukkatest-Box': { type: 'aws:cloudformation:stack', properties: ROLES } };
  assert.deepEqual(ciStackPlan({ ...base, 'Shukkatest-Ci': stack() }, 'shukkatest'), { selector: 'Shukkatest-Ci', problems: [] });
  assert.deepEqual(ciStackPlan({ ...base, 'Shukkatest-Ci': stack({ dependencies: [] }) }, 'shukkatest').problems, []);
  const refused = (artifacts: Loose, re: RegExp) => {
    const plan = ciStackPlan(artifacts, 'shukkatest');
    assert.equal(plan.selector, null);
    assert.match(plan.problems.join('\n'), re);
  };
  refused({ ...base, 'Shukkatest-Ci': stack({ dependencies: ['Shukkatest-Ci.assets', 'Shukkatest-Box'] }) }, /depends on "Shukkatest-Box": the CI stack must depend on nothing but its own assets/);
  refused({ ...base, 'Shukkatest-Ci': stack({ dependencies: ['Shukkatest-Box.assets'] }) }, /depends on "Shukkatest-Box.assets"/);
  refused({ ...base, 'Shukkatest-Ci': stack({ properties: ROLES }) }, /names a deploy or execution role: synthesize it with shukkaCiSynthesizer/);
  refused(base, /the app has no stack named Shukkatest-Ci/);
  refused({ ...base, 'Shukkatest-Ci': stack({ displayName: '--plugin=x' }) }, /could be read as a cdk option/);
});

test('shu-ecn: ciPublishProblems accepts what shukkaCiSynthesizer writes and refuses a foreign bucket, an extra asset, an assumeRoleArn and a foreign lookup role', () => {
  const dir = mkdtempSync(join(scratch, 'ci-publish-'));
  const env = { dir, account: '123456789012', region: 'us-east-1', qualifier: 'shukkatest' };
  const bucket = 'cdk-shukkatest-assets-123456789012-us-east-1';
  const dest = { bucketName: bucket, objectKey: 'h.json', region: 'us-east-1' };
  const lookupRole = { arn: 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-shukkatest-deploy-role-${AWS::AccountId}-${AWS::Region}', bootstrapStackVersionSsmParameter: '/cdk-bootstrap/shukkatest/version' };
  const check = (props: Loose = {}, files: Loose = {}, d: Loose = dest) => {
    writeFileSync(join(dir, 'Shukkatest-Ci.assets.json'), JSON.stringify({ files: { h: { source: { path: 'Shukkatest-Ci.template.json', packaging: 'file' }, destinations: { a: d } }, ...files } }));
    const artifacts = {
      'Shukkatest-Ci.assets': { type: 'cdk:asset-manifest', properties: { file: 'Shukkatest-Ci.assets.json' } },
      'Shukkatest-Ci': { type: 'aws:cloudformation:stack', environment: 'aws://123456789012/us-east-1', dependencies: ['Shukkatest-Ci.assets'], properties: { templateFile: 'Shukkatest-Ci.template.json', stackTemplateAssetObjectUrl: `s3://${bucket}/h.json`, lookupRole, ...props } },
    };
    return ciPublishProblems(artifacts, 'Shukkatest-Ci', 'Shukkatest-Ci', env).join('\n');
  };
  assert.equal(check(), '');
  assert.equal(check({ lookupRole: { arn: 'arn:aws:iam::123456789012:role/cdk-shukkatest-deploy-role-123456789012-us-east-1' } }), '', 'the resolved ARN too');
  assert.match(check({ stackTemplateAssetObjectUrl: 's3://otherproject-deploy-123456789012/releases/app.tar.gz' }, {}, { bucketName: 'otherproject-deploy-123456789012', objectKey: 'releases/app.tar.gz', region: 'us-east-1' }), /not the project's bootstrap bucket/);
  assert.match(check({}, { x: { source: { path: 'app.tar.gz' }, destinations: { a: dest } } }), /2 file assets/);
  assert.match(check({}, {}, { ...dest, assumeRoleArn: 'arn:aws:iam::999999999999:role/x' }), /published as the role/);
  assert.match(check({ lookupRole: { arn: 'arn:aws:iam::999999999999:role/x' } }), /lookup role is "arn:aws:iam::999999999999:role\/x"/);
  assert.match(check({ lookupRole: undefined }), /lookup role is null/);
  assert.match(check({}, {}, { ...dest, region: 'eu-west-1' }), /region "eu-west-1"/);
  assert.match(check({ templateFile: 'Other.template.json' }), /is not its template file/);
  // ciStackPlan applies it when given the environment.
  assert.equal(ciStackPlan({
    'Shukkatest-Ci.assets': { type: 'cdk:asset-manifest', properties: { file: 'Shukkatest-Ci.assets.json' } },
    'Shukkatest-Ci': { type: 'aws:cloudformation:stack', dependencies: ['Shukkatest-Ci.assets'], properties: { lookupRole: { arn: 'arn:aws:iam::999999999999:role/x' } } },
  }, 'shukkatest', env).selector, null);
});

test('shu-r5f: bootstrapVersionArgs names the qualifier\'s version parameter and refuses anything but a valid qualifier', () => {
  assert.deepEqual(bootstrapVersionArgs('trendigle'), ['--parameters', 'BootstrapVersion=/cdk-bootstrap/trendigle/version']);
  for (const bad of ['', 'Trendigle', 'a b', '--plugin=x', 'q/../x', 'abcdefghijk', undefined, null, 7]) {
    assert.throws(() => bootstrapVersionArgs(bad as unknown as string), /qualifier .* must match/, JSON.stringify(bad));
  }
});
