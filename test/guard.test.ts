import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const guardPath = fileURLToPath(new URL('../scripts/guard.mjs', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/diff/', import.meta.url));
const closing = '✨  Number of stacks with differences: 1';
const ESC = '\x1b';

function runGuard(input: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [guardPath, ...args], { input, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function fixture(name: string): string {
  return readFileSync(join(fixtures, name), 'utf8');
}

// The 12 cases of Trendigle's diff-guard.test.sh. Its helper prints the diff text, then the
// closing line (or the fifth argument instead), each followed by a newline.
const trendigle: Array<[string, number, string[], string, string?]> = [
  ['an added table passes', 0, [], 'Stack Trendigle-prod-Data\nResources\n[+] AWS::DynamoDB::Table Table-login_attempts Tableloginattempts0F97B133'],
  ['no differences passes', 0, [], 'Stack Trendigle-prod-Dns\nThere were no differences'],
  ['an in-place change passes', 0, [], '[~] AWS::IAM::Policy DeployRole/DefaultPolicy DeployRoleDefaultPolicy1234\n └─ [~] PolicyDocument'],
  ['a removed resource stops', 1, [], '[-] AWS::DynamoDB::Table Table-media Tablemedia1234 orphan'],
  ['a replaced server stops', 1, [], '[~] AWS::EC2::Instance Box Box1234 replace\n └─ [~] ImageId (requires replacement)'],
  ['a possible replacement stops', 1, [], '[~] AWS::EC2::Instance Box Box1234 may be replaced\n └─ [~] UserData (may cause replacement)'],
  ['a replacement is allowed on purpose', 0, ['--allow'], '[~] AWS::EC2::Instance Box Box1234 replace'],
  ['a removed policy line inside a change passes', 0, [], '[~] AWS::IAM::Policy X X1\n └─ [~] PolicyDocument\n     └─ [-] old statement'],
  ['a coloured removal still stops', 1, [], '\x1b[31m[-]\x1b[39m AWS::DynamoDB::Table Table-media Tablemedia1234 \x1b[31mdestroy\x1b[39m'],
  ['a coloured replacement still stops', 1, [], '\x1b[33m[~]\x1b[39m AWS::EC2::Instance Box Box1234 \x1b[31mreplace\x1b[39m'],
  ['an empty diff stops', 1, [], '', ''],
  ['a diff with no closing line stops', 1, [], 'Stack Trendigle-prod-Dns\nThere were no differences', ''],
];

for (const [name, expected, args, diff, last] of trendigle) {
  test(`shu-bp6: Trendigle case: ${name}`, () => {
    const { code, stdout } = runGuard(`${diff}\n${last ?? closing}\n`, args);
    assert.equal(code, expected, stdout);
  });
}

test('shu-bp6: a stop prints the offending lines', () => {
  const { code, stdout } = runGuard(`[~] AWS::EC2::Instance Box Box1234 replace\n └─ [~] ImageId (requires replacement)\n${closing}\n`);
  assert.equal(code, 1);
  assert.match(stdout, /^\[~\] AWS::EC2::Instance Box Box1234 replace$/m);
  assert.match(stdout, /^ └─ \[~\] ImageId \(requires replacement\)$/m);
});

test('shu-bp6: an incomplete diff says so', () => {
  const { code, stdout } = runGuard('Stack X\nThere were no differences\n');
  assert.equal(code, 1);
  assert.match(stdout, /incomplete/);
});

// Real `cdk diff` outputs recorded by the security reviewer (shu: sec-b04).
const recordedStops: Array<[string, string, RegExp[]]> = [
  ['removed table, orphan and destroy', 'removed.txt', [/^\[-\] AWS::DynamoDB::Table GoneRetain orphan$/m, /^\[-\] AWS::DynamoDB::Table GoneDelete destroy$/m]],
  ['removed table, as GitHub Actions prints it', 'removed-gha.txt', [/GoneRetain orphan/, /GoneDelete destroy/]],
  ['removed table, in colour', 'removed-color.txt', [/^\[-\] AWS::DynamoDB::Table GoneRetain orphan$/m, /^\[-\] AWS::DynamoDB::Table GoneDelete destroy$/m]],
  ['replaced table name', 'renamed.txt', [/^\[~\] AWS::DynamoDB::Table Table-users Tableusers60537A7D replace$/m, /TableName \(requires replacement\)/]],
  ['AMI change', 'ami.txt', [/^\[~\] AWS::EC2::Instance Box BoxA0510527 replace$/m, /ImageId \(requires replacement\)/]],
  ['AMI change, as GitHub Actions prints it', 'ami-gha.txt', [/Box BoxA0510527 replace/]],
  ['AMI change, in colour', 'ami-color.txt', [/^\[~\] AWS::EC2::Instance Box BoxA0510527 replace$/m, /ImageId \(requires replacement\)/]],
  ['bucket rename', 'bucket.txt', [/^\[~\] AWS::S3::Bucket DeployBucket DeployBucket67E2C076 replace$/m, /BucketName \(requires replacement\)/, /DeployBucketPolicyCED076FF replace$/m]],
  ['instance type (may be replaced)', 'insttype.txt', [/^\[~\] AWS::EC2::Instance Box BoxA0510527 may be replaced$/m, /InstanceType \(may cause replacement\)/]],
  ['user data (may be replaced)', 'userdata.txt', [/^\[~\] AWS::EC2::Instance Box BoxA0510527 may be replaced$/m, /UserData \(may cause replacement\)/]],
  ['type change', 'typechange.txt', [/^\[~\] AWS::EC2::EIP Eip Eip replace$/m]],
];

for (const [name, file, expectedLines] of recordedStops) {
  test(`shu-bp6: recorded sample stops it: ${name}`, () => {
    const { code, stdout } = runGuard(fixture(file));
    assert.equal(code, 1, stdout);
    for (const line of expectedLines) assert.match(stdout, line);
  });
}

test('shu-bp6: recorded sample with no differences passes', () => {
  const { code, stdout } = runGuard(fixture('same.txt'));
  assert.equal(code, 0, stdout);
});

test('shu-bp6: the removed Output in a recorded sample is not reported', () => {
  const { stdout } = runGuard(fixture('removed.txt'));
  assert.doesNotMatch(stdout, /OldOut/);
});

test('shu-bp6: colour codes are stripped before matching and in what is printed', () => {
  const coloured = fixture('removed-color.txt');
  assert.ok(coloured.includes(ESC + '['), 'the sample is coloured');
  const { code, stdout } = runGuard(coloured);
  assert.equal(code, 1);
  assert.ok(!stdout.includes(ESC), 'no colour codes printed');
  assert.match(stdout, /^\[-\] AWS::DynamoDB::Table GoneDelete destroy$/m);
});

test('shu-bp6: a coloured closing line still counts as complete', () => {
  const { code, stdout } = runGuard('Stack X\nThere were no differences\n\x1b[1m✨  Number of stacks with differences:\x1b[22m 0\n');
  assert.equal(code, 0, stdout);
});

test('shu-bp6: a removed Output alone passes', () => {
  const plain = 'Stack Trendigle-prod-Data\nOutputs\n[-] Output OldOut: {"Value":"x"}\n' + closing + '\n';
  assert.equal(runGuard(plain).code, 0);
  const coloured = 'Stack Trendigle-prod-Data\n\x1b[0m\x1b[4m\x1b[1mOutputs\x1b[22m\x1b[24m\x1b[0m\n\x1b[0m\x1b[31m[-]\x1b[39m \x1b[36mOutput\x1b[39m OldOut: \x1b[31m{"Value":"x"}\x1b[39m\x1b[0m\n' + closing + '\n';
  const { code, stdout } = runGuard(coloured);
  assert.equal(code, 0, stdout);
});

test('shu-bp6: a removed Output next to a removed resource still stops on the resource', () => {
  const { code, stdout } = runGuard(`[-] AWS::SNS::Topic T T1 destroy\n[-] Output OldOut: {"Value":"x"}\n${closing}\n`);
  assert.equal(code, 1);
  assert.match(stdout, /AWS::SNS::Topic T T1 destroy/);
  assert.doesNotMatch(stdout, /OldOut/);
});

test('shu-bp6: --allow turns a stop into exit 0 with a notice naming what was allowed', () => {
  const { code, stdout } = runGuard(fixture('removed.txt'), ['--allow']);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /allowed/i);
  assert.match(stdout, /^\[-\] AWS::DynamoDB::Table GoneRetain orphan$/m);
  assert.match(stdout, /^\[-\] AWS::DynamoDB::Table GoneDelete destroy$/m);
});

test('shu-bp6: --allow does not make an incomplete diff pass', () => {
  const { code } = runGuard('Stack X\n[~] AWS::EC2::Instance Box Box1234 replace\n', ['--allow']);
  assert.equal(code, 1);
});

test('shu-bp6: an unknown argument is refused', () => {
  const { code, stderr } = runGuard(fixture('same.txt'), ['allow']);
  assert.equal(code, 2);
  assert.match(stderr, /unknown argument/);
});

function withSummary(fn: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'shu-bp6-'));
  try {
    fn(join(dir, 'summary.md'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('shu-bp6: --summary writes a ### Guard section naming what stopped it', () => {
  withSummary((file) => {
    writeFileSync(file, '### Infrastructure changes\n\nearlier step\n');
    const { code } = runGuard(fixture('bucket.txt'), ['--summary', file]);
    assert.equal(code, 1);
    const md = readFileSync(file, 'utf8');
    assert.ok(md.startsWith('### Infrastructure changes\n\nearlier step\n'), 'appends, keeps what was there');
    assert.match(md, /^### Guard$/m);
    assert.match(md, /stopp/i);
    assert.match(md, /AWS::S3::Bucket DeployBucket DeployBucket67E2C076 replace/);
    assert.ok(!md.includes(ESC), 'no colour codes in the summary');
  });
});

test('shu-bp6: --summary on a safe diff says nothing is deleted or replaced', () => {
  withSummary((file) => {
    const { code } = runGuard(fixture('same.txt'), ['--summary', file]);
    assert.equal(code, 0);
    const md = readFileSync(file, 'utf8');
    assert.match(md, /^### Guard$/m);
    assert.match(md, /nothing is deleted or replaced/i);
  });
});

test('shu-bp6: --summary with --allow says what was allowed', () => {
  withSummary((file) => {
    const { code } = runGuard(fixture('removed.txt'), ['--allow', '--summary', file]);
    assert.equal(code, 0);
    const md = readFileSync(file, 'utf8');
    assert.match(md, /^### Guard$/m);
    assert.match(md, /allowed/i);
    assert.match(md, /GoneDelete destroy/);
  });
});

test('shu-bp6: --summary on an incomplete diff says it is incomplete', () => {
  withSummary((file) => {
    const { code } = runGuard('', ['--summary', file]);
    assert.equal(code, 1);
    assert.match(readFileSync(file, 'utf8'), /^### Guard$[\s\S]*incomplete/m);
  });
});

test('shu-bp6: --summary without a file is refused', () => {
  const { code, stderr } = runGuard(fixture('same.txt'), ['--summary']);
  assert.equal(code, 2);
  assert.match(stderr, /--summary/);
});

test('shu-9bj.12: with --project the guard says when the diff changes the CI stack, which only an admin deploys; the verdict is unchanged', () => {
  const changed = `${ESC}[1mStack ${ESC}[1mShukkatest-Ci${ESC}[22m\nIAM Statement Changes\nResources\n[~] AWS::IAM::Role InfraRole InfraRole1234\n\nStack Shukkatest-Box\nThere were no differences\n\n${closing}\n`;
  const notice = /^guard: Shukkatest-Ci changes, and the pipeline never deploys it: an admin deploys it by hand \(npx cdk deploy Shukkatest-Ci with admin credentials, README step 5\)$/m;
  const dir = mkdtempSync(join(tmpdir(), 'shu-9bj12-guard-'));
  try {
    const summary = join(dir, 'summary.md');
    const r = runGuard(changed, ['--project', 'shukkatest', '--summary', summary]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^guard: nothing is deleted or replaced$/m);
    assert.match(r.stdout, notice);
    assert.match(readFileSync(summary, 'utf8'), /\*\*Admin deploy needed:\*\* Shukkatest-Ci changes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // No changes to the CI stack, no CI stack, or no --project: no notice.
  const same = `Stack Shukkatest-Ci\nThere were no differences\n\nStack Shukkatest-Box\nResources\n[+] AWS::SNS::Topic T T1\n\n${closing}\n`;
  assert.doesNotMatch(runGuard(same, ['--project', 'shukkatest']).stdout, /admin/);
  assert.doesNotMatch(runGuard(`Stack Shukkatest-Box\n[+] AWS::SNS::Topic T T1\n\n${closing}\n`, ['--project', 'shukkatest']).stdout, /admin/);
  assert.doesNotMatch(runGuard(changed).stdout, /admin/);
  // Another project's CI stack is not this one's.
  assert.doesNotMatch(runGuard(changed, ['--project', 'acme']).stdout, /admin/);
  assert.equal(runGuard(changed, ['--project', '--allow']).code, 2);
});
