import { CONTRACT } from "./generate.mjs";

// Synthetic AWS IDs: test data, never claims of discovered resources or production configuration.
export const SYNTHETIC_INPUT = Object.freeze({
  ...CONTRACT,
  applicationSecretArn: "arn:aws:secretsmanager:ap-southeast-1:543777713748:secret:admitflow/prod/application-AbCd12",
  applicationSecretKeyMode: "aws-managed",
  certificateArn: "arn:aws:acm:ap-southeast-1:543777713748:certificate/11111111-1111-4111-8111-111111111111",
  validationRecordName: "_11111111111111111111111111111111.admitflow.incfrog.ai",
  loadBalancerArn: "arn:aws:elasticloadbalancing:ap-southeast-1:543777713748:loadbalancer/app/admitflow-prod-alb/1111111111111111",
  targetGroupArn: "arn:aws:elasticloadbalancing:ap-southeast-1:543777713748:targetgroup/admitflow-prod-web/1111111111111111",
  migrationTaskDefinitionArn: "arn:aws:ecs:ap-southeast-1:543777713748:task-definition/admitflow-prod-migration:1",
});
export const SYNTHETIC_KEY = "arn:aws:kms:ap-southeast-1:543777713748:key/22222222-2222-4222-8222-222222222222";
export const PHASES = ["prerequisites", "certificate-metadata", "secret-update", "deployment", "dns-validation", "dns-application", "release-operator"];
