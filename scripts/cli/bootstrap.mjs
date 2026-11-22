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

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProjectName, loadConfig } from '../config.mjs';
import { CliError, mustRun } from './exec.mjs';

/** The CDK CLI the bootstrap runs (the project's own infra directory is not needed to bootstrap). */
export const CDK_CLI = 'aws-cdk@2.1148.1';
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
 * The `cdk deploy` of one stack from a synthesized cloud assembly.
 * @param {Io} io
 * @param {string} assembly
 * @param {string} stack
 * @param {Target & { region: string }} target
 */
function cdkDeploy(io, assembly, stack, target) {
  mustRun(io, `cdk deploy ${stack}`, 'npx', [
    '--yes', CDK_CLI, 'deploy', stack, '--app', assembly, '--require-approval', 'never', '--no-color', ...profileArgs(target),
  ], { env: { AWS_REGION: target.region, AWS_DEFAULT_REGION: target.region } });
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

/**
 * Known projects in the account: Shukka-Account's list and every Shukka-Boundary-<project> stack.
 * @param {Aws} aws
 * @returns {Promise<{ projects: string[], account: import('./aws.mjs').StackInfo | null }>}
 */
async function knownProjects(aws) {
  const account = await aws.describeStack(ACCOUNT_STACK);
  const listed = account ? listOf(account.outputs.Projects) : [];
  const { boundaryStackName } = await import('../../lib/bootstrap.js');
  const prefix = boundaryStackName('');
  const boundaries = (await aws.listStackNames(prefix)).map((n) => n.slice(prefix.length)).filter(Boolean);
  return { projects: [...new Set([...listed, ...boundaries])], account };
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
 * @param {{ account: string, region: string, projects: string[], oidcProviderArn?: string }} inputs
 * @returns {Promise<string>}
 */
async function synthAccount(inputs) {
  const { App, BootstraplessSynthesizer } = await import('aws-cdk-lib');
  const { ShukkaAccountStack } = await import('../../lib/index.js');
  const outdir = mkdtempSync(join(tmpdir(), 'shukka-account-'));
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
 * @param {{ project: string, qualifier: string, account: string, region: string, hostedZoneId: string, mailDomains: string[] }} inputs
 * @returns {Promise<string>}
 */
async function synthBoundary(inputs) {
  const { App, BootstraplessSynthesizer, Stack } = await import('aws-cdk-lib');
  const { ShukkaBoundary, boundaryStackName } = await import('../../lib/index.js');
  const outdir = mkdtempSync(join(tmpdir(), 'shukka-boundary-'));
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
  const assembly = await synthAccount({ account: caller.account, region: target.region, projects: list, ...(provider ? { oidcProviderArn: provider } : {}) });
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

  const caller = await aws.callerArn();
  if (caller.account !== config.aws.account) {
    throw new CliError(`the credentials are for account ${caller.account}, but ${options.configPath} names ${config.aws.account}`);
  }
  io.say(`bootstrapping ${project} (qualifier ${qualifier}) in account ${caller.account}, region ${region}, as ${caller.arn}`);

  const emergency = options.emergencyPrincipals && options.emergencyPrincipals.length > 0
    ? options.emergencyPrincipals
    : [await principalFor(aws, caller.arn)];

  // Other projects: a name that prefixes another (either way) would let one fence reach the other.
  const known = await knownProjects(aws);
  const clash = checkProjectName(project, known.projects);
  if (clash.length > 0) throw new CliError(`${clash.join('; ')} in this account`);
  if (!known.account) io.warn(`${ACCOUNT_STACK} does not exist; project names were checked against the Shukka-Boundary-* stacks only`);

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
  io.say(`1/4 ${boundaryStack}: boundary ${lib.boundaryPolicyName(project)} and execution policies ${lib.executionPolicyNames(project).join(', ')}`);
  const assembly = await synthBoundary({ project, qualifier, account: caller.account, region, hostedZoneId, mailDomains });
  cdkDeploy(io, assembly, boundaryStack, target);

  // 2. The project's bootstrap.
  io.say(`2/4 ${toolkitName}: qualifier ${qualifier}, execution role with ${lib.executionPolicyNames(project).join(', ')}; emergency principals ${emergency.join(', ')}`);
  let template;
  try {
    template = lib.bootstrapTemplate({ project, qualifier, emergencyPrincipals: emergency });
  } catch (error) {
    throw new CliError(/** @type {Error} */ (error).message.replace(/^shukka: /, ''));
  }
  const templateFile = join(mkdtempSync(join(tmpdir(), 'shukka-bootstrap-')), `${toolkitName}.json`);
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
      const accountAssembly = await synthAccount({
        account: caller.account, region, projects: [...listed, project], ...(provider ? { oidcProviderArn: provider } : {}),
      });
      cdkDeploy(io, accountAssembly, ACCOUNT_STACK, target);
    }
  } else {
    io.say(`4/4 ${ACCOUNT_STACK} does not exist; run shukka bootstrap --account to record ${project} there`);
  }
  io.say(io.dryRun ? `dry run: nothing was changed for ${project}` : `${project} bootstrapped`);
}
