// `shukka bootstrap --account` and `shukka bootstrap <project>` (design C7, D5; decisions from the reviews of
// shu-9bj.2 and shu-i1b recorded on shu-5ix).
//
// Every lookup comes first and every refusal is made before anything is changed. Then, for a project:
//   1. the boundary stack Shukka-Boundary-<project> (ShukkaBoundary: the boundary and the three execution
//      policies), synthesized here and deployed with `cdk deploy`;
//   2. the project's own bootstrap template (lib/bootstrap.ts) as stack CDKToolkit-<qualifier>, deployed with
//      `aws cloudformation deploy` (it takes no parameters; `cdk bootstrap --template` cannot deploy it). Its
//      execution role carries the three execution policies and its roles trust the project's infra role and the
//      emergency principals (default: whoever runs this);
//   3. buildEnv values copied from Parameter Store /<project>/prod/<NAME> to GitHub repository variables;
//   4. the project added to Shukka-Account's list, when that stack exists.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { checkProjectName, loadConfig } from '../config.mjs';
import { CliError, NPM_SAFE, awsFiles, cdkBin, cdkPlace, mustRun, refuseSymlink, tempDir } from './exec.mjs';
export const ACCOUNT_STACK = 'Shukka-Account';
/** Tag on the stacks `shukka bootstrap` deploys, naming the project; how shukka knows a bootstrap is its own. */
export const PROJECT_TAG = 'shukka:project';

const OIDC_ARN_RE = /^arn:aws[a-z-]*:iam::([0-9]{12}):oidc-provider\/token\.actions\.githubusercontent\.com$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/**
 * @typedef {import('./exec.mjs').Io} Io
 * @typedef {import('./aws.mjs').Aws} Aws
 * @typedef {{ profile?: string, region?: string }} Target
 */

/**
 * @param {Target} target
 * @returns {string[]}
 */
function profileArgs(target) {
  return target.profile ? ['--profile', target.profile] : [];
}

/**
 * The `cdk deploy` of one stack from a synthesized cloud assembly, with shukka's own pinned cdk (`node <bin>`, never
 * npx), from an empty temp directory with an empty HOME: no .npmrc or cdk.json (whose plugins would run with admin
 * credentials) is read from the directory the admin runs this from, or from the admin's home.
 * @param {Io} io
 * @param {string} assembly
 * @param {string} stack
 * @param {Target & { region: string }} target
 */
function cdkDeploy(io, assembly, stack, target) {
  const place = cdkPlace();
  mustRun(io, `cdk deploy ${stack}`, process.execPath, [
    cdkBin(), 'deploy', stack, '--app', assembly, '--require-approval', 'never', '--no-color', ...profileArgs(target),
  ], {
    cwd: place.cwd,
    // HOME moved to an empty directory (no ~/.cdk.json plugins); the admin's AWS files pinned by real path first.
    env: { ...awsFiles(), ...NPM_SAFE, HOME: place.home, AWS_REGION: target.region, AWS_DEFAULT_REGION: target.region },
  });
}

/**
 * Warn when the aws-cdk-lib that synthesizes shukka's stacks is not the version shukka was tested with: it is a
 * peer dependency, so npm resolves it when the CLI is installed rather than taking it from npm-shrinkwrap.json.
 * @param {Io} io
 */
function checkCdkLib(io) {
  const require = createRequire(import.meta.url);
  const tested = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).devDependencies?.['aws-cdk-lib'];
  const loaded = JSON.parse(readFileSync(require.resolve('aws-cdk-lib/package.json'), 'utf8')).version;
  if (tested && loaded !== tested) io.warn(`aws-cdk-lib ${loaded} is synthesizing shukka's stacks; shukka was tested with ${tested}`);
}

/** A new cloud assembly directory inside its own shukka temp directory (the cwd cdk runs in). */
function newAssemblyDir(/** @type {string} */ name) {
  return join(tempDir(name), 'cdk.out');
}

