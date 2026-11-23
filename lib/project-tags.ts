// tagProject: the Project tag on everything in a CDK app, including the requests that create EC2 resources.
//
// The fence lets the execution role create EC2 resources only when the create request itself carries
// Project=<project> (aws:RequestTag/Project, statements EC2LaunchTagged and EC2CreateTagged in boundary.ts).
// Tags.of(app) puts the tag on most EC2 resources, and CloudFormation sends it with the create. It does not reach
// a plain CfnLaunchTemplate, such as the one ec2.Instance makes for requireImdsv2: CloudFormation then calls
// CreateLaunchTemplate with no tag and the fence refuses it (shu-9bj.18). tagProject adds the launch-template tag
// specification to those, and tags what an instance launched from the template creates (instance, volumes,
// network interfaces), so they are the project's too.
import { Aspects, CfnResource, Tags, Token } from 'aws-cdk-lib';
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

/**
 * Tags every resource in `scope` with Project=<project>, and makes sure CloudFormation's create request for each
 * launch template carries it. Use it in place of Tags.of(app).add('Project', project).
 */
export function tagProject(scope: IConstruct, project: string): void {
  Tags.of(scope).add('Project', project);
  Aspects.of(scope).add({
    visit(node: IConstruct) {
      if (!(CfnResource.isCfnResource(node) && node.cfnResourceType === ec2.CfnLaunchTemplate.CFN_RESOURCE_TYPE_NAME)) return;
      const lt = node as ec2.CfnLaunchTemplate;
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
