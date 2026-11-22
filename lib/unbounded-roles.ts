// Roles that match the project's name prefix but do not carry its permissions boundary (security review of shu-i1b,
// access-7). The execution policy may rewrite and pass any role named `<project>*` or `<Project>*`; a role with that
// name made before the fence (or by hand) has no boundary, so the pipeline could give it any permission. `shukka
// bootstrap` lists them and refuses, or fixes them, before it finishes.
import { boundaryPolicyName } from './boundary.js';

/** The two IAM calls the check makes; an `IAM` client from `@aws-sdk/client-iam` has this shape. */
export interface RoleReader {
  listRoles(input: { Marker?: string }): Promise<{ Roles?: { RoleName?: string }[]; IsTruncated?: boolean; Marker?: string }>;
  /** ListRoles never returns the boundary, so each candidate is read again. */
  getRole(input: { RoleName: string }): Promise<{
    Role?: { RoleName?: string; Arn?: string; PermissionsBoundary?: { PermissionsBoundaryArn?: string } };
  }>;
}

export interface UnboundedRole {
  readonly roleName: string;
  readonly arn: string;
  /** The boundary the role carries instead, if any. */
  readonly boundaryArn?: string;
}

/** Whether a role name falls inside the project's fence (the execution policy's `<project>*` and `<Project>*`). */
export function inProjectPrefix(project: string, roleName: string): boolean {
  const Project = project.charAt(0).toUpperCase() + project.slice(1);
  return roleName.startsWith(project) || roleName.startsWith(Project);
}

/**
 * Every role in the account whose name matches the project prefix and whose permissions boundary is not the
 * project's boundary policy in the role's own account. Empty when all such roles are fenced.
 */
export async function unboundedRoles(iam: RoleReader, project: string): Promise<UnboundedRole[]> {
  const names: string[] = [];
  let marker: string | undefined;
  do {
    const page = await iam.listRoles(marker === undefined ? {} : { Marker: marker });
    for (const r of page.Roles ?? []) if (r.RoleName && inProjectPrefix(project, r.RoleName)) names.push(r.RoleName);
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker !== undefined);

  const out: UnboundedRole[] = [];
  for (const name of names) {
    const { Role: role } = await iam.getRole({ RoleName: name });
    const arn = role?.Arn ?? '';
    // arn:<partition>:iam::<account>:role/<path><name>
    const [, partition, , , account] = arn.split(':');
    const want = `arn:${partition}:iam::${account}:policy/${boundaryPolicyName(project)}`;
    const have = role?.PermissionsBoundary?.PermissionsBoundaryArn;
    if (!arn || have !== want) out.push(have === undefined ? { roleName: name, arn } : { roleName: name, arn, boundaryArn: have });
  }
  return out;
}
