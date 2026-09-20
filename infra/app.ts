import { App } from "aws-cdk-lib";
import { AdmitFlowStack } from "./stack";
import { highAvailabilityContext } from "./context";

const app = new App();
const stage = String(app.node.tryGetContext("stage") ?? "staging");
const region = String(app.node.tryGetContext("region") ?? "ap-southeast-1");
if (!/^[a-z][a-z0-9-]{1,15}$/.test(stage)) throw new Error("stage must be 2–16 lowercase letters, digits or hyphens, starting with a letter.");
if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new Error("Invalid AWS region.");

new AdmitFlowStack(app, `AdmitFlow-${stage}`, {
  stage,
  // Deliberately leave account unresolved: synthesis needs neither credentials nor lookups.
  env: { region },
  availabilityZones: [`${region}a`, `${region}b`],
  highAvailability: highAvailabilityContext(app.node.tryGetContext("highAvailability")),
  appSecretKmsKeyArn: app.node.tryGetContext("appSecretKmsKeyArn"),
  alarmTopicArn: app.node.tryGetContext("alarmTopicArn"),
});
app.synth();
