#!/usr/bin/env node
// Reads every CloudFormation template a synthesized CDK cloud assembly (cdk.out) deploys, nested assemblies and
// nested stacks included, and stops when a policy would let a principal outside the project in, or send the
// project's data out. The execution role may create and re-trust roles named <project>*, and write bucket, queue,
// topic, table and function policies, so a changed assembly (a compromised dependency editing cdk.out after a clean
// pull-request diff) could otherwise hand an outside account lasting access inside the fence. Like guard.mjs it stops
// a merge; a run started by hand with allow_replacement (`--allow`) goes ahead.
//
// Stops on:
//   - an AWS::IAM::Role trust policy (Allow) naming any principal other than
//       a Service principal (`<name>.amazonaws.com`),
//       the account's GitHub OIDC provider (arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com)
//         with exactly ShukkaAccess's conditions: StringEquals aud = sts.amazonaws.com and sub = repo:<the project's
//         repository>:<literal>; StringLike job_workflow_ref on rummykhan/shukka's workflows; optionally
//         StringNotLike job_workflow_ref,
//       a role of the same account (arn:aws:iam::<account>:role/..., or a role in the assembly);
//     so: "*", another account, the account root, users, other identity providers, NotPrincipal;
//   - a resource policy (S3 bucket, SQS queue, SNS topic, DynamoDB table and stream, KMS key) or a Lambda permission
//     (Allow) naming "*" or another account, or a Service principal without aws:SourceAccount / aws:SourceArn (Lambda:
//     SourceAccount / SourceArn) pinned to the account or the project's resources;
//   - an S3 bucket with an ACL other than Private / BucketOwner*, a public access block with a flag off, or
//     notifications, replication or access logs going to something that is not the project's;
//   - an SNS subscription, a log subscription filter, a Lambda destination or a queue's dead-letter target that is
//     not one of the project's resources in the account (http, https, email and SMS endpoints included);
//   - any other resource type with a property named *Policy*, *Permission*, AccessControl or Principal: the check
//     does not know it, so it fails closed;
//   - a policy document or statement with a key outside the IAM grammar (keys are case-sensitive);
//   - anything the check cannot read: a value it cannot work out (a parameter, a custom resource's attribute), an
//     export defined twice, a nested stack whose template is not in the assembly, a transform or macro, a template
//     that is not JSON or that is not the one the stack deploys (scripts/assembly.mjs deployedTemplates).
//
// Intrinsics worked out: Ref of AWS::AccountId, AWS::Partition, AWS::URLSuffix, AWS::Region and AWS::NoValue, and of
// the template's own resources; Fn::GetAtt of the template's own resources (a role's Arn is a role of the account);
// Fn::Join, Fn::Sub, Fn::Select, Fn::Split, Fn::FindInMap; Fn::If (both branches must pass); Fn::ImportValue of an
// export of a deployed template in the assembly.
//
// Usage: node scripts/policy-guard.mjs <assembly dir> --account <12 digits> [--repo <owner/repo>]... [--allow]
//                                      [--summary <file>]
// --repo names the project's GitHub repository (owner/repo or owner@id/repo@id); without it no OIDC trust passes.
// Exit 0: nothing opens the project (or it was allowed). Exit 1: something does, or the assembly cannot be read.
// Exit 2: bad arguments.

import { appendFileSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deployedTemplates } from './assembly.mjs';

