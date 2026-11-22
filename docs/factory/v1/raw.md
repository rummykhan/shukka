# Raw request

Owner, 2026-11-22 (verbatim):

> hold on, you can also continue, but I'm thinking should we invest sometime to build a pipeline in cdk that's reusable and safe, we can use it in other projects too, like orbitary or other future projects?
>
> what do you think, it can be separate npm package that we can pull that have github actions file and also cdk code
>
> to build, test, synth, deploy to aws safely.
>
> e.g. some infra can be done safely, and directly right, but some services like ecs or ec2, might need some extra treatment.
>
> and also this pipeline should be cheap.
>
> maybe for ec2, we can ssh and have a deploy script to pull from github and deploy.

> we can also look at alternatives, like deploying from locally, I mean push the code to github and deploy from local or deploy using script or something and fully from github actions and deploy script via ssh from ec2 and also aws code pipeline.
>
> we can compare the approaches, reliability and cost.

> I remember trying aws code pipeline for another project, it was flawless but there were so many commits and builds in the pipeline, it costed us a lot.
>
> I agree on github actions for now unless we get some fundings or free credits from aws.

> let's focus on github actions deployment

Answers 2026-11-22: home `rummykhan/<name>`, name `shukka`, Trendigle only this delivery, prove the cross-project fence with a throwaway stack in the shared account.

Origin: epic trn-zl4 in the Trendigle tracker (postiz/scheduler), whose design field holds the approach comparison.
