import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BootstraplessSynthesizer, type ISynthesisSession } from "aws-cdk-lib";

/** Nonsecret deployment contract. Bootstrap policies must be reviewed against the same values. */
export const PRODUCTION = {
  account: "543777713748",
  region: "ap-southeast-1",
  stage: "prod",
  stackName: "AdmitFlow-prod",
  domain: "admitflow.incfrog.ai",
  deployRoleArn: "arn:aws:iam::543777713748:role/admitflow/deployment/admitflow-prod-deploy",
  cloudFormationExecutionRoleArn: "arn:aws:iam::543777713748:role/admitflow/deployment/admitflow-prod-cfn-exec",
  workloadRolePath: "/admitflow/workload/prod/",
  boundaryPolicyPath: "/admitflow/boundaries/prod/",
} as const;

export const INLINE_TEMPLATE_LIMIT = 51_200;

export function requireProductionConfiguration(input: {
  account?: unknown; region?: unknown; deployRoleArn?: unknown; cloudFormationExecutionRoleArn?: unknown;
}) {
  for (const key of ["account", "region", "deployRoleArn", "cloudFormationExecutionRoleArn"] as const) {
    if (input[key] !== PRODUCTION[key]) throw new Error(`Production ${key} must explicitly match the approved scoped deployment contract.`);
  }
}

/** Enforce the UTF-8 TemplateBody limit, not the length of pretty JSON or JS characters. */
export function compactInlineTemplate(template: unknown): string {
  const compact = JSON.stringify(template);
  const bytes = Buffer.byteLength(compact, "utf8");
  if (bytes > INLINE_TEMPLATE_LIMIT) {
    throw new Error(`Production template is ${bytes} bytes; inline limit is ${INLINE_TEMPLATE_LIMIT}. Stop and review template-only S3 transport separately; no automatic upload is permitted.`);
  }
  return compact;
}

/** No CDK Admin bootstrap, asset bucket, Docker build, or provider access. */
export class ScopedBootstraplessSynthesizer extends BootstraplessSynthesizer {
  constructor(roles: { deployRoleArn: string; cloudFormationExecutionRoleArn: string }) {
    requireProductionConfiguration({ ...roles, account: PRODUCTION.account, region: PRODUCTION.region });
    // The installed CDK falls back to conventional CDK roles when either value is omitted.
    super({ deployRoleArn: roles.deployRoleArn, cloudFormationExecutionRoleArn: roles.cloudFormationExecutionRoleArn });
  }

  override synthesize(session: ISynthesisSession): void {
    // Keep the installed BootstraplessSynthesizer's no-assets behavior and artifact role metadata.
    super.synthesize(session);
    const filename = join(session.outdir, this.boundStack.templateFile);
    const compact = compactInlineTemplate(JSON.parse(readFileSync(filename, "utf8")));
    writeFileSync(filename, compact, "utf8");
  }
}

/** Separately reviewed, privileged bootstrap artifact; never a resource of the application stack. */
export function valkeyLogDeliveryPolicy() {
  return {
    policyName: "admitflow-prod-valkey-logs",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Service: "delivery.logs.amazonaws.com" },
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: `arn:aws:logs:${PRODUCTION.region}:${PRODUCTION.account}:log-group:/aws/vendedlogs/admitflow/prod/valkey:*`,
        Condition: {
          StringEquals: { "aws:SourceAccount": PRODUCTION.account },
          ArnLike: { "aws:SourceArn": `arn:aws:logs:${PRODUCTION.region}:${PRODUCTION.account}:*` },
        },
      }],
    },
  };
}