const PROVIDER_HOST = 'token.actions.githubusercontent.com';
const AUD = `${PROVIDER_HOST}:aud`;
const SUB = `${PROVIDER_HOST}:sub`;
const WORKFLOW_REF = `${PROVIDER_HOST}:job_workflow_ref`;
// shukka's own nested workflows at a tag or branch of rummykhan/shukka (only its owner can push either).
const SHUKKA_WORKFLOW_REF = /^rummykhan\/shukka\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@refs\/(?:tags|heads)\/[A-Za-z0-9._/*-]+$/;
const SERVICE = /^[a-z0-9][a-z0-9.-]*\.amazonaws\.com(?:\.cn)?$/;
const ACCOUNT = /^[0-9]{12}$/;
const IAM_ARN = /^arn:aws[a-z-]*:(iam|sts)::([^:]*):(.+)$/;
const ANY_ARN = /^arn:aws[a-z-]*:([^:]*):([^:]*):([^:]*):(.*)$/;
// A value naming one of the template's own resources (Ref or Fn::GetAtt), as resolve() writes it.
const OWN = /<(?:Ref|Fn::GetAtt) [^>]+>/;
// GitHub owner and repository names, as ShukkaAccess takes them; the immutable form carries ids after @.
const REPO = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})(?:@[0-9]+)?\/([A-Za-z0-9._-]{1,100})(?:@[0-9]+)?$/;
const DOCUMENT_KEYS = new Set(['Version', 'Id', 'Statement']);
const STATEMENT_KEYS = new Set(['Sid', 'Effect', 'Principal', 'NotPrincipal', 'Action', 'NotAction', 'Resource', 'NotResource', 'Condition']);
// Condition operators that pin a value (not negated, not IfExists, not ForAnyValue).
const PINNING = new Set(['StringEquals', 'StringEqualsIgnoreCase', 'StringLike', 'ArnEquals', 'ArnLike']);
// Where each resource type keeps its policy documents (paths into Properties; [] means each item of a list).
/** @type {Record<string, (string | number)[][]>} */
const RESOURCE_POLICIES = {
  'AWS::S3::BucketPolicy': [['PolicyDocument']],
  'AWS::SQS::QueuePolicy': [['PolicyDocument']],
  'AWS::SQS::QueueInlinePolicy': [['PolicyDocument']],
  'AWS::SNS::TopicPolicy': [['PolicyDocument']],
  'AWS::SNS::TopicInlinePolicy': [['PolicyDocument']],
  'AWS::KMS::Key': [['KeyPolicy']],
  'AWS::SecretsManager::ResourcePolicy': [['ResourcePolicy']],
  'AWS::DynamoDB::Table': [['ResourcePolicy', 'PolicyDocument'], ['StreamSpecification', 'ResourcePolicy', 'PolicyDocument']],
  'AWS::DynamoDB::GlobalTable': [['Replicas', '[]', 'ResourcePolicy', 'PolicyDocument'], ['Replicas', '[]', 'ReplicaStreamSpecification', 'ResourcePolicy', 'PolicyDocument']],
};
// Types whose policy-looking properties are handled below or carry no grant to anyone outside the account
// (identity policies, a queue's redrive settings, a topic's data-protection and logging settings).
const HANDLED = new Set([
  ...Object.keys(RESOURCE_POLICIES),
  'AWS::IAM::Role', 'AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy', 'AWS::IAM::InstanceProfile',
  'AWS::Lambda::Permission', 'AWS::Lambda::LayerVersionPermission', 'AWS::Lambda::EventInvokeConfig', 'AWS::Lambda::EventSourceMapping',
  'AWS::S3::Bucket', 'Custom::S3BucketNotifications', 'AWS::SQS::Queue', 'AWS::SNS::Topic', 'AWS::SNS::Subscription',
  'AWS::Logs::SubscriptionFilter', 'AWS::CloudFormation::Stack',
]);
// Services CDK itself grants without a source condition (EventBridge to a topic or key, a load balancer or Secrets
// Manager rotation to a function, CloudTrail and log delivery to a bucket). They pass without one; a source
// condition that names anything but the project still stops. Every other service needs the condition.
const UNCONDITIONED_SERVICES = new Set([
  'events.amazonaws.com', 'elasticloadbalancing.amazonaws.com', 'secretsmanager.amazonaws.com', 'cloudtrail.amazonaws.com', 'delivery.logs.amazonaws.com',
]);
// Key policies grant a service only the key's use, inside requests that already name one of the project's resources:
// no source condition is needed there (CDK grants s3 and events on keys without one).
const NO_SOURCE_NEEDED = new Set(['AWS::KMS::Key']);
/** AWS's own Elastic Load Balancing log-delivery accounts (one per region), from aws-cdk-lib's region facts. */
const ELB_LOG_ACCOUNTS = (() => {
  try {
    const { RegionInfo } = createRequire(import.meta.url)('aws-cdk-lib/region-info');
    return new Set(RegionInfo.regions.map((/** @type {any} */ r) => r.elbv2Account).filter(Boolean));
  } catch {
    return new Set();
  }
})();
const POLICY_LIKE = (/** @type {string} */ key) => /Policy|Permission/.test(key) || key === 'AccessControl' || key === 'Principal';
// S3::Bucket properties that cannot send data or access outside the bucket; the rest are checked or stop.
const BUCKET_SAFE = new Set([
  'BucketName', 'BucketEncryption', 'VersioningConfiguration', 'LifecycleConfiguration', 'Tags', 'CorsConfiguration', 'WebsiteConfiguration',
  'OwnershipControls', 'ObjectLockEnabled', 'ObjectLockConfiguration', 'IntelligentTieringConfigurations', 'AccelerateConfiguration', 'MetricsConfigurations',
  'AccessControl', 'PublicAccessBlockConfiguration', 'NotificationConfiguration', 'LoggingConfiguration', 'ReplicationConfiguration',
]);

/**
 * @typedef {'safe' | 'stopped' | 'allowed' | 'unreadable'} Verdict
 * @typedef {{ verdict: Verdict, code: 0 | 1, found: string[], templates: number }} PolicyResult
 * @typedef {{ account: string, repos?: string[] }} PolicyOptions
 * @typedef {{ file: string, template: any }} Template
 * @typedef {{ account: string, t: Template, exports: Map<string, { value: any, t: Template }>, depth: number }} Ctx
 * @typedef {import('./assembly.mjs').FileAsset} Asset
 */

/** A value the check could not work out; `why` says what it was. */
class Unknown {
  /** @param {string} why */
  constructor(why) {
    this.why = why;
  }
}
/** A legacy CloudFront origin access identity's canonical user, from a resource in the same template. */
class Oai {
  /** @param {string} id */
  constructor(id) {
    this.id = id;
  }
}
/** Fn::If with different branches: both are checked wherever the value is used. */
class Branches {
  /** @param {any[]} values */
  constructor(values) {
    this.values = values;
  }
}
const NO_VALUE = Symbol('AWS::NoValue');

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Unknown) && !(v instanceof Oai) && !(v instanceof Branches);
}

/**
 * The single intrinsic of an object like { "Fn::Join": [...] } or { "Ref": "X" }, or null.
 * @param {unknown} v
 * @returns {[string, any] | null}
 */
