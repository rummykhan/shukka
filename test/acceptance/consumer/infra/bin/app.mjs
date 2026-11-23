// CDK app for shukkatest, the throwaway project of shukka's acceptance suite.
// env.json is rendered by the suite at run time (account, zone, VPC); settings.json is what the
// suite's cases edit (table name for a destructive change, a note output for a harmless one, the
// escape stack for the fence check, the planted executable asset for the assembly check).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { applyBoundary, shukkaCiSynthesizer, shukkaSynthesizer, tagProject } from 'shukka';
import { CiStack } from '../lib/ci-stack.mjs';
import { BoxStack } from '../lib/box-stack.mjs';
import { EscapeStack } from '../lib/escape-stack.mjs';

const infraDir = new URL('../', import.meta.url);
const readJson = (name) => JSON.parse(readFileSync(new URL(name, infraDir), 'utf8'));
const env = readJson('env.json');
const settings = readJson('settings.json');
const targets = JSON.parse(readFileSync(new URL('../probe/targets.json', infraDir), 'utf8'));

// The suite's probe of what this CDK code holds while shukka synthesizes it: since shu-9zr it runs in
// a job without id-token, so it must find no token and no credentials (see probe/escape.sh).
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

// The CI stack is deployed by hand with admin credentials (setup_ci_stack), never by the pipeline (shu-9bj.12).
new CiStack(app, 'Shukkatest-Ci', { env: stackEnv, synthesizer: shukkaCiSynthesizer('shukkatest'), shukkatest: env });
new BoxStack(app, 'Shukkatest-Box', { env: stackEnv, synthesizer: shukkaSynthesizer('shukkatest'), shukkatest: env, settings });
if (settings.escape === true) {
  new EscapeStack(app, 'Shukkatest-Escape', { env: stackEnv, synthesizer: shukkaSynthesizer('shukkatest'), targets });
}

// Project on everything, and on the create request of the box's launch template, which the fence requires (shu-9bj.18).
tagProject(app, 'shukkatest');
applyBoundary(app, 'shukkatest');

// A compromised dependency in the project's CDK code: after synthesis it adds a file asset that
// cdk-assets would build by running a command on the deploy runner, which holds the deploy role.
// shukka's deploy job must refuse the assembly before any role is assumed. The command prints a
// marker computed by the shell, so the marker never appears in the log unless the command ran.
if (settings.plantExecutableAsset === true) {
  const assembly = app.synth();
  let planted = 0;
  for (const name of readdirSync(assembly.directory)) {
    if (!name.endsWith('.assets.json')) continue;
    const file = join(assembly.directory, name);
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const first = Object.values(manifest.files ?? {})[0];
    if (!first) continue;
    const destinations = Object.fromEntries(Object.entries(first.destinations ?? {}).map(([id, d]) => [
      id, { ...d, objectKey: 'shukkatest-planted-asset.txt' },
    ]));
    manifest.files = {
      ...manifest.files,
      shukkatestplantedasset: {
        source: { executable: ['bash', '-c', 'echo "SHUKKATEST-PLANTED-ASSET-RAN-$((40 + 2))" >&2; echo /dev/null'] },
        destinations,
      },
    };
    writeFileSync(file, JSON.stringify(manifest, null, 1));
    planted += 1;
  }
  if (planted === 0) throw new Error('shukkatest: no asset manifest to plant the executable asset in');
}
