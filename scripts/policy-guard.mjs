#!/usr/bin/env node
// Reads every CloudFormation template in a synthesized CDK cloud assembly (cdk.out), nested assemblies and nested
// stacks included, and stops when a policy would let a principal outside the project in. The execution role may
// create and re-trust roles named <project>*, and write bucket, queue, topic and function policies, so a changed
// assembly (a compromised dependency editing cdk.out after a clean pull-request diff) could otherwise hand an outside
// account lasting credentials inside the fence. Like guard.mjs it stops a merge; a run started by hand with
// allow_replacement (`--allow`) goes ahead.
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
//   - an S3 bucket, SQS queue or SNS topic policy, or a Lambda permission (Allow), naming "*" or another account
//     (Service principals, the account itself and its roles are fine);
//   - anything the check cannot read: a value it cannot work out (a parameter, a stack name, a custom resource's
//     attribute), a nested stack whose template is not in the assembly, a transform or macro, a template that is not
//     JSON. A legitimate CDK app has none of these in its principals.
//
// Intrinsics worked out: Ref of AWS::AccountId, AWS::Partition, AWS::URLSuffix, AWS::Region and AWS::NoValue;
// Fn::GetAtt <role>.Arn of a role in the same template; Fn::Join, Fn::Sub, Fn::Select, Fn::Split, Fn::FindInMap;
// Fn::If (both branches must pass); Fn::ImportValue of another template's export in the assembly.
//
// Usage: node scripts/policy-guard.mjs <assembly dir> --account <12 digits> [--repo <owner/repo>]... [--allow]
//                                      [--summary <file>]
// --repo names the project's GitHub repository (owner/repo or owner@id/repo@id); without it no OIDC trust passes.
// Exit 0: nothing opens the project (or it was allowed). Exit 1: something does, or the assembly cannot be read.
// Exit 2: bad arguments.

import { appendFileSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROVIDER_HOST = 'token.actions.githubusercontent.com';
const AUD = `${PROVIDER_HOST}:aud`;
const SUB = `${PROVIDER_HOST}:sub`;
const WORKFLOW_REF = `${PROVIDER_HOST}:job_workflow_ref`;
// shukka's own nested workflows at a tag or branch of rummykhan/shukka (only its owner can push either).
const SHUKKA_WORKFLOW_REF = /^rummykhan\/shukka\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@refs\/(?:tags|heads)\/[A-Za-z0-9._/*-]+$/;
const SERVICE = /^[a-z0-9][a-z0-9.-]*\.amazonaws\.com(?:\.cn)?$/;
const ACCOUNT = /^[0-9]{12}$/;
const ARN = /^arn:aws[a-z-]*:(iam|sts)::([^:]*):(.+)$/;
// GitHub owner and repository names, as ShukkaAccess takes them; the immutable form carries ids after @.
const REPO = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})(?:@[0-9]+)?\/([A-Za-z0-9._-]{1,100})(?:@[0-9]+)?$/;
const RESOURCE_POLICIES = new Set([
  'AWS::S3::BucketPolicy', 'AWS::SQS::QueuePolicy', 'AWS::SQS::QueueInlinePolicy', 'AWS::SNS::TopicPolicy', 'AWS::SNS::TopicInlinePolicy',
]);
const LAMBDA_PERMISSIONS = new Set(['AWS::Lambda::Permission', 'AWS::Lambda::LayerVersionPermission']);

/**
 * @typedef {'safe' | 'stopped' | 'allowed' | 'unreadable'} Verdict
 * @typedef {{ verdict: Verdict, code: 0 | 1, found: string[], templates: number }} PolicyResult
 * @typedef {{ account: string, repos?: string[] }} PolicyOptions
 * @typedef {{ file: string, template: any }} Template
 * @typedef {{ account: string, t: Template, exports: Map<string, { value: any, t: Template }>, depth: number }} Ctx
 * @typedef {{ bucket: string, key: string, source: string }} Asset
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
const NO_VALUE = Symbol('AWS::NoValue');

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * Ref of a pseudo parameter, a parameter or a resource.
 * @param {string} name
 * @param {Ctx} ctx
 * @returns {any}
 */
function ref(name, ctx) {
  switch (name) {
    case 'AWS::AccountId': return ctx.account;
    case 'AWS::Partition': return 'aws';
    case 'AWS::URLSuffix': return 'amazonaws.com';
    // Regions only appear in service principals here (logs.<region>.amazonaws.com); any one will do.
    case 'AWS::Region': return 'aws-region';
    case 'AWS::NoValue': return NO_VALUE;
    default: return new Unknown(`Ref ${name}`);
  }
}

/**
 * Fn::GetAtt: a role's Arn, a CloudFront origin access identity's canonical user; nothing else.
 * @param {string} id
 * @param {string} attr
 * @param {Ctx} ctx
 * @returns {any}
 */
function getAtt(id, attr, ctx) {
  const resource = ctx.t.template?.Resources?.[id];
  if (resource?.Type === 'AWS::IAM::Role' && attr === 'Arn') return `arn:aws:iam::${ctx.account}:role/${id}`;
  if (resource?.Type === 'AWS::CloudFront::CloudFrontOriginAccessIdentity' && attr === 'S3CanonicalUserId') return new Oai(id);
  return new Unknown(`Fn::GetAtt ${id}.${attr}`);
}

/**
 * Work out a template value: a string, a list, an object with its values worked out, or Unknown.
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
      return JSON.stringify(a) === JSON.stringify(b) && !(a instanceof Unknown) ? a : { [BRANCHES]: [a, b] };
    }
    case 'Fn::ImportValue': {
      const exportName = resolve(arg, inner);
      if (typeof exportName !== 'string') return new Unknown('Fn::ImportValue');
      const exported = ctx.exports.get(exportName);
      return exported ? resolve(exported.value, { ...inner, t: exported.t }) : new Unknown(`Fn::ImportValue ${exportName} (not exported in this assembly)`);
    }
    default:
      return new Unknown(name);
  }
}

// Fn::If with different branches: both are checked wherever the value is used.
const BRANCHES = '\u0000branches';

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
  if (isObject(v) && BRANCHES in v) return v[BRANCHES].flatMap(alternatives);
  return [v];
}

/**
 * The account of an IAM or STS ARN and what follows it, or null.
 * @param {string} value
 * @returns {{ account: string, rest: string } | null}
 */
function parseArn(value) {
  const m = ARN.exec(value);
  return m ? { account: /** @type {string} */ (m[2]), rest: /** @type {string} */ (m[3]) } : null;
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
 * The values of a condition as a list of worked-out values.
 * @param {any} v
 * @returns {any[]}
 */
function conditionValues(v) {
  return alternatives(v);
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
  const aud = conditionValues(eq[AUD]);
  if (aud.length !== 1 || aud[0] !== 'sts.amazonaws.com') problems.push(`StringEquals ${AUD} must be sts.amazonaws.com, got ${aud.map(show).join(', ') || 'nothing'}`);
  const subs = conditionValues(eq[SUB]);
  if (subs.length === 0) problems.push(`no StringEquals ${SUB} (any repository could assume it)`);
  for (const s of subs) {
    const m = typeof s === 'string' ? /^repo:([^:]+):(.+)$/.exec(s) : null;
    const name = m ? repoName(/** @type {string} */ (m[1])) : null;
    if (!m || /[*?]/.test(s) || name === null) problems.push(`StringEquals ${SUB} ${show(s)} is not repo:<owner>/<repo>:<literal>`);
    else if (repos.size === 0) problems.push(`StringEquals ${SUB} ${s}: the project's repository was not given (--repo), so it cannot be checked`);
    else if (!repos.has(name)) problems.push(`StringEquals ${SUB} ${s} names another repository than the project's (${[...repos].join(', ')})`);
  }
  const refs = conditionValues(like[WORKFLOW_REF]);
  if (refs.length === 0) problems.push(`no StringLike ${WORKFLOW_REF} (any workflow of the repository could assume it)`);
  for (const r of refs) {
    if (typeof r !== 'string' || !SHUKKA_WORKFLOW_REF.test(r)) problems.push(`StringLike ${WORKFLOW_REF} ${show(r)} is not one of rummykhan/shukka's workflows`);
  }
  return problems;
}

/**
 * The statements of a worked-out policy document; a problem when it cannot be read.
 * @param {any} doc
 * @returns {{ statements: Record<string, any>[], problem?: string }}
 */
function statementsOf(doc) {
  if (doc instanceof Unknown) return { statements: [], problem: `the policy document is ${show(doc)}` };
  const docs = alternatives(doc);
  /** @type {Record<string, any>[]} */
  const statements = [];
  for (const d of docs) {
    if (!isObject(d)) return { statements: [], problem: `the policy document is ${show(d)}` };
    for (const st of alternatives(d.Statement)) {
      if (!isObject(st)) return { statements: [], problem: `a statement is ${show(st)}` };
      statements.push(st);
    }
  }
  return { statements };
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
 * What is wrong with one principal of a resource policy (S3, SQS, SNS), or null.
 * @param {string} type
 * @param {any} value
 * @param {string} account
 * @returns {string | null}
 */
function resourcePrincipalProblem(type, value, account) {
  if (type === 'Service' && typeof value === 'string' && SERVICE.test(value)) return null;
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
 * What is wrong with a Lambda permission's principal, or null.
 * @param {any} value worked out
 * @param {string} account
 * @returns {string | null}
 */
function lambdaPrincipalProblem(value, account) {
  if (typeof value !== 'string') return `allows ${show(value)}`;
  if (value === '*') return 'allows "*" (anyone)';
  if (SERVICE.test(value) || value === account) return null;
  const arn = parseArn(value);
  if (arn && arn.account === account) return null;
  return `allows ${value}, outside account ${account}`;
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
 * A path named in a manifest, resolved against the manifest's directory, still inside the root; or null.
 * @param {string} root
 * @param {string} base
 * @param {unknown} path
 * @returns {string | null}
 */
function inside(root, base, path) {
  if (typeof path !== 'string' || path === '' || isAbsolute(path)) return null;
  const rel = relative(root, join(root, base, path));
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel;
}

/**
 * Reads the assembly: every document with Resources (templates under any name), the stack templates the manifests
 * name (which must be JSON), and the object keys file assets are published under (to find nested stack templates).
 * @param {string} root
 * @returns {{ templates: Template[], problems: string[], assets: Asset[] }}
 */
function readAssembly(root) {
  /** @type {Template[]} */
  const templates = [];
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, any>} */
  const docs = new Map();
  for (const path of jsonFiles(root)) {
    try {
      const text = readFileSync(join(root, path), 'utf8');
      if (!/^\s*\{/.test(text)) continue;
      docs.set(path, JSON.parse(text));
    } catch {
      // not JSON: only a problem when a manifest names it as a template (below)
    }
  }
  for (const [file, doc] of docs) if (isObject(doc) && isObject(doc.Resources)) templates.push({ file, template: doc });

  /** @type {Asset[]} where each file asset is published, from every asset manifest */
  const assets = [];
  for (const [file, doc] of docs) {
    if (!isObject(doc) || !isObject(doc.files)) continue;
    const base = file.includes(sep) ? file.slice(0, file.lastIndexOf(sep)) : '';
    for (const asset of Object.values(doc.files)) {
      const source = inside(root, base, asset?.source?.path);
      for (const d of Object.values(isObject(asset?.destinations) ? asset.destinations : {})) {
        if (source !== null && typeof d?.objectKey === 'string' && typeof d?.bucketName === 'string') {
          assets.push({ bucket: d.bucketName, key: d.objectKey, source });
        }
      }
    }
  }

  // Stack templates through every manifest, nested assemblies included: each must be a JSON template read above.
  const queue = [''];
  const seen = new Set();
  while (queue.length > 0) {
    const base = /** @type {string} */ (queue.shift());
    if (seen.has(base)) continue;
    seen.add(base);
    const where = base === '' ? 'manifest.json' : join(base, 'manifest.json');
    const manifest = docs.get(where);
    if (!isObject(manifest)) {
      problems.push(`policy-guard: cannot read ${where}`);
      continue;
    }
    for (const [id, artifact] of Object.entries(isObject(manifest.artifacts) ? manifest.artifacts : {})) {
      const props = isObject(artifact?.properties) ? artifact.properties : {};
      if (artifact?.type === 'cdk:cloud-assembly') {
        const nested = inside(root, base, props.directoryName);
        if (nested === null) problems.push(`policy-guard: ${where}: nested assembly ${id} cannot be read`);
        else queue.push(nested);
      }
      if (artifact?.type === 'aws:cloudformation:stack' && props.templateFile !== undefined) {
        const file = inside(root, base, props.templateFile);
        if (file === null || !isObject(docs.get(file)) || !isObject(docs.get(file).Resources ?? {})) {
          problems.push(`policy-guard: ${where}: stack ${id} template ${show(props.templateFile)} is not a JSON template in the assembly; it cannot be checked`);
        }
      }
    }
  }
  return { templates, problems, assets };
}

/**
 * Problems with the trust and resource policies of every template in the assembly.
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
    readFileSync(join(root, 'manifest.json'));
  } catch (error) {
    return { unreadable: `policy-guard: cannot read ${dir}/manifest.json: ${/** @type {Error} */ (error).message}` };
  }
  const { templates, problems, assets } = readAssembly(root);
  const templateFiles = new Set(templates.map((t) => t.file));

  /** @type {Map<string, { value: any, t: Template }>} */
  const exports = new Map();
  for (const t of templates) {
    for (const output of Object.values(isObject(t.template.Outputs) ? t.template.Outputs : {})) {
      const name = output?.Export?.Name;
      if (typeof name === 'string') exports.set(name, { value: output.Value, t });
    }
  }

  for (const t of templates) {
    const ctx = { account, t, exports, depth: 0 };
    const at = (/** @type {string} */ id, /** @type {string} */ type) => `policy-guard: ${t.file}: ${id} (${type})`;
    if (t.template.Transform !== undefined) problems.push(`policy-guard: ${t.file}: the template has a Transform (${show(t.template.Transform)}), which rewrites it at deploy time; it cannot be checked`);
    if (JSON.stringify(t.template).includes('"Fn::Transform"')) problems.push(`policy-guard: ${t.file}: the template uses Fn::Transform (a macro or AWS::Include), which changes it at deploy time; it cannot be checked`);
    for (const [id, resource] of Object.entries(t.template.Resources)) {
      const type = isObject(resource) ? resource.Type : undefined;
      if (typeof type !== 'string') continue;
      const props = isObject(resource.Properties) ? resource.Properties : {};
      if (type === 'AWS::IAM::Role') {
        const { statements, problem } = statementsOf(resolve(props.AssumeRolePolicyDocument, ctx));
        if (problem) problems.push(`${at(id, type)}: trust policy cannot be read: ${problem}`);
        for (const st of statements) {
          if (st.Effect === 'Deny') continue;
          if (st.NotPrincipal !== undefined) problems.push(`${at(id, type)}: trusts everyone but ${show(st.NotPrincipal)} (NotPrincipal)`);
          for (const [ptype, value] of principalsOf(st.Principal)) {
            const p = trustPrincipalProblem(ptype, value, st.Condition, account, repos);
            if (p) problems.push(`${at(id, type)}: ${p}`);
          }
        }
      } else if (RESOURCE_POLICIES.has(type)) {
        const { statements, problem } = statementsOf(resolve(props.PolicyDocument, ctx));
        if (problem) problems.push(`${at(id, type)}: policy cannot be read: ${problem}`);
        for (const st of statements) {
          if (st.Effect === 'Deny') continue;
          if (st.NotPrincipal !== undefined) problems.push(`${at(id, type)}: allows everyone but ${show(st.NotPrincipal)} (NotPrincipal)`);
          for (const [ptype, value] of principalsOf(st.Principal)) {
            const p = resourcePrincipalProblem(ptype, value, account);
            if (p) problems.push(`${at(id, type)}: ${p}`);
          }
        }
      } else if (LAMBDA_PERMISSIONS.has(type)) {
        const values = alternatives(resolve(props.Principal, ctx));
        if (values.length === 0) problems.push(`${at(id, type)}: names no principal`);
        for (const value of values) {
          const p = lambdaPrincipalProblem(value, account);
          if (p) problems.push(`${at(id, type)}: ${p}`);
        }
      } else if (type === 'AWS::CloudFormation::Stack') {
        // A nested stack's template must be one read here: the URL is the project's CDK asset bucket and the object
        // key a file asset of the assembly is published under.
        const url = resolve(props.TemplateURL, ctx);
        const source = typeof url === 'string' ? assets.find((a) => nestedTemplateUrl(a, account).test(url))?.source : undefined;
        if (source === undefined || !templateFiles.has(source)) problems.push(`${at(id, type)}: the nested stack's template (${show(url)}) is not a JSON template in the assembly; it cannot be checked`);
      }
    }
  }
  return { problems: [...new Set(problems)], templates: templates.length };
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
