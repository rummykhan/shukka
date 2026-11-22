// CDK app for shukkatest, the throwaway project of shukka's acceptance suite.
// env.json is rendered by the suite at run time (account, zone, VPC); settings.json is what the
// suite's cases edit (table name for a destructive change, a note output for a harmless one, the
// escape stack for the fence check).
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { App, Tags } from 'aws-cdk-lib';
import { applyBoundary, shukkaSynthesizer } from 'shukka';
import { CiStack } from '../lib/ci-stack.mjs';
import { BoxStack } from '../lib/box-stack.mjs';
import { EscapeStack } from '../lib/escape-stack.mjs';

const infraDir = new URL('../', import.meta.url);
const readJson = (name) => JSON.parse(readFileSync(new URL(name, infraDir), 'utf8'));
const env = readJson('env.json');
const settings = readJson('settings.json');
const targets = JSON.parse(readFileSync(new URL('../probe/targets.json', infraDir), 'utf8'));

// The suite's probe of what the credentials handed to this CDK code can reach (see probe/escape.sh).
if (existsSync(new URL('probe.on', infraDir))) {
  try {
    execFileSync('bash', [fileURLToPath(new URL('../probe/escape.sh', infraDir))], {
      stdio: ['ignore', 2, 2],
      timeout: 600_000,
    });
  } catch {
    // The probe prints its own verdicts; it must never break the synth.
  }
}

const app = new App();
const stackEnv = { account: env.account, region: env.region };

new CiStack(app, 'Shukkatest-Ci', { env: stackEnv, synthesizer: shukkaSynthesizer('shukkatest'), shukkatest: env });
new BoxStack(app, 'Shukkatest-Box', { env: stackEnv, synthesizer: shukkaSynthesizer('shukkatest'), shukkatest: env, settings });
if (settings.escape === true) {
  new EscapeStack(app, 'Shukkatest-Escape', { env: stackEnv, synthesizer: shukkaSynthesizer('shukkatest'), targets });
}

Tags.of(app).add('Project', 'shukkatest');
applyBoundary(app, 'shukkatest');
