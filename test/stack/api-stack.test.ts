import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Fact, FactName } from 'aws-cdk-lib/region-info';

import { FoxbatApiStack } from '../../src/stack/api-stack';

describe('FoxbatApiStack', () => {
  let stack: FoxbatApiStack;
  beforeAll(() => {
    const app = new App({
      context: {
        '@aws-cdk/aws-lambda:recognizeLayerVersion': true,
        '@aws-cdk/core:checkSecretUsage': true,
        '@aws-cdk/core:target-partitions': ['aws', 'aws-cn'],
        '@aws-cdk-containers/ecs-service-extensions:enableDefaultLogDriver': true,
        '@aws-cdk/aws-ec2:uniqueImdsv2TemplateName': true,
        '@aws-cdk/aws-ecs:arnFormatIncludesClusterName': true,
        '@aws-cdk/aws-iam:minimizePolicies': true,
        '@aws-cdk/core:validateSnapshotRemovalPolicy': true,
        '@aws-cdk/aws-codepipeline:crossAccountKeyAliasStackSafeResourceName': true,
        '@aws-cdk/aws-s3:createDefaultLoggingPolicy': true,
        '@aws-cdk/aws-sns-subscriptions:restrictSqsDescryption': true,
        '@aws-cdk/aws-apigateway:disableCloudWatchRole': true,
        '@aws-cdk/core:enablePartitionLiterals': true,
        '@aws-cdk/aws-events:eventsTargetQueueSameAccount': true,
        '@aws-cdk/aws-iam:standardizedServicePrincipals': true,
        '@aws-cdk/aws-ecs:disableExplicitDeploymentControllerForCircuitBreaker': true,
        '@aws-cdk/aws-iam:importedRoleStackSafeDefaultPolicyName': true,
        '@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy': true,
        '@aws-cdk/aws-route53-patters:useCertificate': true,
        '@aws-cdk/customresources:installLatestAwsSdkDefault': false,
        '@aws-cdk/aws-rds:databaseProxyUniqueResourceName': true,
        '@aws-cdk/aws-codedeploy:removeAlarmsFromDeploymentGroup': true,
        '@aws-cdk/aws-apigateway:authorizerChangeDeploymentLogicalId': true,
        '@aws-cdk/aws-ec2:launchTemplateDefaultUserData': true,
        '@aws-cdk/aws-secretsmanager:useAttachedSecretResourcePolicyForSecretTargetAttachments': true,
        '@aws-cdk/aws-redshift:columnId': true,
        '@aws-cdk/aws-stepfunctions-tasks:enableEmrServicePolicyV2': true,
        '@aws-cdk/aws-ec2:restrictDefaultSecurityGroup': true,
        '@aws-cdk/aws-apigateway:requestValidatorUniqueId': true,
        '@aws-cdk/aws-kms:aliasNameRef': true,
        '@aws-cdk/aws-autoscaling:generateLaunchTemplateInsteadOfLaunchConfig': true,
        '@aws-cdk/core:includePrefixInUniqueNameGeneration': true,
        '@aws-cdk/aws-efs:denyAnonymousAccess': true,
        '@aws-cdk/aws-opensearchservice:enableOpensearchMultiAzWithStandby': true,
        '@aws-cdk/aws-lambda-nodejs:useLatestRuntimeVersion': true,
        '@aws-cdk/aws-efs:mountTargetOrderInsensitiveLogicalId': true,
        '@aws-cdk/aws-rds:auroraClusterChangeScopeOfInstanceParameterGroupWithEachParameters': true,
        '@aws-cdk/aws-appsync:useArnForSourceApiAssociationIdentifier': true,
        '@aws-cdk/aws-rds:preventRenderingDeprecatedCredentials': true,
        '@aws-cdk/aws-codepipeline-actions:useNewDefaultBranchForCodeCommitSource': true,
        '@aws-cdk/aws-cloudwatch-actions:changeLambdaPermissionLogicalIdForLambdaAction': true,
        '@aws-cdk/aws-codepipeline:crossAccountKeysDefaultValueToFalse': true,
        '@aws-cdk/aws-codepipeline:defaultPipelineTypeToV2': true,
        '@aws-cdk/aws-kms:reduceCrossAccountRegionPolicyScope': true,
        '@aws-cdk/aws-eks:nodegroupNameAttribute': true,
        '@aws-cdk/aws-ec2:ebsDefaultGp3Volume': true
      }
    });
    ['apigateway.amazonaws.com', 'dynamodb.amazonaws.com', 'cloudwatch.amazonaws.com'].map(sp =>
      Fact.register({ region: 'us-west-2', name: FactName.servicePrincipal(sp), value: sp })
    );
    stack = new FoxbatApiStack(app, { env: { account: '0123456789', region: 'us-west-2' } });
  });

  class FoxbatApiTemplate {
    private template: Template;

    constructor(stack: FoxbatApiStack) {
      this.template = Template.fromStack(stack);
    }

    public hasIntegrationResources = () => {
      this.template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'foxbat-api-execution-role',
        AssumeRolePolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: 'apigateway.amazonaws.com' } })]) })
      });
      this.template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true, Enabled: true });
      this.template.hasResourceProperties('AWS::KMS::Alias', { AliasName: 'alias/foxbat' });
      this.template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        AttributeDefinitions: [{ AttributeName: 'itemId', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [{ AttributeName: 'itemId', KeyType: 'HASH' }],
        Replicas: [{ DeletionProtectionEnabled: true, Region: 'us-west-2', SSESpecification: { KMSMasterKeyId: Match.not(Match.absent()) } }],
        SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
        TableName: 'foxbat-proxy',
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true }
      });
      this.template.hasResourceProperties('AWS::S3::Bucket', {
        AccessControl: 'LogDeliveryWrite',
        BucketName: 'access.logs.foxbat.stelo.dev',
        OwnershipControls: { Rules: [{ ObjectOwnership: 'ObjectWriter' }] }
      });
      this.template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: 'proxy.api.foxbat.stelo.dev',
        LoggingConfiguration: { DestinationBucketName: { Ref: Match.stringLikeRegexp('LogsBucket.+') }, LogFilePrefix: 'foxbat/proxy/api/' }
      });
    };

    public hasApiResources = () => {
      this.template.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: 'foxbat/api/access', RetentionInDays: 60 });
      this.template.hasResource('AWS::ApiGateway::RestApi', {
        Properties: Match.objectLike({
          Body: Match.objectLike({ openapi: '3.1.0', info: { title: 'Foxbat', version: '2018-05-10' } }),
          DisableExecuteApiEndpoint: true,
          EndpointConfiguration: { Types: ['REGIONAL'] },
          Name: 'Foxbat'
        })
      });
      this.template.hasResource('AWS::ApiGateway::Deployment', {
        Properties: Match.objectLike({ Description: Match.stringLikeRegexp('Revision.+') }),
        DependsOn: ['ApiAccount', Match.stringLikeRegexp('ApiExecutionLogs.+')]
      });
      this.template.hasResource('AWS::ApiGateway::Stage', {
        Properties: Match.objectLike({
          MethodSettings: [
            {
              DataTraceEnabled: true,
              HttpMethod: '*',
              LoggingLevel: 'INFO',
              MetricsEnabled: true,
              ResourcePath: '/*',
              ThrottlingBurstLimit: 500,
              ThrottlingRateLimit: 1000
            }
          ],
          StageName: 'v1',
          TracingEnabled: true
        }),
        DependsOn: ['ApiAccount', Match.stringLikeRegexp('ApiExecutionLogs.+')]
      });
      this.template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'foxbat-api-cloudwatch-role',
        AssumeRolePolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: 'apigateway.amazonaws.com' } })]) })
      });
      this.template.hasResource('AWS::ApiGateway::Account', { DependsOn: [Match.stringLikeRegexp('Api.+')] });
      this.template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: { 'Fn::Join': ['', Match.arrayWith(['API-Gateway-Execution-Logs_', '/v1'])] },
        RetentionInDays: 60
      });
    };

    public hasDomainResources = () => {
      this.template.hasResourceProperties('AWS::ApiGateway::DomainName', {
        DomainName: 'api.foxbat.stelo.dev',
        EndpointConfiguration: { Types: ['REGIONAL'] },
        SecurityPolicy: 'TLS_1_2'
      });
      this.template.resourceCountIs('AWS::ApiGateway::BasePathMapping', 1);
      this.template.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'foxbat.stelo.dev.' });
      this.template.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: 'foxbat.stelo.dev.',
        ResourceRecords: ['0 issue "amazon.com"'],
        TTL: '1800',
        Type: 'CAA'
      });
      this.template.hasResourceProperties('AWS::CertificateManager::Certificate', {
        DomainName: 'foxbat.stelo.dev',
        SubjectAlternativeNames: ['*.foxbat.stelo.dev'],
        ValidationMethod: 'DNS'
      });
      this.template.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'api.foxbat.stelo.dev.', Type: 'A' });
      this.template.resourceCountIs('Custom::DeleteExistingRecordSet', 1);
    };
  }

  it('expect resources to be generated', () => {
    const template = new FoxbatApiTemplate(stack);

    template.hasIntegrationResources();
    template.hasApiResources();
    template.hasDomainResources();
  });
});
