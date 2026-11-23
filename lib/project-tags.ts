// tagProject: the Project tag on everything in a CDK app, including the requests that create EC2 resources.
//
// The fence lets the execution role create EC2 resources only when the create request itself carries
// Project=<project> (aws:RequestTag/Project, statements EC2LaunchTagged and EC2CreateTagged in boundary.ts).
// Tags.of(app) puts the tag on most EC2 resources, and CloudFormation sends it with the create. It does not reach
// a plain CfnLaunchTemplate, such as the one ec2.Instance makes for requireImdsv2: CloudFormation then calls
// CreateLaunchTemplate with no tag and the fence refuses it (shu-9bj.18). tagProject adds the launch-template tag
// specification to those, and tags what an instance launched from the template creates (instance, volumes,
// network interfaces), so they are the project's too.
//
// Launch template names are unique per account and region, and ec2.Instance names its requireImdsv2 template
// <construct id>LaunchTemplate, so two projects with an instance called Box collide (shu-9bj.20). tagProject also
// prefixes every launch template name that does not start with the project: <project>-<name>, within EC2's 128
// characters and allowed characters. The name is derived only from the original, so it is the same on every synth.
// The fence does not depend on it: its launch-template statements go by the Project tag.
import { createHash } from 'node:crypto';
import { Annotations, Aspects, CfnResource, Stack, Tags, Token } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { IConstruct } from 'constructs';

type TagSpec = { resourceType?: string; tags?: { key: string; value: string }[] };

/** The resource types a launch template's own instances create and tag from its data. */
const LAUNCHED = ['instance', 'volume', 'network-interface'];

/** Adds Project=<project> to the tag specification of `resourceType` in `specs`, or a new one for it. */
function withProject(specs: unknown, resourceType: string, project: string): TagSpec[] | undefined {
  if (specs !== undefined && (Token.isUnresolved(specs) || !Array.isArray(specs))) return undefined;
  const list = [...((specs as TagSpec[] | undefined) ?? [])];
  const at = list.findIndex((s) => s.resourceType === resourceType);
  if (at < 0) return [...list, { resourceType, tags: [{ key: 'Project', value: project }] }];
  const spec = list[at] as TagSpec;
  if (spec.tags !== undefined && (Token.isUnresolved(spec.tags) || !Array.isArray(spec.tags))) return undefined;
  const tags = (spec.tags ?? []).filter((t) => t.key !== 'Project');
  list[at] = { ...spec, tags: [...tags, { key: 'Project', value: project }] };
  return list;
}

/** EC2's rule for launch template names: 3 to 128 of these characters. */
const MAX_NAME = 128;

/** `<project>-<name>` with characters EC2 refuses replaced by '-', cut to 128 with a hash of the whole kept at the end. */
function prefixedName(project: string, name: string): string {
  const full = `${project}-${name.replace(/[^a-zA-Z0-9().\-/_]/g, '-')}`;
  if (full.length <= MAX_NAME) return full;
  const hash = createHash('sha256').update(full).digest('hex').slice(0, 8);
  return `${full.slice(0, MAX_NAME - hash.length - 1)}-${hash}`;
}

/**
 * Gives `lt` a project-prefixed name unless it has none or already starts with the project, and points instances in
 * its stack that launch from it by its old name at the new one. A token name is left alone, with a warning.
 */
function prefixLaunchTemplateName(lt: ec2.CfnLaunchTemplate, project: string): void {
  const old = lt.launchTemplateName;
  if (old === undefined) return;
  if (Token.isUnresolved(old)) {
    Annotations.of(lt).addWarningV2('shukka:launchTemplateName',
      `tagProject cannot check this LaunchTemplateName (a token); launch template names are account-wide, so make sure it starts with '${project}'.`);
    return;
  }
  if (old.startsWith(project)) return;
  const name = prefixedName(project, old);
  lt.launchTemplateName = name;
  for (const c of Stack.of(lt).node.findAll()) {
    if (!(c instanceof ec2.CfnInstance)) continue;
    const spec = c.launchTemplate as ec2.CfnInstance.LaunchTemplateSpecificationProperty | undefined;
    if (spec && !Token.isUnresolved(spec) && spec.launchTemplateName === old) c.launchTemplate = { ...spec, launchTemplateName: name };
  }
}

/**
 * Tags every resource in `scope` with Project=<project>, and makes sure CloudFormation's create request for each
 * launch template carries it, and that each launch template's name starts with the project. Use it in place of Tags.of(app).add('Project', project).
 */
export function tagProject(scope: IConstruct, project: string): void {
  Tags.of(scope).add('Project', project);
  Aspects.of(scope).add({
    visit(node: IConstruct) {
      if (!(CfnResource.isCfnResource(node) && node.cfnResourceType === ec2.CfnLaunchTemplate.CFN_RESOURCE_TYPE_NAME)) return;
      const lt = node as ec2.CfnLaunchTemplate;
      prefixLaunchTemplateName(lt, project);
      // An ec2.LaunchTemplate renders its tag specifications from Tags.of, so they already hold the tag.
      const own = withProject(lt.tagSpecifications, 'launch-template', project);
      if (own) lt.tagSpecifications = own as ec2.CfnLaunchTemplate.LaunchTemplateTagSpecificationProperty[];
      const data = lt.launchTemplateData as ec2.CfnLaunchTemplate.LaunchTemplateDataProperty;
      if (Token.isUnresolved(data)) return;
      let specs: unknown = data.tagSpecifications;
      for (const t of LAUNCHED) {
        const next = withProject(specs, t, project);
        if (!next) return;
        specs = next;
      }
      lt.launchTemplateData = { ...data, tagSpecifications: specs as ec2.CfnLaunchTemplate.TagSpecificationProperty[] };
    },
  });
}
