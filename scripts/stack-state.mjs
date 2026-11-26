#!/usr/bin/env node
// Before cdk deploy (infra.yml's deploy job and `shukka deploy`): stop when a stack the run will deploy is in a
// state CloudFormation cannot update, with a message naming the stack, its state and what an admin must do.
// Otherwise cdk tries to delete the stack itself, and the deploy role's explicit DeleteStack deny fails the
// deploy with no hint (shu-wud). The deploy role may DescribeStacks on <Project>-*.
//
// CLI: node scripts/stack-state.mjs --stacks a,b [--project <name>] [--region <region>] [--summary <file>]
//   --project leaves out the CI stack <Project>-Ci, which the pipeline never deploys
//   --summary appends the stuck stacks, as Markdown, to that file (the job summary)
//   exit 0: no stack is stuck (a stack that cannot be read is a warning: cdk reports it);
//   exit 1: a stack is stuck; exit 2: usage error

import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { ciStackName } from './assembly.mjs';

/**
 * @typedef {{ send: (command: any) => Promise<any> }} Client
 * @typedef {{ name: string, status: string | null }} StackState status null: the stack does not exist
 * @typedef {{ name: string, status: string, advice: string, message: string }} StuckStack
 */

/**
 * The states no update can leave, each with what an admin does about it (`<stack>` is replaced by the name).
 * @type {Record<string, string>}
 */
export const STUCK = {
  ROLLBACK_COMPLETE: 'its creation failed and was rolled back, so it was never created. Delete it by hand with admin credentials '
    + '(aws cloudformation delete-stack --stack-name <stack>), then deploy again',
  ROLLBACK_FAILED: 'its creation failed and the rollback failed too. Delete it by hand with admin credentials '
    + '(aws cloudformation delete-stack --stack-name <stack>, with --retain-resources for any resource that will not delete), then deploy again',
  UPDATE_ROLLBACK_FAILED: 'an update failed and rolling it back failed too. Continue the rollback with admin credentials '
    + '(aws cloudformation continue-update-rollback --stack-name <stack> --resources-to-skip <logical id>, naming each resource that failed '
    + 'to roll back, for example a role the fence will not let the rollback change; only resources that failed during the rollback can be skipped), then deploy again',
  DELETE_FAILED: 'a delete of it failed. Delete it by hand with admin credentials '
    + '(aws cloudformation delete-stack --stack-name <stack>, with --retain-resources for any resource that will not delete), then deploy again',
  REVIEW_IN_PROGRESS: 'a change set created it and was never executed, so it holds nothing. Delete it by hand with admin credentials '
    + '(aws cloudformation delete-stack --stack-name <stack>), then deploy again',
};

/**
 * The stacks among `states` that are in a state cdk cannot deploy over, with the message to print.
 * @param {StackState[]} states
 * @returns {StuckStack[]}
 */
export function stuckStacks(states) {
  /** @type {StuckStack[]} */
  const stuck = [];
  for (const { name, status } of states) {
    if (status === null || !Object.hasOwn(STUCK, status)) continue;
    const advice = /** @type {string} */ (STUCK[status]).replaceAll('<stack>', name);
    stuck.push({ name, status, advice, message: `stack ${name} is in ${status}: ${advice}. The deploy role may not delete stacks, so cdk cannot fix it` });
  }
  return stuck;
}

/**
 * Each stack's status (null when it does not exist). A stack that cannot be read is passed to `warn` and left out.
 * @param {string[]} names
 * @param {Client} cfn
 * @param {(line: string) => void} [warn]
 * @returns {Promise<StackState[]>}
 */
export async function readStackStates(names, cfn, warn = () => {}) {
  /** @type {StackState[]} */
  const states = [];
  for (const name of names) {
    try {
      const r = await cfn.send(new DescribeStacksCommand({ StackName: name }));
      const status = r.Stacks?.[0]?.StackStatus;
      states.push({ name, status: typeof status === 'string' && status !== 'DELETE_COMPLETE' ? status : null });
    } catch (error) {
      const e = /** @type {{ name?: string, message?: string }} */ (error);
      if (/does not exist/.test(e.message ?? '')) states.push({ name, status: null });
      else warn(`could not read the state of stack ${name}: ${(e.message ?? String(error)).split('\n')[0]}`);
    }
  }
  return states;
}

/**
 * The job summary section for stuck stacks.
 * @param {StuckStack[]} stuck
 * @returns {string}
 */
export function summary(stuck) {
  if (stuck.length === 0) return '';
  const rows = stuck.map((s) => `| \`${s.name}\` | \`${s.status}\` | ${s.advice.replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;')} |`);
  return ['### Infrastructure not deployed: a stack is stuck', '',
    'The deploy role may not delete stacks, so cdk cannot deploy over these. An admin has to act first:', '',
    '| Stack | State | What to do |', '|---|---|---|', ...rows, '', ''].join('\n');
}

const USAGE = 'usage: node scripts/stack-state.mjs --stacks a,b [--project <name>] [--region <region>] [--summary <file>]';

/**
 * @param {string[]} argv
 * @param {{ cfn?: Client, out?: (text: string) => void, err?: (text: string) => void }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const out = deps.out ?? ((text) => process.stdout.write(text));
  const err = deps.err ?? ((text) => process.stderr.write(text));
  /** @type {Record<string, string>} */
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!['--stacks', '--project', '--region', '--summary'].includes(key ?? '') || value === undefined || value.startsWith('-')) {
      err(`${USAGE}\n`);
      return 2;
    }
    opts[/** @type {string} */ (key).slice(2)] = value;
  }
  if (opts.stacks === undefined) {
    err(`${USAGE}\n`);
    return 2;
  }
  const ci = opts.project !== undefined ? ciStackName(opts.project) : null;
  const names = opts.stacks.split(',').map((s) => s.trim()).filter((s) => s !== '' && s !== ci);
  const cfn = deps.cfn ?? new CloudFormationClient(opts.region !== undefined ? { region: opts.region } : {});
  const states = await readStackStates(names, cfn, (line) => out(`::warning::shukka: ${line}\n`));
  const stuck = stuckStacks(states);
  for (const s of stuck) out(`::error::shukka: ${s.message}\n`);
  if (stuck.length > 0 && opts.summary !== undefined) appendFileSync(opts.summary, summary(stuck));
  if (stuck.length === 0) out(`shukka: no stack is stuck (${names.length} checked)\n`);
  return stuck.length > 0 ? 1 : 0;
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