function intrinsic(v) {
  if (!isObject(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1) return null;
  const key = /** @type {string} */ (keys[0]);
  return key === 'Ref' || key === 'Condition' || key.startsWith('Fn::') ? [key, v[key]] : null;
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function show(v) {
  if (v instanceof Unknown) return `<${v.why}>`;
  if (v instanceof Oai) return `<CloudFront origin access identity ${v.id}>`;
  if (v instanceof Branches) return v.values.map(show).join(' or ');
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * Ref of a pseudo parameter or one of the template's resources; anything else (a parameter) cannot be worked out.
 * @param {string} name
 * @param {Ctx} ctx
 * @returns {any}
 */
function ref(name, ctx) {
  switch (name) {
    case 'AWS::AccountId': return ctx.account;
    case 'AWS::Partition': return 'aws';
    case 'AWS::URLSuffix': return 'amazonaws.com';
    // Regions only appear in service principals and resource ARNs here; any one will do.
    case 'AWS::Region': return 'aws-region';
    case 'AWS::NoValue': return NO_VALUE;
    default: return isObject(ctx.t.template?.Resources?.[name]) ? `<Ref ${name}>` : new Unknown(`Ref ${name}`);
  }
}

/**
 * Fn::GetAtt: a role's Arn is a role of the account; a CloudFront origin access identity's canonical user; any other
 * attribute of the template's own resources is the project's.
 * @param {string} id
 * @param {string} attr
 * @param {Ctx} ctx
 * @returns {any}
 */
function getAtt(id, attr, ctx) {
  const resource = ctx.t.template?.Resources?.[id];
  if (!isObject(resource)) return new Unknown(`Fn::GetAtt ${id}.${attr}`);
  if (resource.Type === 'AWS::IAM::Role' && attr === 'Arn') return `arn:aws:iam::${ctx.account}:role/${id}`;
  if (resource.Type === 'AWS::CloudFront::CloudFrontOriginAccessIdentity' && attr === 'S3CanonicalUserId') return new Oai(id);
  return `<Fn::GetAtt ${id}.${attr}>`;
}

/**
 * Work out a template value: a string, a list, an object with its values worked out, Branches, Oai or Unknown.
 * @param {any} v
 * @param {Ctx} ctx
 * @returns {any}
 */
function resolve(v, ctx) {
  if (typeof v === 'string' || v === null || v === undefined || typeof v === 'boolean') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map((x) => resolve(x, ctx)).filter((x) => x !== NO_VALUE);
  const fn = intrinsic(v);
  if (!fn) {
    if (!isObject(v)) return v;
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const r = resolve(x, ctx);
      if (r !== NO_VALUE) out[k] = r;
    }
    return out;
  }
  const [name, arg] = fn;
  if (ctx.depth > 50) return new Unknown('values nested too deeply');
  const inner = { ...ctx, depth: ctx.depth + 1 };
  switch (name) {
    case 'Ref':
      return typeof arg === 'string' ? ref(arg, inner) : new Unknown('Ref');
    case 'Fn::GetAtt': {
      const [id, attr] = typeof arg === 'string' ? [arg.slice(0, arg.indexOf('.')), arg.slice(arg.indexOf('.') + 1)] : Array.isArray(arg) ? arg : [];
      return typeof id === 'string' && typeof attr === 'string' ? getAtt(id, attr, inner) : new Unknown('Fn::GetAtt');
    }
    case 'Fn::Join': {
      if (!Array.isArray(arg) || arg.length !== 2) return new Unknown('Fn::Join');
      const delimiter = resolve(arg[0], inner);
      const parts = resolve(arg[1], inner);
      if (typeof delimiter !== 'string' || !Array.isArray(parts)) return new Unknown('Fn::Join');
      const bad = parts.find((p) => typeof p !== 'string');
      return bad === undefined ? parts.join(delimiter) : new Unknown(`Fn::Join with ${show(bad)}`);
    }
    case 'Fn::Sub':
      return sub(arg, inner);
    case 'Fn::Select': {
      if (!Array.isArray(arg) || arg.length !== 2) return new Unknown('Fn::Select');
      const index = resolve(arg[0], inner);
      const list = resolve(arg[1], inner);
      if (typeof index !== 'string' || !/^[0-9]+$/.test(index) || !Array.isArray(list) || Number(index) >= list.length) return new Unknown('Fn::Select');
      return list[Number(index)];
    }
    case 'Fn::Split': {
      if (!Array.isArray(arg) || arg.length !== 2) return new Unknown('Fn::Split');
      const delimiter = resolve(arg[0], inner);
      const text = resolve(arg[1], inner);
      return typeof delimiter === 'string' && delimiter !== '' && typeof text === 'string' ? text.split(delimiter) : new Unknown('Fn::Split');
    }
    case 'Fn::FindInMap': {
      if (!Array.isArray(arg) || arg.length < 3) return new Unknown('Fn::FindInMap');
      const [map, top, second] = arg.slice(0, 3).map((k) => resolve(k, inner));
      if (typeof map !== 'string' || typeof top !== 'string' || typeof second !== 'string') return new Unknown('Fn::FindInMap');
      const found = ctx.t.template?.Mappings?.[map]?.[top]?.[second];
      return found === undefined ? new Unknown('Fn::FindInMap') : resolve(found, inner);
    }
    case 'Fn::If': {
      // Both branches are checked: the value is whichever CloudFormation picks.
      if (!Array.isArray(arg) || arg.length !== 3) return new Unknown('Fn::If');
      const a = resolve(arg[1], inner);
      const b = resolve(arg[2], inner);
      return typeof a === 'string' && a === b ? a : new Branches([a, b]);
    }
    case 'Fn::ImportValue': {
      const exportName = resolve(arg, inner);
      if (typeof exportName !== 'string') return new Unknown('Fn::ImportValue');
      const exported = ctx.exports.get(exportName);
      return exported ? resolve(exported.value, { ...inner, t: exported.t }) : new Unknown(`Fn::ImportValue ${exportName} (not exported by a deployed template)`);
    }
    default:
      return new Unknown(name);
  }
}

/**
 * Fn::Sub, string or [string, variables].
 * @param {any} arg
 * @param {Ctx} ctx
 * @returns {any}
 */
function sub(arg, ctx) {
  const [text, vars] = typeof arg === 'string' ? [arg, {}] : Array.isArray(arg) ? arg : [undefined, undefined];
  if (typeof text !== 'string' || !isObject(vars)) return new Unknown('Fn::Sub');
  /** @type {Unknown | null} */
  let unknown = null;
  const out = text.replace(/\$\{(!?)([^}]*)\}/g, (whole, bang, name) => {
    if (bang === '!') return `\${${name}}`;
    let value;
    if (name in vars) value = resolve(vars[name], ctx);
    else if (name.includes('.') && !name.startsWith('AWS::')) value = getAtt(name.slice(0, name.indexOf('.')), name.slice(name.indexOf('.') + 1), ctx);
    else value = ref(name, ctx);
    if (typeof value === 'string') return value;
    unknown = unknown ?? new Unknown(`Fn::Sub ${whole} is ${show(value)}`);
    return whole;
  });
  return unknown ?? out;
}

/**
 * Flatten a worked-out value into the list of values it may be: lists are spread, both branches of an Fn::If kept.
 * @param {any} v
 * @returns {any[]}
 */
function alternatives(v) {
  if (v === undefined || v === NO_VALUE) return [];
  if (Array.isArray(v)) return v.flatMap(alternatives);
  if (v instanceof Branches) return v.values.flatMap(alternatives);
  return [v];
}

/**
 * The account of an IAM or STS ARN and what follows it, or null.
 * @param {string} value
 * @returns {{ account: string, rest: string } | null}
 */
function parseArn(value) {
  const m = IAM_ARN.exec(value);
  return m ? { account: /** @type {string} */ (m[2]), rest: /** @type {string} */ (m[3]) } : null;
}

/**
 * Whether a worked-out value is one of the project's resources: one of the templates' own (Ref, Fn::GetAtt, alone or
 * inside an ARN without an account such as S3's), or an ARN in the account.
 * @param {any} v
 * @param {string} account
 * @returns {boolean}
 */
function ownResource(v, account) {
  if (typeof v !== 'string') return false;
  if (/^<(?:Ref|Fn::GetAtt) [^>]+>$/.test(v)) return true;
  const m = ANY_ARN.exec(v);
  if (!m) return false;
  return m[3] === account || (m[3] === '' && OWN.test(v));
}

/**
 * A problem when any of the values a destination may be is not one of the project's resources.
 * @param {any} value worked out
 * @param {string} what
 * @param {string} account
 * @returns {string | null}
 */
function destinationProblem(value, what, account) {
  const values = alternatives(value);
  const bad = values.find((v) => !ownResource(v, account));
  if (values.length === 0) return `${what} cannot be read`;
  return bad === undefined ? null : `${what} ${show(bad)} is not one of the project's resources in account ${account}`;
}

/**
 * A GitHub repository as owner/repo, lower case, without the immutable ids; null when it is not one.
 * @param {string} repo
 * @returns {string | null}
 */
export function repoName(repo) {
  const m = REPO.exec(repo);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/**
 * The GitHub repository (owner/repo) a git remote URL points at, or null.
 * @param {string} url
 * @returns {string | null}
 */
export function githubRepoFromUrl(url) {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m && repoName(/** @type {string} */ (m[1])) ? /** @type {string} */ (m[1]) : null;
}

/**
 * Problems with the conditions on a trust statement for the account's GitHub provider: exactly ShukkaAccess's
 * shape, with sub pinned to the project's repository.
 * @param {any} condition worked out
 * @param {Set<string>} repos lower-case owner/repo names
 * @returns {string[]}
 */
function oidcConditionProblems(condition, repos) {
  /** @type {string[]} */
  const problems = [];
  if (!isObject(condition)) return ['no conditions (anyone with a GitHub token for any repository could assume it)'];
  const allowed = { StringEquals: [AUD, SUB], StringLike: [WORKFLOW_REF], StringNotLike: [WORKFLOW_REF] };
  for (const [op, block] of Object.entries(condition)) {
    if (!(op in allowed)) {
      problems.push(`condition operator ${op} is not part of shukka's trust`);
      continue;
    }
    if (!isObject(block)) {
      problems.push(`condition ${op} cannot be read`);
      continue;
    }
    for (const key of Object.keys(block)) {
      if (!allowed[/** @type {keyof typeof allowed} */ (op)].includes(key)) problems.push(`condition ${op} ${key} is not part of shukka's trust`);
    }
  }
  const eq = isObject(condition.StringEquals) ? condition.StringEquals : {};
  const like = isObject(condition.StringLike) ? condition.StringLike : {};
  const aud = alternatives(eq[AUD]);
  if (aud.length !== 1 || aud[0] !== 'sts.amazonaws.com') problems.push(`StringEquals ${AUD} must be sts.amazonaws.com, got ${aud.map(show).join(', ') || 'nothing'}`);
  const subs = alternatives(eq[SUB]);
  if (subs.length === 0) problems.push(`no StringEquals ${SUB} (any repository could assume it)`);
  for (const s of subs) {
    const m = typeof s === 'string' ? /^repo:([^:]+):(.+)$/.exec(s) : null;
    const name = m ? repoName(/** @type {string} */ (m[1])) : null;
    if (!m || /[*?]/.test(s) || name === null) problems.push(`StringEquals ${SUB} ${show(s)} is not repo:<owner>/<repo>:<literal>`);
    else if (repos.size === 0) problems.push(`StringEquals ${SUB} ${s}: the project's repository was not given (--repo), so it cannot be checked`);
    else if (!repos.has(name)) problems.push(`StringEquals ${SUB} ${s} names another repository than the project's (${[...repos].join(', ')})`);
  }
  const refs = alternatives(like[WORKFLOW_REF]);
  if (refs.length === 0) problems.push(`no StringLike ${WORKFLOW_REF} (any workflow of the repository could assume it)`);
  for (const r of refs) {
    if (typeof r !== 'string' || !SHUKKA_WORKFLOW_REF.test(r)) problems.push(`StringLike ${WORKFLOW_REF} ${show(r)} is not one of rummykhan/shukka's workflows`);
  }
  return problems;
}

/**
 * The statements of a worked-out policy document, and what is wrong with its shape: a document or statement that
 * cannot be read, or a key outside the IAM grammar (case-sensitive, so `principal` is not `Principal`).
 * @param {any} doc
 * @returns {{ statements: Record<string, any>[], problems: string[] }}
 */
function statementsOf(doc) {
  /** @type {Record<string, any>[]} */
  const statements = [];
  /** @type {string[]} */
  const problems = [];
  for (const d of alternatives(doc)) {
    if (!isObject(d)) {
      problems.push(`the policy document is ${show(d)}`);
      continue;
    }
    for (const key of Object.keys(d)) if (!DOCUMENT_KEYS.has(key)) problems.push(`the policy document has ${JSON.stringify(key)}, which is not an IAM policy key`);
    for (const st of alternatives(d.Statement)) {
      if (!isObject(st)) {
        problems.push(`a statement is ${show(st)}`);
        continue;
      }
      for (const key of Object.keys(st)) if (!STATEMENT_KEYS.has(key)) problems.push(`a statement has ${JSON.stringify(key)}, which is not an IAM statement key`);
      if (st.Effect !== 'Allow' && st.Effect !== 'Deny') problems.push(`a statement's Effect is ${show(st.Effect)}, not Allow or Deny`);
      if (st.Effect !== 'Deny' && st.Principal === undefined && st.NotPrincipal === undefined) problems.push('a statement names no principal');
      statements.push(st);
    }
  }
  return { statements, problems };
}

/**
 * Each principal of a statement as [type, value]; type '*' for Principal: "*".
 * @param {any} principal worked out
 * @returns {[string, any][]}
 */
function principalsOf(principal) {
  /** @type {[string, any][]} */
  const out = [];
  for (const p of alternatives(principal)) {
    if (p === '*') out.push(['*', '*']);
    else if (isObject(p)) for (const [type, values] of Object.entries(p)) for (const v of alternatives(values)) out.push([type, v]);
    else out.push(['?', p]);
  }
  return out;
}

/**
 * How a statement's conditions tie a service to its source: 'pinned' when aws:SourceAccount is the account or
 * aws:SourceArn names the project's resources under an operator that requires a match; 'other' when a source key
 * appears otherwise; 'none' when there is no source key at all.
 * @param {any} condition worked out
 * @param {string} account
 * @returns {'pinned' | 'other' | 'none'}
 */
function sourceOf(condition, account) {
  if (!isObject(condition)) return 'none';
  let seen = false;
  for (const [op, block] of Object.entries(condition)) {
    if (!isObject(block)) {
      seen = true;
      continue;
    }
    for (const [key, value] of Object.entries(block)) {
      const k = key.toLowerCase();
      if (k !== 'aws:sourceaccount' && k !== 'aws:sourcearn' && k !== 'aws:sourceowner') continue;
      seen = true;
      const values = alternatives(value);
      if (!PINNING.has(op) || values.length === 0) continue;
      if (k !== 'aws:sourcearn' && values.every((v) => v === account)) return 'pinned';
      if (k === 'aws:sourcearn' && values.every((v) => ownResource(v, account))) return 'pinned';
    }
  }
  return seen ? 'other' : 'none';
}

/**
 * What is wrong with one principal of a resource policy, or null.
 * @param {string} type
 * @param {any} value
 * @param {any} condition worked out
 * @param {string} account
 * @param {string} resourceType
 * @returns {string | null}
 */
function resourcePrincipalProblem(type, value, condition, account, resourceType) {
  if (type === 'Service' && typeof value === 'string' && SERVICE.test(value)) {
    const source = sourceOf(condition, account);
    if (source === 'pinned' || (source === 'none' && (NO_SOURCE_NEEDED.has(resourceType) || UNCONDITIONED_SERVICES.has(value)))) return null;
    return source === 'other'
      ? `allows Service ${value} with a source condition that is not pinned to account ${account} or the project's resources`
      : `allows Service ${value} without aws:SourceAccount or aws:SourceArn pinned to account ${account} or the project's resources`;
  }
  if (type === 'AWS' && typeof value === 'string' && resourceType === 'AWS::S3::BucketPolicy') {
    const arn = parseArn(value);
    if (ELB_LOG_ACCOUNTS.has(value) || (arn && arn.rest === 'root' && ELB_LOG_ACCOUNTS.has(arn.account))) return null;
  }
  if (type === 'CanonicalUser' && value instanceof Oai) return null;
  if (type === 'AWS' && typeof value === 'string') {
    if (value === account) return null;
    const arn = parseArn(value);
    if (arn && arn.account === account) return null;
    // Legacy CloudFront origin access identities are AWS's own users.
    if (arn && arn.account === 'cloudfront' && /^user\/CloudFront Origin Access Identity [A-Z0-9]+$/.test(arn.rest)) return null;
  }
  if (type === '*' || value === '*') return 'allows "*" (anyone)';
  return `allows ${type} ${show(value)}, outside account ${account}`;
}

/**
 * What is wrong with one principal of a role's trust policy, or null.
 * @param {string} type
 * @param {any} value
 * @param {any} condition worked out
 * @param {string} account
 * @param {Set<string>} repos
 * @returns {string | null}
 */
function trustPrincipalProblem(type, value, condition, account, repos) {
  if (type === '*' || value === '*') return 'trusts "*" (anyone)';
  if (type === 'Service' && typeof value === 'string' && SERVICE.test(value)) return null;
  if (type === 'AWS' && typeof value === 'string') {
    const arn = parseArn(value);
    if (arn && arn.account === account && /^role\/./.test(arn.rest)) return null;
    if (value === account || (arn && arn.account === account && arn.rest === 'root')) return `trusts the whole account ${account} (${value}), not one of its roles`;
    return `trusts AWS ${value}, which is not a role of account ${account}`;
  }
  if (type === 'Federated' && value === `arn:aws:iam::${account}:oidc-provider/${PROVIDER_HOST}`) {
    const problems = oidcConditionProblems(condition, repos);
    return problems.length === 0 ? null : `trusts the account's GitHub provider without shukka's pinned conditions: ${problems.join('; ')}`;
  }
  return `trusts ${type} ${show(value)}, which is not a service, the account's GitHub provider or a role of account ${account}`;
}

/**
 * What is wrong with a Lambda permission, or null.
 * @param {Record<string, any>} props worked out
 * @param {string} type
 * @param {string} account
 * @returns {string[]}
 */
function lambdaPermissionProblems(props, type, account) {
  const values = alternatives(props.Principal);
  if (values.length === 0) return ['names no principal'];
  /** @type {string[]} */
  const problems = [];
  for (const value of values) {
    if (typeof value !== 'string') problems.push(`allows ${show(value)}`);
    else if (value === '*') problems.push('allows "*" (anyone)');
    else if (SERVICE.test(value) && type === 'AWS::Lambda::Permission') {
      const sourceAccount = alternatives(props.SourceAccount);
      const sourceArn = alternatives(props.SourceArn);
      const accountOk = sourceAccount.length === 0 || sourceAccount.every((v) => v === account);
      const arnOk = sourceArn.length === 0 || sourceArn.every((v) => ownResource(v, account));
      const given = sourceAccount.length > 0 || sourceArn.length > 0;
      if (!accountOk || !arnOk) problems.push(`allows Service ${value} with a SourceAccount or SourceArn that is not account ${account} or the project's`);
      else if (!given && !UNCONDITIONED_SERVICES.has(value)) problems.push(`allows Service ${value} without SourceAccount ${account} or a SourceArn of the project's`);
    } else if (value !== account && parseArn(value)?.account !== account) {
      problems.push(`allows ${value}, outside account ${account}`);
    }
  }
  return problems;
}

/**
 * The value at a path into Properties ('[]' spreads a list), as a list of the values found.
 * @param {any} props
 * @param {(string | number)[]} path
 * @returns {any[]}
 */
function valuesAt(props, path) {
  /** @type {any[]} */
  let current = [props];
  for (const step of path) {
    current = step === '[]' ? current.flatMap((c) => alternatives(c)) : current.map((c) => (isObject(c) ? c[step] : undefined)).filter((c) => c !== undefined);
  }
  return current;
}

/**
 * Problems with an S3 bucket's own settings: its ACL, its public access block, where its notifications, replicas and
 * access logs go, and any property not known to be safe.
 * @param {Record<string, any>} props worked out
 * @param {string} account
 * @returns {string[]}
 */
function bucketProblems(props, account) {
  /** @type {string[]} */
  const problems = [];
  for (const key of Object.keys(props)) if (!BUCKET_SAFE.has(key)) problems.push(`property ${key} is not checked by shukka; it may send the bucket's data elsewhere`);
  if (props.AccessControl !== undefined && !(typeof props.AccessControl === 'string' && /^(?:Private|BucketOwnerRead|BucketOwnerFullControl|LogDeliveryWrite)$/.test(props.AccessControl))) {
    // LogDeliveryWrite is AWS's log-delivery group (CDK sets it on a server-access-logs bucket); the rest are public.
    problems.push(`AccessControl ${show(props.AccessControl)} grants access beyond the account (only Private, BucketOwner* and LogDeliveryWrite pass)`);
  }
  const block = props.PublicAccessBlockConfiguration;
  if (block !== undefined) {
    for (const flag of ['BlockPublicAcls', 'BlockPublicPolicy', 'IgnorePublicAcls', 'RestrictPublicBuckets']) {
      const v = isObject(block) ? block[flag] : undefined;
      if (v !== true && v !== 'true') problems.push(`PublicAccessBlockConfiguration ${flag} is ${show(v ?? 'off')}`);
    }
  }
  problems.push(...notificationProblems(props.NotificationConfiguration, account));
  for (const rule of valuesAt(props, ['ReplicationConfiguration', 'Rules', '[]'])) {
    const p = destinationProblem(isObject(rule) ? rule.Destination?.Bucket : undefined, 'replication to', account);
    if (p) problems.push(p);
  }
  if (props.LoggingConfiguration !== undefined) {
    const target = isObject(props.LoggingConfiguration) ? props.LoggingConfiguration.DestinationBucketName : undefined;
    if (!(typeof target === 'string' && /^<(?:Ref|Fn::GetAtt) [^>]+>$/.test(target))) problems.push(`access logs go to ${show(target)}, not a bucket of the project's`);
  }
  return problems;
}

/**
 * Problems with where a bucket's notifications go (S3::Bucket and CDK's Custom::S3BucketNotifications).
 * @param {any} config worked out
 * @param {string} account
 * @returns {string[]}
 */
function notificationProblems(config, account) {
  /** @type {string[]} */
  const problems = [];
  // CloudFormation's names (S3::Bucket) and the S3 API's (CDK's Custom::S3BucketNotifications).
  const lists = [['LambdaConfigurations', 'Function'], ['QueueConfigurations', 'Queue'], ['TopicConfigurations', 'Topic'], ['LambdaFunctionConfigurations', 'LambdaFunctionArn']];
  for (const [list, key] of lists) {
    for (const item of valuesAt(config ?? {}, [/** @type {string} */ (list), '[]'])) {
      const target = isObject(item) ? item[/** @type {string} */ (key)] ?? item.QueueArn ?? item.TopicArn : undefined;
      const p = destinationProblem(target, 'notification to', account);
      if (p) problems.push(p);
    }
  }
  return problems;
}

/**
 * Problems with an SNS subscription (AWS::SNS::Subscription, or one inline in AWS::SNS::Topic).
 * @param {any} subscription worked out
 * @param {string} account
 * @returns {string[]}
 */
function subscriptionProblems(subscription, account) {
  if (!isObject(subscription)) return [`subscription ${show(subscription)} cannot be read`];
  const protocol = subscription.Protocol;
  if (typeof protocol !== 'string' || !/^(?:sqs|lambda|firehose|application)$/.test(protocol)) {
    return [`subscription by ${show(protocol)} to ${show(subscription.Endpoint)} sends messages out of the account`];
  }
  const p = destinationProblem(subscription.Endpoint, `${protocol} subscription to`, account);
  return p ? [p] : [];
}

/**
 * Every JSON file in the assembly (no following of links), relative paths.
 * @param {string} root
 * @returns {string[]}
 */
function jsonFiles(root) {
  /** @type {string[]} */
  const out = [];
  const visit = (/** @type {string} */ rel) => {
    for (const name of readdirSync(join(root, rel))) {
      const path = rel === '' ? name : join(rel, name);
      const st = lstatSync(join(root, path));
      if (st.isDirectory()) visit(path);
      else if (st.isFile() && st.size <= 50 * 1024 * 1024) out.push(path);
    }
  };
  visit('');
  return out;
}

/**
 * The TemplateURL a nested stack published as this asset has: the asset bucket of a CDK bootstrap in the account.
 * @param {Asset} asset
 * @param {string} account
 * @returns {RegExp}
 */
function nestedTemplateUrl(asset, account) {
  const fill = (/** @type {string} */ s) => s.replaceAll('${AWS::AccountId}', account).replaceAll('${AWS::Region}', 'aws-region').replaceAll('${AWS::Partition}', 'aws');
  const bucket = fill(asset.bucket);
  const key = fill(asset.key);
  const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  if (!new RegExp(`^cdk-[a-z0-9]+-assets-${account}-[a-z0-9-]+$`).test(bucket)) return /(?!)/;
  return new RegExp(`^https://s3[.-][a-z0-9.-]*\\.amazonaws\\.com(?:\\.cn)?/${escape(bucket)}/${escape(key)}$`);
}

/**
 * Problems with one resource of a template.
 * @param {string} id
 * @param {any} resource
 * @param {Ctx} ctx
 * @param {Set<string>} repos
 * @returns {string[]}
 */
function resourceProblems(id, resource, ctx, repos) {
  const { account } = ctx;
  const type = isObject(resource) ? resource.Type : undefined;
  if (typeof type !== 'string') return [];
  const raw = isObject(resource.Properties) ? resource.Properties : {};
  const props = resolve(raw, ctx);
  /** @type {string[]} */
  const problems = [];
  /** @param {{ statements: Record<string, any>[], problems: string[] }} parsed */
  const shape = (parsed) => problems.push(...parsed.problems.map((p) => `policy cannot be read: ${p}`));

  if (!HANDLED.has(type)) {
    const keys = Object.keys(raw).filter(POLICY_LIKE);
    if (keys.length > 0) problems.push(`${keys.join(', ')}: shukka does not check this type's policies, so it stops`);
  }
  if (type === 'AWS::IAM::Role') {
    const parsed = statementsOf(props.AssumeRolePolicyDocument);
    shape(parsed);
    for (const st of parsed.statements) {
      if (st.Effect === 'Deny') continue;
      if (st.NotPrincipal !== undefined) problems.push(`trusts everyone but ${show(st.NotPrincipal)} (NotPrincipal)`);
      for (const [ptype, value] of principalsOf(st.Principal)) {
        const p = trustPrincipalProblem(ptype, value, st.Condition, account, repos);
        if (p) problems.push(p);
      }
    }
  }
  for (const path of RESOURCE_POLICIES[type] ?? []) {
    for (const doc of valuesAt(props, path)) {
      const parsed = statementsOf(doc);
      shape(parsed);
      for (const st of parsed.statements) {
        if (st.Effect === 'Deny') continue;
        if (st.NotPrincipal !== undefined) problems.push(`allows everyone but ${show(st.NotPrincipal)} (NotPrincipal)`);
        for (const [ptype, value] of principalsOf(st.Principal)) {
          const p = resourcePrincipalProblem(ptype, value, st.Condition, account, type);
          if (p) problems.push(p);
        }
      }
    }
  }
  switch (type) {
    case 'AWS::Lambda::Permission':
    case 'AWS::Lambda::LayerVersionPermission':
      problems.push(...lambdaPermissionProblems(props, type, account));
      break;
    case 'AWS::S3::Bucket':
      problems.push(...bucketProblems(props, account));
      break;
    case 'Custom::S3BucketNotifications':
      problems.push(...notificationProblems(props.NotificationConfiguration, account));
      break;
    case 'AWS::SNS::Subscription':
      problems.push(...subscriptionProblems(props, account));
      break;
    case 'AWS::SNS::Topic':
      for (const s of valuesAt(props, ['Subscription', '[]'])) problems.push(...subscriptionProblems(s, account));
      break;
    case 'AWS::SQS::Queue': {
      const target = valuesAt(props, ['RedrivePolicy', 'deadLetterTargetArn']);
      if (target.length > 0) {
        const p = destinationProblem(target, 'dead letters go to', account);
        if (p) problems.push(p);
      }
      break;
    }
    case 'AWS::Logs::SubscriptionFilter': {
      const p = destinationProblem(props.DestinationArn, 'log events go to', account);
      if (p) problems.push(p);
      break;
    }
    case 'AWS::Lambda::EventInvokeConfig':
    case 'AWS::Lambda::EventSourceMapping':
      for (const which of ['OnSuccess', 'OnFailure']) {
        const target = valuesAt(props, ['DestinationConfig', which, 'Destination']);
        if (target.length === 0) continue;
        const p = destinationProblem(target, `${which} destination`, account);
        if (p) problems.push(p);
      }
      break;
  }
  return problems.map((p) => `${id} (${type}): ${p}`);
}

/**
 * Problems with the trust and resource policies of every template the assembly deploys.
 * @param {string} dir
 * @param {PolicyOptions} options
 * @returns {{ problems: string[], templates: number } | { unreadable: string }}
 */
export function checkPolicies(dir, options) {
  const { account } = options;
  const repos = new Set((options.repos ?? []).map(repoName).filter((r) => r !== null));
  let root;
  try {
    root = realpathSync(dir);
    JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  } catch (error) {
    return { unreadable: `policy-guard: cannot read ${dir}/manifest.json: ${/** @type {Error} */ (error).message}` };
  }
  const deployed = deployedTemplates(root);
  const problems = deployed.problems.map((p) => p.replace(/^assembly: /, 'policy-guard: '));
  const fileAssets = deployed.assets;

  // Deployed templates: the stacks' own, then nested stacks' reached through them.
  /** @type {Map<string, Template>} */
  const templates = new Map(deployed.stacks.map((s) => [s.file, { file: s.file, template: s.template }]));
  // Every other JSON document with Resources is checked too (it costs nothing), but exports come only from deployed ones.
  /** @type {Map<string, Template>} */
  const others = new Map();
  for (const path of jsonFiles(root)) {
    if (templates.has(path)) continue;
    try {
      const text = readFileSync(join(root, path), 'utf8');
      if (!/^\s*\{/.test(text)) continue;
      const doc = JSON.parse(text);
      if (isObject(doc) && isObject(doc.Resources)) others.set(path, { file: path, template: doc });
    } catch {
      // not JSON: assembly.mjs's deployedTemplates stops any that is deployed or looks like a template
    }
  }
  /** @type {Map<string, { value: any, t: Template }>} */
  const exports = new Map();
  /** @type {Map<string, number>} */
  const exportCount = new Map();
  const queue = [...templates.values()];
  const empty = new Map();
  while (queue.length > 0) {
    const t = /** @type {Template} */ (queue.shift());
    for (const output of Object.values(isObject(t.template.Outputs) ? t.template.Outputs : {})) {
      const name = isObject(output?.Export) ? resolve(output.Export.Name, { account, t, exports: empty, depth: 0 }) : undefined;
      if (typeof name === 'string') {
        exportCount.set(name, (exportCount.get(name) ?? 0) + 1);
        exports.set(name, { value: output.Value, t });
      } else if (output?.Export !== undefined) {
        problems.push(`policy-guard: ${t.file}: an export's name cannot be worked out (${show(name)})`);
      }
    }
    for (const [id, resource] of Object.entries(isObject(t.template.Resources) ? t.template.Resources : {})) {
      if (!isObject(resource) || resource.Type !== 'AWS::CloudFormation::Stack') continue;
      // A nested stack's template must be one read here: the URL is the project's CDK asset bucket and the object
      // key a file asset of the assembly is published under.
      const url = resolve(resource.Properties?.TemplateURL, { account, t, exports: empty, depth: 0 });
      const source = typeof url === 'string' ? fileAssets.find((a) => nestedTemplateUrl(a, account).test(url))?.source : undefined;
      const nested = source === undefined ? undefined : templates.get(source) ?? others.get(source);
      if (!nested) {
        problems.push(`policy-guard: ${t.file}: ${id} (AWS::CloudFormation::Stack): the nested stack's template (${show(url)}) is not a JSON template in the assembly; it cannot be checked`);
      } else if (!templates.has(nested.file)) {
        templates.set(nested.file, nested);
        others.delete(nested.file);
        queue.push(nested);
      }
    }
  }
  for (const [name, count] of exportCount) {
    if (count > 1) problems.push(`policy-guard: the export ${name} is defined ${count} times; which value an import gets cannot be told`);
  }

  const all = [...templates.values(), ...others.values()];
  for (const t of all) {
    const ctx = { account, t, exports, depth: 0 };
    if (t.template.Transform !== undefined) problems.push(`policy-guard: ${t.file}: the template has a Transform (${show(t.template.Transform)}), which rewrites it at deploy time; it cannot be checked`);
    if (JSON.stringify(t.template).includes('"Fn::Transform"')) problems.push(`policy-guard: ${t.file}: the template uses Fn::Transform (a macro or AWS::Include), which changes it at deploy time; it cannot be checked`);
    for (const [id, resource] of Object.entries(t.template.Resources ?? {})) {
      for (const p of resourceProblems(id, resource, ctx, repos)) problems.push(`policy-guard: ${t.file}: ${p}`);
    }
  }
  return { problems: [...new Set(problems)], templates: all.length };
}

/**
 * @param {string} dir
 * @param {PolicyOptions & { allow?: boolean }} options
 * @returns {PolicyResult}
 */
export function policyGuard(dir, options) {
  const checked = checkPolicies(dir, options);
  if ('unreadable' in checked) return { verdict: 'unreadable', code: 1, found: [checked.unreadable], templates: 0 };
  const { problems, templates } = checked;
  if (problems.length === 0) return { verdict: 'safe', code: 0, found: [], templates };
  if (options.allow) return { verdict: 'allowed', code: 0, found: problems, templates };
  return { verdict: 'stopped', code: 1, found: problems, templates };
}

/**
 * The text printed to stdout for a result.
 * @param {PolicyResult} result
 * @returns {string}
 */
export function report(result) {
  switch (result.verdict) {
    case 'unreadable':
      return [...result.found, 'policy-guard: the assembly cannot be read. Stopping.', ''].join('\n');
    case 'safe':
      return `policy-guard: no trust or resource policy lets a principal outside the project in (${result.templates} templates)\n`;
    case 'allowed':
      return [
        'policy-guard: these policies let principals outside the project in, or cannot be checked:',
        ...result.found,
        'policy-guard: allowed by the person who started this run (--allow)',
        '',
      ].join('\n');
    case 'stopped':
      return [
        'policy-guard: these policies let principals outside the project in, or cannot be checked:',
        ...result.found,
        'policy-guard: stopping. If this is intended, run the workflow by hand on main with allow_replacement ticked.',
        '',
      ].join('\n');
  }
}

/**
 * A markdown `### Trust and resource policies` section for the GitHub step summary.
 * @param {PolicyResult} result
 * @returns {string}
 */
export function summary(result) {
  /** @type {Record<Verdict, string>} */
  const headline = {
    unreadable: '**Stopped:** the assembly cannot be read.',
    safe: 'No trust or resource policy lets a principal outside the project in.',
    allowed: '**Allowed by the person who started this run:** these policies let principals outside the project in, or cannot be checked.',
    stopped:
      '**Stopped:** these policies let principals outside the project in, or cannot be checked. If this is intended, run the workflow by hand on `main` with `allow_replacement` ticked.',
  };
  const parts = ['### Trust and resource policies', '', headline[result.verdict], ''];
  if (result.found.length > 0) {
    const body = result.found.join('\n');
    const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    parts.push(fence, body, fence, '');
  }
  return parts.join('\n') + '\n';
}

/**
 * @param {string[]} args
 * @returns {{ dir: string, account: string, repos: string[], allow: boolean, summaryFile?: string } | { error: string }}
 */
export function parseArgs(args) {
  let allow = false;
  /** @type {string | undefined} */
  let dir;
  /** @type {string | undefined} */
  let account;
  /** @type {string[]} */
  const repos = [];
  /** @type {string | undefined} */
  let summaryFile;
  for (let i = 0; i < args.length; i++) {
    const arg = /** @type {string} */ (args[i]);
    const value = args[i + 1];
    const needs = (/** @type {string} */ what) => value === undefined || value === '' || value.startsWith('--') ? `${arg} needs ${what}` : null;
    if (arg === '--allow') {
      allow = true;
    } else if (arg === '--summary' || arg === '--account' || arg === '--repo') {
      const missing = needs(arg === '--summary' ? 'a file' : arg === '--account' ? 'an account id' : 'owner/repo');
      if (missing) return { error: missing };
      const v = /** @type {string} */ (value);
      if (arg === '--summary') summaryFile = v;
      else if (arg === '--account') {
        if (!ACCOUNT.test(v)) return { error: `--account ${v} is not a 12-digit account id` };
        account = v;
      } else {
        if (repoName(v) === null) return { error: `--repo ${v} is not owner/repo` };
        repos.push(v);
      }
      i++;
    } else if (arg.startsWith('--') || dir !== undefined) {
      return { error: `unknown argument: ${arg}` };
    } else {
      dir = arg;
    }
  }
  if (dir === undefined) return { error: 'no assembly directory' };
  if (account === undefined) return { error: '--account is required' };
  return { dir, account, repos, allow, ...(summaryFile === undefined ? {} : { summaryFile }) };
}

/**
 * @param {string[]} args
 * @returns {number} exit code
 */
export function main(args) {
  const parsed = parseArgs(args);
  if ('error' in parsed) {
    process.stderr.write(`policy-guard: ${parsed.error}\nusage: node policy-guard.mjs <assembly dir> --account <id> [--repo <owner/repo>]... [--allow] [--summary <file>]\n`);
    return 2;
  }
  const result = policyGuard(parsed.dir, { account: parsed.account, repos: parsed.repos, allow: parsed.allow });
  process.stdout.write(report(result));
  if (parsed.summaryFile !== undefined) appendFileSync(parsed.summaryFile, summary(result));
  return result.code;
}

// Node resolves symlinks for the entry module, so compare against the real path.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
