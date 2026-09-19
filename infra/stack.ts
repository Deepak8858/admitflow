import {
  CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, Stack, Tags,
  type StackProps,
  aws_certificatemanager as acm,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cloudwatchActions,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticache as elasticache,
  aws_elasticloadbalancingv2 as elbv2,
  aws_kms as kms,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

export interface AdmitFlowStackProps extends StackProps {
  stage: string;
  availabilityZones: string[];
  highAvailability?: boolean;
  /** Existing CMK, only when the existing application secret uses a customer-managed key. */
  appSecretKmsKeyArn?: string;
  alarmTopicArn?: string;
}

// Every selected JSON key must exist in the existing secret. Optional providers use empty strings.
export const SHARED_SECRET_KEYS = [
  "DATABASE_URL", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET",
  "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
  "BILLING_RAZORPAY_KEY_ID", "BILLING_RAZORPAY_KEY_SECRET", "BILLING_PLANS_JSON",
] as const;
export const WEB_SECRET_KEYS = [
  "WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_COOKIE_PASSWORD", "WORKOS_WEBHOOK_SECRET",
  "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN", "META_LEADS_WEBHOOK_VERIFY_TOKEN", "GOOGLE_OAUTH_STATE_SECRET",
  "BILLING_RAZORPAY_WEBHOOK_SECRET", "BILLING_RAZORPAY_ACCOUNT_ID",
  "CRON_SECRET",
] as const;

/** No lookups, Docker builds, secret reads or provider calls occur while constructing this stack. */
export class AdmitFlowStack extends Stack {
  constructor(scope: Construct, id: string, props: AdmitFlowStackProps) {
    super(scope, id, props);
    const prefix = `admitflow-${props.stage}`;
    Tags.of(this).add("Application", "AdmitFlow");
    Tags.of(this).add("Environment", props.stage);

    const domain = new CfnParameter(this, "DomainName", {
      type: "String", description: "Public application hostname, e.g. app.example.com. Configure DNS separately.",
      allowedPattern: "(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z]{2,63}",
    });
    const certificateArn = new CfnParameter(this, "CertificateArn", {
      type: "String", description: "Existing, issued ACM certificate in the stack region covering DomainName.",
      allowedPattern: "arn:[^:]+:acm:[^:]+:[0-9]{12}:certificate/.+",
    });
    const appSecretArn = new CfnParameter(this, "AppSecretArn", {
      type: "String", noEcho: true, description: "Complete ARN (including six-character suffix) of the existing Secrets Manager JSON secret.",
      allowedPattern: "arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+-[A-Za-z0-9]{6}",
    });
    const imageDigest = (name: string) => new CfnParameter(this, name, {
      type: "String", allowedPattern: "sha256:[a-f0-9]{64}",
      description: "Immutable ECR image digest. Build and push this release before starting tasks.",
    });
    const webDigest = imageDigest("WebImageDigest"), workerDigest = imageDigest("WorkerImageDigest");
    const webCount = new CfnParameter(this, "WebDesiredCount", { type: "Number", default: props.highAvailability ? 2 : 1, minValue: 0, maxValue: 10 });
    const workerCount = new CfnParameter(this, "WorkerDesiredCount", { type: "Number", default: 1, minValue: 0, maxValue: 10 });
    const cacheNodeType = new CfnParameter(this, "CacheNodeType", { type: "String", default: "cache.t4g.small", allowedPattern: "cache\\.[a-z0-9]+\\.[a-z0-9]+" });
    const metaAppId = new CfnParameter(this, "MetaAppId", { type: "String", default: "", allowedPattern: "[0-9]*", description: "Must match NEXT_PUBLIC_META_APP_ID used to build the web image." });
    const metaConfigId = new CfnParameter(this, "MetaConfigId", { type: "String", default: "", allowedPattern: "[0-9]*", description: "Must match NEXT_PUBLIC_META_CONFIG_ID used to build the web image." });
    const metaApiVersion = new CfnParameter(this, "MetaApiVersion", { type: "String", default: "v23.0", allowedPattern: "v[0-9]+\\.[0-9]+" });
    const knowledgeVector = new CfnParameter(this, "KnowledgeVectorEnabled", { type: "String", default: "false", allowedValues: ["true", "false"], description: "Enable only after the reviewed optional pgvector migration and provider configuration are ready." });

    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.42.0.0/16"), availabilityZones: props.availabilityZones,
      natGateways: 0,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "Queue", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      // Services use dedicated groups; leaving the unused default group alone avoids a custom resource.
      restrictDefaultSecurityGroup: false,
    });
    const albGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", { vpc, allowAllOutbound: false });
    const webGroup = new ec2.SecurityGroup(this, "WebSecurityGroup", { vpc, allowAllOutbound: false });
    const workerGroup = new ec2.SecurityGroup(this, "WorkerSecurityGroup", { vpc, allowAllOutbound: false });
    const migrationGroup = new ec2.SecurityGroup(this, "MigrationSecurityGroup", { vpc, allowAllOutbound: false });
    const cacheGroup = new ec2.SecurityGroup(this, "CacheSecurityGroup", { vpc, allowAllOutbound: false });
    cacheGroup.connections.allowInternally(ec2.Port.tcp(6379), "Valkey primary/replica replication");
    for (const group of [webGroup, workerGroup, migrationGroup]) {
      group.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "AWS APIs, WorkOS, R2 and provider HTTPS");
      group.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5432), "Neon PostgreSQL over TLS");
    }
    for (const group of [webGroup, workerGroup]) {
      group.connections.allowTo(cacheGroup, ec2.Port.tcp(6379), "Private Valkey over TLS");
    }

    const logGroup = (name: string) => new logs.LogGroup(this, `${name}Logs`, {
      logGroupName: `/admitflow/${props.stage}/${name.toLowerCase()}`,
      retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.RETAIN,
    });
    const webLogs = logGroup("Web"), workerLogs = logGroup("Worker"), migrationLogs = logGroup("Migration");
    const cacheLogs = new logs.LogGroup(this, "ValkeyLogs", {
      logGroupName: `/aws/vendedlogs/admitflow/${props.stage}/valkey`,
      retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.RETAIN,
    });
    const cacheLogPolicy = new logs.CfnResourcePolicy(this, "ValkeyLogDeliveryPolicy", {
      policyName: `${prefix}-valkey-logs`,
      policyDocument: this.toJsonString({
        Version: "2012-10-17", Statement: [{
          Effect: "Allow", Principal: { Service: "delivery.logs.amazonaws.com" },
          Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: cacheLogs.logGroupArn,
          Condition: { StringEquals: { "aws:SourceAccount": this.account }, ArnLike: { "aws:SourceArn": this.formatArn({ service: "logs", resource: "*" }) } },
        }],
      }),
    });
    const tenantKey = new kms.Key(this, "TenantCredentialKey", {
      alias: `alias/${prefix}-tenant-credentials`, description: "AdmitFlow tenant-bound provider credential encryption",
      enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN, pendingWindow: Duration.days(30),
    });
    const existingSecretKey = props.appSecretKmsKeyArn ? kms.Key.fromKeyArn(this, "ApplicationSecretKey", props.appSecretKmsKeyArn) : undefined;
    const appSecret = secretsmanager.Secret.fromSecretAttributes(this, "ApplicationSecret", {
      secretCompleteArn: appSecretArn.valueAsString, encryptionKey: existingSecretKey,
    });
    const queueSecret = new secretsmanager.Secret(this, "QueueAuth", {
      description: `${prefix} Valkey AUTH token`,
      generateSecretString: { secretStringTemplate: "{}", generateStringKey: "password", passwordLength: 48, excludePunctuation: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const cacheSubnetGroup = new elasticache.CfnSubnetGroup(this, "CacheSubnetGroup", {
      description: "Isolated AdmitFlow queue subnets", subnetIds: vpc.isolatedSubnets.map(subnet => subnet.subnetId),
    });
    const cacheParameters = new elasticache.CfnParameterGroup(this, "CacheParameters", {
      cacheParameterGroupFamily: "valkey7", description: "BullMQ requires noeviction on node-based Valkey",
      properties: { "maxmemory-policy": "noeviction" },
    });
    const replicas = props.highAvailability ? 1 : 0;
    const cache = new elasticache.CfnReplicationGroup(this, "Queue", {
      replicationGroupId: `${prefix}-queue`, replicationGroupDescription: "BullMQ; Neon remains the durable outbox",
      engine: "valkey", engineVersion: "7.2", cacheNodeType: cacheNodeType.valueAsString,
      cacheParameterGroupName: cacheParameters.ref, cacheSubnetGroupName: cacheSubnetGroup.ref,
      securityGroupIds: [cacheGroup.securityGroupId], port: 6379,
      numNodeGroups: 1, replicasPerNodeGroup: replicas,
      automaticFailoverEnabled: replicas > 0, multiAzEnabled: replicas > 0,
      atRestEncryptionEnabled: true, transitEncryptionEnabled: true, transitEncryptionMode: "required",
      // Only a CloudFormation dynamic reference is emitted, never the token value.
      authToken: queueSecret.secretValueFromJson("password").unsafeUnwrap(),
      snapshotRetentionLimit: 3, snapshotWindow: "18:00-19:00", autoMinorVersionUpgrade: true,
      logDeliveryConfigurations: [{ destinationType: "cloudwatch-logs", destinationDetails: { cloudWatchLogsDetails: { logGroup: cacheLogs.logGroupName } }, logFormat: "json", logType: "engine-log" }],
    });
    cache.addResourceDependency(cacheLogPolicy);
    cache.applyRemovalPolicy(RemovalPolicy.SNAPSHOT);

    const repository = new ecr.Repository(this, "Images", {
      repositoryName: prefix, imageScanOnPush: true, imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ tagStatus: ecr.TagStatus.UNTAGGED, maxImageAge: Duration.days(7) }],
    });
    const cluster = new ecs.Cluster(this, "Cluster", { vpc, clusterName: prefix, containerInsightsV2: ecs.ContainerInsights.DISABLED });
    const baseEnvironment = {
      NODE_ENV: "production", AWS_REGION: this.region, APP_BASE_URL: Fn.join("", ["https://", domain.valueAsString]),
      KMS_KEY_ID: tenantKey.keyArn, DATABASE_POOL_SIZE: "8", NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_META_APP_ID: metaAppId.valueAsString, NEXT_PUBLIC_META_CONFIG_ID: metaConfigId.valueAsString,
      META_APP_ID: metaAppId.valueAsString,
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: Fn.join("", ["https://", domain.valueAsString, "/callback"]),
      META_API_VERSION: metaApiVersion.valueAsString,
      KNOWLEDGE_VECTOR_ENABLED: knowledgeVector.valueAsString,
      REDIS_HOST: cache.attrPrimaryEndPointAddress, REDIS_PORT: cache.attrPrimaryEndPointPort, REDIS_TLS: "true",
    };
    const secretValues = (keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, ecs.Secret.fromSecretsManager(appSecret, key)]));
    const task = (name: string, memory: number) => new ecs.FargateTaskDefinition(this, `${name}Task`, {
      family: `${prefix}-${name.toLowerCase()}`, cpu: 256, memoryLimitMiB: memory,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    const webTask = task("Web", 1024), workerTask = task("Worker", 1024), migrationTask = task("Migration", 512);
    for (const definition of [webTask, workerTask]) tenantKey.grantEncryptDecrypt(definition.taskRole);
    // The digest is a CloudFormation token; force '@' rather than CDK's tag/digest string heuristic.
    for (const definition of [webTask, workerTask, migrationTask]) repository.grantPull(definition.obtainExecutionRole());
    const image = (digest: string) => ecs.ContainerImage.fromRegistry(repository.repositoryUriForDigest(digest));
    const webContainer = webTask.addContainer("web", {
      image: image(webDigest.valueAsString),
      environment: { ...baseEnvironment, ADMITFLOW_PROCESS_ROLE: "web", PORT: "3000", HOSTNAME: "0.0.0.0" },
      secrets: { ...secretValues([...SHARED_SECRET_KEYS, ...WEB_SECRET_KEYS]), REDIS_PASSWORD: ecs.Secret.fromSecretsManager(queueSecret, "password") },
      logging: ecs.LogDrivers.awsLogs({ logGroup: webLogs, streamPrefix: "web" }),
      linuxParameters: new ecs.LinuxParameters(this, "WebLinux", { initProcessEnabled: true }),
      stopTimeout: Duration.seconds(120),
      healthCheck: {
        command: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))\""],
        interval: Duration.seconds(30), timeout: Duration.seconds(5), retries: 3, startPeriod: Duration.seconds(60),
      },
      portMappings: [{ containerPort: 3000 }],
    });
    workerTask.addContainer("worker", {
      image: image(workerDigest.valueAsString),
      environment: { ...baseEnvironment, ADMITFLOW_PROCESS_ROLE: "worker" },
      secrets: { ...secretValues(SHARED_SECRET_KEYS), REDIS_PASSWORD: ecs.Secret.fromSecretsManager(queueSecret, "password") },
      logging: ecs.LogDrivers.awsLogs({ logGroup: workerLogs, streamPrefix: "worker" }),
      linuxParameters: new ecs.LinuxParameters(this, "WorkerLinux", { initProcessEnabled: true }), stopTimeout: Duration.seconds(120),
    });
    migrationTask.addContainer("migration", {
      image: image(workerDigest.valueAsString), command: ["node", "dist/migrate.mjs"],
      environment: { NODE_ENV: "production", AWS_REGION: this.region, ADMITFLOW_PROCESS_ROLE: "migration" },
      secrets: secretValues(["DATABASE_URL_UNPOOLED"]),
      logging: ecs.LogDrivers.awsLogs({ logGroup: migrationLogs, streamPrefix: "migration" }),
      linuxParameters: new ecs.LinuxParameters(this, "MigrationLinux", { initProcessEnabled: true }), stopTimeout: Duration.seconds(120),
    });
    const service = (name: string, definition: ecs.FargateTaskDefinition, securityGroup: ec2.SecurityGroup, desiredCount: number) => new ecs.FargateService(this, `${name}Service`, {
      cluster, serviceName: `${prefix}-${name.toLowerCase()}`, taskDefinition: definition, desiredCount,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, assignPublicIp: true, securityGroups: [securityGroup],
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      circuitBreaker: { rollback: true }, minHealthyPercent: 100, maxHealthyPercent: 200,
      healthCheckGracePeriod: name === "Web" ? Duration.seconds(120) : undefined,
      enableExecuteCommand: false,
    });
    const webService = service("Web", webTask, webGroup, webCount.valueAsNumber);
    const workerService = service("Worker", workerTask, workerGroup, workerCount.valueAsNumber);
    webService.node.addDependency(cache); workerService.node.addDependency(cache);

    const alb = new elbv2.ApplicationLoadBalancer(this, "LoadBalancer", {
      vpc, vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, internetFacing: true, securityGroup: albGroup,
      idleTimeout: Duration.seconds(120), dropInvalidHeaderFields: true,
    });
    alb.addListener("Http", {
      port: 80, defaultAction: elbv2.ListenerAction.redirect({ protocol: "HTTPS", port: "443", host: domain.valueAsString, permanent: true }),
    });
    const https = alb.addListener("Https", {
      port: 443, certificates: [acm.Certificate.fromCertificateArn(this, "Certificate", certificateArn.valueAsString)],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, { contentType: "text/plain", messageBody: "Not found" }),
    });
    const targetGroup = https.addTargets("Application", {
      priority: 1, conditions: [elbv2.ListenerCondition.hostHeaders([domain.valueAsString])],
      port: 3000, protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [webService.loadBalancerTarget({ containerName: webContainer.containerName, containerPort: 3000 })],
      // ECS replaces ALB-unhealthy tasks too. Keep liveness here; use /api/ready in release/dependency monitoring.
      healthCheck: { path: "/api/health", healthyHttpCodes: "200", interval: Duration.seconds(30), timeout: Duration.seconds(5), healthyThresholdCount: 2, unhealthyThresholdCount: 3 },
      deregistrationDelay: Duration.seconds(60),
    });
    const alarmTopic = props.alarmTopicArn ? sns.Topic.fromTopicArn(this, "AlarmTopic", props.alarmTopicArn) : undefined;
    const alarm = (name: string, metric: cloudwatch.IMetric, threshold: number, evaluationPeriods = 2) => {
      const result = new cloudwatch.Alarm(this, name, {
        alarmName: `${prefix}-${name}`, metric, threshold, evaluationPeriods,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      if (alarmTopic) result.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
      return result;
    };
    alarm("UnhealthyWeb", targetGroup.metrics.unhealthyHostCount({ statistic: "Maximum", period: Duration.minutes(1) }), 1);
    alarm("WebServerErrors", targetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { statistic: "Sum", period: Duration.minutes(5) }), 5);
    for (const [name, current] of [["Web", webService], ["Worker", workerService]] as const) {
      alarm(`${name}Cpu`, current.metricCpuUtilization({ period: Duration.minutes(5) }), 80, 3);
      alarm(`${name}Memory`, current.metricMemoryUtilization({ period: Duration.minutes(5) }), 80, 3);
    }
    const failures = new logs.MetricFilter(this, "WorkerFailures", {
      logGroup: workerLogs, filterPattern: logs.FilterPattern.anyTerm("Outbox dispatch failed", "Worker connection error", "Worker job failed", "Payment reconciliation failed", "Payment recovery dispatch failed"),
      metricNamespace: "AdmitFlow", metricName: `${prefix}-worker-failures`, metricValue: "1", defaultValue: 0,
    });
    alarm("WorkerErrors", failures.metric({ statistic: "Sum", period: Duration.minutes(5) }), 1, 1);
    for (let index = 1; index <= replicas + 1; index++) {
      const dimensionsMap = { CacheClusterId: Fn.join("", [cache.ref, `-${String(index).padStart(3, "0")}`]), CacheNodeId: "0001" };
      alarm(`QueueMemory${index}`, new cloudwatch.Metric({ namespace: "AWS/ElastiCache", metricName: "DatabaseMemoryUsagePercentage", dimensionsMap, statistic: "Maximum", period: Duration.minutes(5) }), 75);
      alarm(`QueueEvictions${index}`, new cloudwatch.Metric({ namespace: "AWS/ElastiCache", metricName: "Evictions", dimensionsMap, statistic: "Sum", period: Duration.minutes(5) }), 1, 1);
    }

    const output = (name: string, value: string, description?: string) => new CfnOutput(this, name, { value, description });
    output("ApplicationUrl", baseEnvironment.APP_BASE_URL);
    output("LoadBalancerDnsName", alb.loadBalancerDnsName, "Create the application's DNS record pointing here.");
    output("LoadBalancerHostedZoneId", alb.loadBalancerCanonicalHostedZoneId);
    output("ImageRepositoryUri", repository.repositoryUri);
    output("ClusterName", cluster.clusterName);
    output("WebServiceName", webService.serviceName); output("WorkerServiceName", workerService.serviceName);
    output("MigrationTaskDefinitionArn", migrationTask.taskDefinitionArn);
    output("MigrationSecurityGroupId", migrationGroup.securityGroupId);
    output("TaskSubnetIds", Fn.join(",", vpc.publicSubnets.map(subnet => subnet.subnetId)));
    output("TenantCredentialKeyArn", tenantKey.keyArn);
    output("QueuePrimaryEndpoint", cache.attrPrimaryEndPointAddress);
  }
}
