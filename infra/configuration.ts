import { Annotations, App } from "aws-cdk-lib";
import { AdmitFlowStack } from "./stack";
import { highAvailabilityContext } from "./context";
import { PRODUCTION, requireProductionConfiguration, ScopedBootstraplessSynthesizer } from "./scoped-synthesis";

/** Context values are explicit nonsecret operator inputs; never infer identity from AWS profiles. */
export function configureApplication(app: App): AdmitFlowStack {
  const stage = app.node.tryGetContext("stage") ?? "staging";
  if (typeof stage !== "string" || !/^[a-z][a-z0-9-]{1,15}$/.test(stage)) throw new Error("stage must be 2–16 lowercase letters, digits or hyphens, starting with a letter.");
  const production = stage === PRODUCTION.stage;
  const region = app.node.tryGetContext("region") ?? (production ? undefined : PRODUCTION.region);
  if (typeof region !== "string" || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new Error("Invalid or missing AWS region.");
  const account = app.node.tryGetContext("account");
  const deployRoleArn = app.node.tryGetContext("deployRoleArn");
  const cloudFormationExecutionRoleArn = app.node.tryGetContext("cloudFormationExecutionRoleArn");
  if (production) requireProductionConfiguration({ account, region, deployRoleArn, cloudFormationExecutionRoleArn });
  else if (account !== undefined || deployRoleArn !== undefined || cloudFormationExecutionRoleArn !== undefined) {
    throw new Error("Nonproduction entrypoint is an offline fixture only; it does not accept deployment account or roles.");
  }
  const stack = new AdmitFlowStack(app, `AdmitFlow-${stage}`, {
    stage,
    env: { account: production ? PRODUCTION.account : undefined, region },
    synthesizer: production ? new ScopedBootstraplessSynthesizer({ deployRoleArn, cloudFormationExecutionRoleArn }) : undefined,
    availabilityZones: [`${region}a`, `${region}b`],
    highAvailability: highAvailabilityContext(app.node.tryGetContext("highAvailability")),
    appSecretKmsKeyArn: app.node.tryGetContext("appSecretKmsKeyArn"),
    alarmTopicArn: app.node.tryGetContext("alarmTopicArn"),
    description: production ? "AdmitFlow scoped production deployment" : "OFFLINE FIXTURE ONLY: unbounded roles are not approved for deployment",
  });
  if (!production) Annotations.of(stack).addWarning("Offline fixture only: production deployment requires stage=prod and the explicit scoped contract.");
  return stack;
}