/**
 * The emergency principal for whoever runs the bootstrap: a user's ARN as it is, an assumed role's role ARN (with
 * its path, which aws:PrincipalArn carries). The account root is refused: name a principal with
 * --emergency-principal instead.
 * @param {Aws} aws
 * @param {string} callerArn
 * @returns {Promise<string>}
 */
export async function principalFor(aws, callerArn) {
  if (/^arn:aws[a-z-]*:iam::[0-9]{12}:user\//.test(callerArn)) return callerArn;
  const m = /^arn:(aws[a-z-]*):sts::([0-9]{12}):assumed-role\/([^/]+)\/[^/]+$/.exec(callerArn);
  if (m) {
    const arn = await aws.roleArn(/** @type {string} */ (m[3]));
    if (!arn) throw new CliError(`cannot read the role behind ${callerArn}`);
    return arn;
  }
  throw new CliError(`cannot use ${callerArn} as the emergency principal; name one with --emergency-principal <role or user ARN>`);
}

const BOUNDARY_SUFFIX = '-shukka-boundary';

/**
 * Known projects in the account: every IAM policy named `<project>-shukka-boundary` (IAM is global, so this sees
 * projects bootstrapped in any region), Shukka-Account's list and every Shukka-Boundary-<project> stack in this
 * region. Refuses when the IAM list cannot be read: the prefix check would be blind.
 * @param {Aws} aws
 */
async function knownProjects(aws) {
  /** @type {import('./aws.mjs').LocalPolicy[]} */
  let policies;
  try {
    policies = await aws.localPolicies();
  } catch (error) {
    throw new CliError(`cannot list the account's IAM policies to find other projects (${/** @type {Error} */ (error).message}); `
      + 'the fence is global, so the project name cannot be checked without them');
  }
  const fromIam = policies.filter((p) => p.name.endsWith(BOUNDARY_SUFFIX)).map((p) => p.name.slice(0, -BOUNDARY_SUFFIX.length)).filter(Boolean);
  const account = await aws.describeStack(ACCOUNT_STACK);
  const listed = account ? listOf(account.outputs.Projects) : [];
  const { boundaryStackName } = await import('../../lib/bootstrap.js');
  const prefix = boundaryStackName('');
  const boundaries = (await aws.listStackNames(prefix)).map((n) => n.slice(prefix.length)).filter(Boolean);
  return { projects: [...new Set([...fromIam, ...listed, ...boundaries])], account, policies };
}

const KIND_NAMES = /** @type {const} */ ({
  'dynamodb-table': 'DynamoDB table',
  's3-bucket': 'S3 bucket',
  'sqs-queue': 'SQS queue',
  'sns-topic': 'SNS topic',
  'lambda-function': 'Lambda function',
  'log-group': 'log group',
  'iam-role': 'IAM role',
});
const LAMBDA_LOGS = '/aws/lambda/';

/**
 * The part of a resource's name the fence matches: a queue's name (last part of its URL), a topic's name (last part
 * of its ARN), a log group's name without /aws/lambda/ (the fence allows both), a role's path and name after `role/`.
 * @param {import('./aws.mjs').AccountResource} r
 * @returns {string}
 */
function fenceName(r) {
  switch (r.kind) {
    case 'sqs-queue': return r.name.slice(r.name.lastIndexOf('/') + 1);
    case 'sns-topic': return r.name.slice(r.name.lastIndexOf(':') + 1);
    case 'log-group': return r.name.startsWith(LAMBDA_LOGS) ? r.name.slice(LAMBDA_LOGS.length) : r.name;
    case 'iam-role': return `${r.path ? r.path.replace(/^\//, '') : ''}${r.name}`;
    default: return r.name;
  }
}

/**
 * Resources the new fence (`<project>*`, `<Project>*`) would reach that are no part of this project: every DynamoDB
 * table, S3 bucket, SQS queue, SNS topic, Lambda function, log group and IAM role whose name is in the fence but which
 * is in no stack tagged Project=<project> or shukka:project=<project> (a Lambda function's own /aws/lambda/<name> log
 * group counts as the function's). A project named orb would otherwise fence in Orbitary's orbitary-* resources.
 * @param {Aws} aws
 * @param {string} project
 * @returns {Promise<import('./aws.mjs').AccountResource[]>}
 */
export async function fenceClashes(aws, project) {
  const Project = project.charAt(0).toUpperCase() + project.slice(1);
  const inFence = (/** @type {string} */ n) => n.startsWith(project) || n.startsWith(Project);
  const candidates = (await aws.accountResources()).filter((r) => inFence(fenceName(r)));
  if (candidates.length === 0) return [];
  /** @type {Set<string>} */
  const owned = new Set();
  for (const stack of await aws.stacksWithTags()) {
    if (stack.tags.Project !== project && stack.tags[PROJECT_TAG] !== project) continue;
    for (const id of await aws.stackPhysicalIds(stack.name)) owned.add(id);
  }
  return candidates.filter((r) => !owned.has(r.name)
    && !(r.kind === 'log-group' && r.name.startsWith(LAMBDA_LOGS) && owned.has(r.name.slice(LAMBDA_LOGS.length))));
}

/**
 * Hosted zones and mail domains other projects' fences already hold, read from their execution policies in IAM.
 * @param {Aws} aws
 * @param {import('./aws.mjs').LocalPolicy[]} policies
 * @param {string} project
 * @param {string[]} others
 * @returns {Promise<{ project: string, zones: Set<string>, domains: Set<string> }[]>}
 */
async function fencedElsewhere(aws, policies, project, others) {
  const out = [];
  for (const other of others) {
    if (other === project) continue;
    const zones = new Set();
    const domains = new Set();
    for (const p of policies.filter((x) => x.name.startsWith(`${other}-shukka-execution`) || x.name === `${other}${BOUNDARY_SUFFIX}`)) {
      const doc = await aws.policyDocument(p);
      for (const m of doc.matchAll(/hostedzone\/(Z[A-Z0-9]+)/g)) zones.add(m[1]);
      for (const m of doc.matchAll(/:identity\/([A-Za-z0-9.-]+)/g)) domains.add(String(m[1]).toLowerCase());
    }
    out.push({ project: other, zones, domains });
  }
  return out;
}

/**
 * @param {string | undefined} output
 * @returns {string[]}
 */
function listOf(output) {
  if (!output || output === 'none') return [];
  return output.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Synthesize Shukka-Account into a new cloud assembly directory; returns its path.
 * @param {Io} io
 * @param {{ account: string, region: string, projects: string[], oidcProviderArn?: string }} inputs
 * @returns {Promise<string>}
 */
async function synthAccount(io, inputs) {
  checkCdkLib(io);
  const { App, BootstraplessSynthesizer } = await import('aws-cdk-lib');
  const { ShukkaAccountStack } = await import('../../lib/index.js');
  const outdir = newAssemblyDir('account');
  const app = new App({ outdir });
  new ShukkaAccountStack(app, ACCOUNT_STACK, {
    env: { account: inputs.account, region: inputs.region },
    synthesizer: new BootstraplessSynthesizer(),
    projects: inputs.projects,
    ...(inputs.oidcProviderArn ? { existingOidcProviderArn: inputs.oidcProviderArn } : {}),
  });
  app.synth();
  return outdir;
}

/**
 * Synthesize Shukka-Boundary-<project> into a new cloud assembly directory; returns its path.
 * @param {Io} io
 * @param {{ project: string, qualifier: string, account: string, region: string, hostedZoneId: string, mailDomains: string[] }} inputs
 * @returns {Promise<string>}
 */
async function synthBoundary(io, inputs) {
  checkCdkLib(io);
  const { App, BootstraplessSynthesizer, Stack } = await import('aws-cdk-lib');
  const { ShukkaBoundary, boundaryStackName } = await import('../../lib/index.js');
  const outdir = newAssemblyDir('boundary');
  const app = new App({ outdir });
  const stack = new Stack(app, boundaryStackName(inputs.project), {
    env: { account: inputs.account, region: inputs.region },
    synthesizer: new BootstraplessSynthesizer(),
    tags: { [PROJECT_TAG]: inputs.project },
    description: `shukka fence for project ${inputs.project}: permissions boundary and execution policies`,
  });
  new ShukkaBoundary(stack, 'Fence', {
    project: inputs.project,
    qualifier: inputs.qualifier,
    hostedZoneId: inputs.hostedZoneId,
    sesDomains: inputs.mailDomains,
  });
  app.synth();
  return outdir;
}

/**
 * How Shukka-Account refers to the OIDC provider today: the ARN it imports, or undefined when it owns the provider.
 * @param {Aws} aws
 * @param {import('./aws.mjs').StackInfo} stack
 * @returns {Promise<string | undefined>}
 */
async function importedProvider(aws, stack) {
  const ids = await aws.stackResourceIds(ACCOUNT_STACK);
  return ids.includes('GitHubOidcProvider') ? undefined : stack.outputs.OidcProviderArn;
}

/**
 * `shukka bootstrap --account`.
 * @param {{ io: Io, aws: Aws, target: Target & { region: string }, oidcProviderArn?: string, projects?: string[] }} options
 */
export async function bootstrapAccount({ io, aws, target, oidcProviderArn, projects }) {
  const caller = await aws.callerArn();
  io.say(`account ${caller.account}, region ${target.region}, as ${caller.arn}`);
  const existing = await aws.describeStack(ACCOUNT_STACK);

  if (oidcProviderArn !== undefined) {
    const m = OIDC_ARN_RE.exec(oidcProviderArn);
    if (!m) throw new CliError(`--oidc-provider-arn ${oidcProviderArn} is not the ARN of a GitHub Actions OIDC provider`);
    if (m[1] !== caller.account) throw new CliError(`--oidc-provider-arn is in account ${m[1]}, not ${caller.account}`);
  }
  let provider = oidcProviderArn;
  if (existing) {
    const imported = await importedProvider(aws, existing);
    provider ??= imported;
    io.say(`${ACCOUNT_STACK} exists; it ${imported ? `imports ${imported}` : 'owns the GitHub OIDC provider'}`);
  } else if (provider === undefined) {
    const github = (await aws.oidcProviders()).filter((arn) => OIDC_ARN_RE.test(arn));
    if (github.length > 0) {
      throw new CliError(`the account already has a GitHub OIDC provider (${github.join(', ')}); `
        + 'import it with --oidc-provider-arn <arn> (creating another would fail)');
    }
  }

  const list = projects ?? (existing ? listOf(existing.outputs.Projects) : []);
  await checkProjectList(list);
  io.say(`projects: ${list.length > 0 ? list.join(', ') : 'none'}; GitHub OIDC provider: ${provider ? `imported (${provider})` : 'owned by the stack'}`);
  const assembly = await synthAccount(io, { account: caller.account, region: target.region, projects: list, ...(provider ? { oidcProviderArn: provider } : {}) });
  cdkDeploy(io, assembly, ACCOUNT_STACK, target);
  io.say(io.dryRun ? `dry run: ${ACCOUNT_STACK} not deployed` : `${ACCOUNT_STACK} deployed`);
}

/**
 * Refuse a project list holding a reserved name or two names where one prefixes the other.
 * @param {string[]} list
 */
async function checkProjectList(list) {
  const { validateProjectName } = await import('../../lib/boundary.js');
  for (const p of list) {
    try {
      validateProjectName(p);
    } catch (error) {
      throw new CliError(/** @type {Error} */ (error).message.replace(/^shukka: /, ''));
    }
    const clash = checkProjectName(p, list);
    if (clash.length > 0) throw new CliError(clash[0] ?? '');
  }
}

/**
 * The GitHub repository (owner/name) of the checkout's `origin`, when it is on github.com.
 * @param {Io} io
 * @param {string} cwd
 * @returns {string | undefined}
 */
function originRepo(io, cwd) {
  const r = io.run('git', ['remote', 'get-url', 'origin'], { cwd, mutates: false, capture: 'stdout' });
  if (r.status !== 0) return undefined;
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\s*$/.exec(r.stdout.trim());
  return m ? m[1] : undefined;
}

/**
 * `shukka bootstrap <project>`.
 * @param {{
 *   io: Io, aws: Aws, target: Target, project: string, configPath: string, cwd: string,
 *   hostedZoneIds?: string[], mailDomains?: string[], repo?: string, emergencyPrincipals?: string[],
 *   allowPrivateTypes?: boolean,
 * }} options
 */
export async function bootstrapProject(options) {
  const { io, aws, project } = options;
  refuseSymlink(options.cwd, options.configPath);
  const { config, problems } = loadConfig(options.configPath);
  if (!config) throw new CliError(problems.join('\n'));
  if (config.project !== project) {
    throw new CliError(`project "${project}" is not the project in ${options.configPath} ("${config.project}")`);
  }
  const region = options.target.region ?? config.aws.region;
  if (region !== config.aws.region) {
    throw new CliError(`--region ${region} is not the region in ${options.configPath} (${config.aws.region})`);
  }
  const target = { ...options.target, region };
  const qualifier = config.qualifier;
  const lib = await import('../../lib/index.js');

  // The fence's own inputs: the hosted zone and mail domains (flags win over shukka.json's fence object).
  const zones = options.hostedZoneIds && options.hostedZoneIds.length > 0 ? options.hostedZoneIds : config.fence.hostedZoneIds;
  const mailDomains = options.mailDomains && options.mailDomains.length > 0 ? options.mailDomains : config.fence.mailDomains;
  if (zones.length !== 1) {
    throw new CliError(`the fence takes exactly one hosted zone (fence.hostedZoneIds in ${options.configPath}, or --hosted-zone-id); found ${zones.length}`);
  }
  const hostedZoneId = /** @type {string} */ (zones[0]);
  try {
    lib.validateFenceInputs({ project, qualifier, hostedZoneId, sesDomains: mailDomains, account: config.aws.account });
  } catch (error) {
    throw new CliError(/** @type {Error} */ (error).message.replace(/^shukka: /, ''));
  }

  /** @param {string[]} principals */
  const buildTemplate = (principals) => {
    try {
      return lib.bootstrapTemplate({ project, qualifier, emergencyPrincipals: principals });
    } catch (error) {
      throw new CliError(/** @type {Error} */ (error).message.replace(/^shukka: /, ''));
    }
  };
  // Named emergency principals are checked before anything is looked up or changed.
  if (options.emergencyPrincipals && options.emergencyPrincipals.length > 0) buildTemplate(options.emergencyPrincipals);

  const caller = await aws.callerArn();
  if (caller.account !== config.aws.account) {
    throw new CliError(`the credentials are for account ${caller.account}, but ${options.configPath} names ${config.aws.account}`);
  }
  io.say(`bootstrapping ${project} (qualifier ${qualifier}) in account ${caller.account}, region ${region}, as ${caller.arn}`);

  const emergency = options.emergencyPrincipals && options.emergencyPrincipals.length > 0
    ? options.emergencyPrincipals
    : [await principalFor(aws, caller.arn)];
  const template = buildTemplate(emergency);

  // Other projects: a name that prefixes another (either way) would let one fence reach the other.
  const known = await knownProjects(aws);
  const clash = checkProjectName(project, known.projects);
  if (clash.length > 0) throw new CliError(`${clash.join('; ')} in this account`);
  if (!known.account) io.warn(`${ACCOUNT_STACK} does not exist; project names were checked against IAM and the Shukka-Boundary-* stacks only`);

  // What the fence holds outside the name prefix, shown with where it came from, and never another project's.
  const zoneSource = options.hostedZoneIds && options.hostedZoneIds.length > 0 ? '--hosted-zone-id' : options.configPath;
  const mailSource = options.mailDomains && options.mailDomains.length > 0 ? '--mail-domain' : options.configPath;
  const zoneName = await aws.hostedZoneName(hostedZoneId);
  for (const other of await fencedElsewhere(aws, known.policies, project, known.projects)) {
    if (other.zones.has(hostedZoneId)) throw new CliError(`hosted zone ${hostedZoneId} (${zoneName}) is already in project ${other.project}'s fence`);
    for (const d of mailDomains) {
      if (other.domains.has(d.toLowerCase())) throw new CliError(`mail domain ${d} is already in project ${other.project}'s fence`);
    }
  }
  const fenceLine = `fence: hosted zone ${hostedZoneId} (${zoneName}) from ${zoneSource}; `
    + `mail domains ${mailDomains.length > 0 ? `${mailDomains.join(', ')} from ${mailSource}` : 'none'}`;
  io.say(fenceLine);

  // The qualifier must be new, or a bootstrap shukka made for this project.
  const toolkitName = lib.bootstrapStackName(qualifier);
  const toolkit = await aws.describeStack(toolkitName);
  if (toolkit && toolkit.tags[PROJECT_TAG] !== project) {
    throw new CliError(`stack ${toolkitName} exists and was not made by shukka for ${project}; choose another qualifier`);
  }
  const versionParameter = `/cdk-bootstrap/${qualifier}/version`;
  if (!toolkit && (await aws.getParameter(versionParameter))) {
    throw new CliError(`qualifier ${qualifier} is already bootstrapped by something else (${versionParameter} exists); choose another qualifier`);
  }

  // Private and activated CloudFormation extensions run with their own execution roles, outside the fence.
  const types = await aws.privateTypes();
  for (const t of types) {
    const line = `private CloudFormation ${t.kind.toLowerCase()} ${t.typeName} runs as ${t.executionRoleArn ?? 'no execution role'}`;
    if (options.allowPrivateTypes) io.warn(line);
    else io.err(`shukka: ${line}\n`);
  }
  if (types.length > 0 && !options.allowPrivateTypes) {
    throw new CliError(`the account has ${types.length} private or activated CloudFormation extension(s) (above); `
      + "the project's stacks could use them outside the fence. Remove them, or pass --allow-private-types once you have checked each execution role");
  }

  // Roles inside the fence's name prefix without its boundary could be given any permission by the pipeline.
  const unbounded = await aws.unboundedRoles(project);
  if (unbounded.length > 0) {
    for (const r of unbounded) {
      io.err(`shukka: role ${r.arn || r.roleName} matches the ${project} prefix but ${r.boundaryArn ? `carries boundary ${r.boundaryArn}` : 'has no permissions boundary'}\n`);
    }
    throw new CliError(`${unbounded.length} role(s) named like the project lack its boundary (${lib.boundaryPolicyName(project)}); `
      + 'rename them, delete them, or put the boundary on them, then run this again');
  }

  // Anything else in the fence's name prefix (another product's resources, not a shukka project) would be handed to
  // this project's pipeline.
  const clashes = await fenceClashes(aws, project);
  if (clashes.length > 0) {
    const Project = project.charAt(0).toUpperCase() + project.slice(1);
    for (const r of clashes) {
      io.err(`shukka: ${KIND_NAMES[r.kind]} ${r.path ? `${r.path}${r.name}` : r.name} matches the fence (${project}*, ${Project}*) but is in no stack of ${project}\n`);
    }
    throw new CliError(`${clashes.length} resource(s) in this account (above) are named like ${project} but belong to no stack tagged `
      + `Project=${project}: the fence would let ${project}'s pipeline change or delete them. Choose a project name nothing else in the account starts with`);
  }

  // buildEnv values, read now so a missing one stops the bootstrap before anything changes.
  const names = [...new Set(config.apps.flatMap((a) => a.build.buildEnv))];
  /** @type {{ name: string, path: string, value: string }[]} */
  const variables = [];
  for (const name of names) {
    const path = `/${project}/prod/${name}`;
    const p = await aws.getParameter(path);
    if (!p) throw new CliError(`buildEnv ${name}: parameter ${path} does not exist`);
    if (p.type === 'SecureString') throw new CliError(`buildEnv ${name}: ${path} is a SecureString; build-time values must not be secret`);
    variables.push({ name, path, value: p.value });
  }
  const repo = options.repo ?? (names.length > 0 ? originRepo(io, options.cwd) : undefined);
  if (names.length > 0) {
    if (!repo) throw new CliError('cannot tell the GitHub repository from origin; pass --repo <owner/name>');
    if (!REPO_RE.test(repo)) throw new CliError(`--repo ${repo} is not owner/name`);
  }

  // 1. The fence.
  const boundaryStack = lib.boundaryStackName(project);
  io.say(`1/4 ${boundaryStack}: boundary ${lib.boundaryPolicyName(project)} and execution policies ${lib.executionPolicyNames(project).join(', ')}; ${fenceLine}`);
  const assembly = await synthBoundary(io, { project, qualifier, account: caller.account, region, hostedZoneId, mailDomains });
  cdkDeploy(io, assembly, boundaryStack, target);

  // 2. The project's bootstrap.
  io.say(`2/4 ${toolkitName}: qualifier ${qualifier}, execution role with ${lib.executionPolicyNames(project).join(', ')}; emergency principals ${emergency.join(', ')}`);
  const templateFile = join(tempDir('bootstrap'), `${toolkitName}.json`);
  writeFileSync(templateFile, `${JSON.stringify(template, null, 2)}\n`);
  mustRun(io, `deploying ${toolkitName}`, 'aws', [
    'cloudformation', 'deploy', '--stack-name', toolkitName, '--template-file', templateFile,
    '--capabilities', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset', '--tags', `${PROJECT_TAG}=${project}`,
    '--region', region, ...profileArgs(target),
  ]);

  // 3. buildEnv values to repository variables (non-secret by D9; passed on stdin, not on the command line).
  io.say(`3/4 buildEnv: ${variables.length > 0 ? `${variables.map((v) => v.name).join(', ')} to ${repo}` : 'none'}`);
  for (const v of variables) {
    mustRun(io, `gh variable set ${v.name}`, 'gh', ['variable', 'set', v.name, '--repo', /** @type {string} */ (repo)], {
      input: v.value,
      display: `gh variable set ${v.name} --repo ${repo} < value of ${v.path}`,
    });
  }

  // 4. Shukka-Account's project list.
  if (known.account) {
    const listed = listOf(known.account.outputs.Projects);
    if (listed.includes(project)) {
      io.say(`4/4 ${ACCOUNT_STACK} already lists ${project}`);
    } else {
      io.say(`4/4 adding ${project} to ${ACCOUNT_STACK}'s project list`);
      const provider = await importedProvider(aws, known.account);
      const accountAssembly = await synthAccount(io, {
        account: caller.account, region, projects: [...listed, project], ...(provider ? { oidcProviderArn: provider } : {}),
      });
      cdkDeploy(io, accountAssembly, ACCOUNT_STACK, target);
    }
  } else {
    io.say(`4/4 ${ACCOUNT_STACK} does not exist; run shukka bootstrap --account to record ${project} there`);
  }
  io.say(io.dryRun ? `dry run: nothing was changed for ${project}` : `${project} bootstrapped`);
}
