import { Aspects, CfnResource, Duration, RemovalPolicy, Stack, StackProps, Stage, StageProps, Tags } from 'aws-cdk-lib';
import {
  AccessLogField,
  AccessLogFormat, CfnAccount,
  EndpointType,
  InlineApiDefinition,
  LogGroupLogDestination,
  MethodLoggingLevel, SecurityPolicy,
  SpecRestApi
} from 'aws-cdk-lib/aws-apigateway';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { AttributeType, Billing, TableEncryptionV2, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { AccountRootPrincipal, CompositePrincipal, ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ARecord, PublicHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayDomain } from 'aws-cdk-lib/aws-route53-targets';
import {
  BlockPublicAccess,
  Bucket,
  BucketAccessControl,
  ObjectOwnership,
  StorageClass
} from 'aws-cdk-lib/aws-s3';
import { RegionInfo } from 'aws-cdk-lib/region-info';
import { AwsSolutionsChecks, NagReportFormat, NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';
import { join } from 'path';

export class FoxbatApiStack extends Stack {
  constructor(scope: Construct, props: Omit<StackProps, 'description' | 'stackName' | 'terminationProtection'>) {
    super(scope, 'FoxbatApiStack', {
      stackName: 'foxbat-api',
      description: 'Api gateway resource stack for Foxbat',
      terminationProtection: true,
      ...props
    });
    Aspects.of(this).add(new AwsSolutionsChecks({ verbose: true, reportFormats: [NagReportFormat.JSON] }));

    Tags.of(this).add('stelo:app', 'foxbat');
    Tags.of(this).add('foxbat:entity', 'api');
    const regionInfo = RegionInfo.get(this.region);

    const apiExecutionRole = new Role(this, 'ApiExecutionRole', {
      roleName: 'foxbat-api-execution-role',
      assumedBy: new ServicePrincipal(regionInfo.servicePrincipal('apigateway.amazonaws.com') ?? ''),
      description: 'Role to be assumed by API gateway for integration and authorizer flow.',
    });
    (apiExecutionRole.node.defaultChild as CfnResource).overrideLogicalId('ApiExecutionRole');

    const encryptionKey = new Key(this, 'EncryptionKey', {
      enabled: true,
      enableKeyRotation: true,
      description: 'Encryption key for foxbat resources.',
      removalPolicy: RemovalPolicy.DESTROY,
      alias: 'alias/foxbat'
    });

    encryptionKey.grantEncryptDecrypt(
      new CompositePrincipal(
        new AccountRootPrincipal(),
        ...[
          'logs.amazonaws.com',
          'apigateway.amazonaws.com',
          'dynamodb.amazonaws.com',
          's3.amazonaws.com'
        ].map(sp => new ServicePrincipal(regionInfo.servicePrincipal(sp) ?? '')),
      )
    );

    const proxyTable = new TableV2(this, 'ProxyTable', {
      partitionKey: { name: 'itemId', type: AttributeType.STRING },
      deletionProtection: true,
      tableName: 'foxbat-proxy',
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY,
      encryption: TableEncryptionV2.customerManagedKey(encryptionKey),
      billing: Billing.onDemand()
    });
    proxyTable.grantReadWriteData(apiExecutionRole);

    const logsBucket = new Bucket(this, 'LogsBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      encryptionKey,
      bucketName: 'access.logs.foxbat.stelo.dev',
      autoDeleteObjects: true,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      accessControl: BucketAccessControl.LOG_DELIVERY_WRITE,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      lifecycleRules: [
        { expiration: Duration.days(90), id: 'ttl', transitions: [{ transitionAfter: Duration.days(30), storageClass: StorageClass.INFREQUENT_ACCESS }] }
      ]
    });

    const proxyBucket = new Bucket(this, 'Bucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      encryptionKey,
      bucketName: 'proxy.api.foxbat.stelo.dev',
      autoDeleteObjects: true,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      lifecycleRules: [
        { expiration: Duration.days(60), id: 'ttl', transitions: [{ transitionAfter: Duration.days(30), storageClass: StorageClass.INFREQUENT_ACCESS }], noncurrentVersionExpiration: Duration.days(60), noncurrentVersionTransitions: [{ transitionAfter: Duration.days(30), storageClass: StorageClass.INFREQUENT_ACCESS }] }
      ],
      serverAccessLogsBucket: logsBucket,
      serverAccessLogsPrefix: 'foxbat/proxy/api/'
    });
    proxyBucket.grantReadWrite(apiExecutionRole);
    (proxyBucket.node.defaultChild as CfnResource).overrideLogicalId('Bucket');
    NagSuppressions.addResourceSuppressions(apiExecutionRole.node.findChild('DefaultPolicy'), [{ id: 'AwsSolutions-IAM5', reason: 'Policies are auto-added' }]);

    const accessLogs = new LogGroup(this, 'ApiAccessLogs', {
      encryptionKey,
      logGroupName: 'foxbat/api/access',
      removalPolicy: RemovalPolicy.DESTROY,
      retention: RetentionDays.TWO_MONTHS
    });

    const openApiDefinition = JSON.parse(
      readFileSync(
        join(
          __dirname,
          `../../../${process.env.CODEBUILD_BUILD_ARN ? 'model' : 'foxbat.model'}/build/smithyprojections/foxbat.model/source/openapi/Foxbat.openapi.json`
        ),
        {
          encoding: 'utf-8'
        }
      )
    );

    const stageName = 'v1';
    const api = new SpecRestApi(this, 'Api', {
      apiDefinition: new InlineApiDefinition(openApiDefinition),
      description: `Revision: ${Date.now()}`,
      restApiName: 'Foxbat',
      disableExecuteApiEndpoint: true,
      endpointTypes: [EndpointType.REGIONAL],
      deployOptions: {
        stageName,
        variables: { proxyTable: proxyTable.tableName },
        tracingEnabled: true,
        metricsEnabled: true,
        loggingLevel: MethodLoggingLevel.ERROR,
        throttlingRateLimit: 1000,
        throttlingBurstLimit: 500,
        accessLogDestination: new LogGroupLogDestination(accessLogs),
        accessLogFormat: AccessLogFormat.custom(
          JSON.stringify({
            requestId: AccessLogField.contextRequestId(),
            extendedRequestId: AccessLogField.contextExtendedRequestId(),
            requestTime: AccessLogField.contextRequestTime(),
            requestTimeEpoch: AccessLogField.contextRequestTimeEpoch(),
            xrayTraceId: AccessLogField.contextXrayTraceId(),
            identity: {
              sourceIp: AccessLogField.contextIdentitySourceIp(),
              userAgent: AccessLogField.contextIdentityUserAgent()
            },
            requestContext: {
              stage: AccessLogField.contextStage(),
              protocol: AccessLogField.contextProtocol(),
              httpMethod: AccessLogField.contextHttpMethod(),
              resourcePath: AccessLogField.contextResourcePath(),
              resourceId: AccessLogField.contextResourceId()
            },
            response: {
              statusCode: AccessLogField.contextStatus(),
              latency: AccessLogField.contextResponseLatency(),
              responseLength: AccessLogField.contextResponseLength()
            },
            authorize: {
              status: AccessLogField.contextAuthorizeStatus(),
              latency: AccessLogField.contextAuthorizeLatency(),
              error: AccessLogField.contextAuthorizeError()
            },
            integration: {
              status: AccessLogField.contextIntegrationStatus(),
              latency: AccessLogField.contextIntegrationLatency(),
              errorMessage: AccessLogField.contextIntegrationErrorMessage(),
              endpointRequestId: AccessLogField.contextAwsEndpointRequestId()
            },
            error: {
              message: AccessLogField.contextErrorMessage(),
              responseType: AccessLogField.contextErrorResponseType(),
              validationError: AccessLogField.contextErrorValidationErrorString()
            }
          })
        )
      }
    });

    NagSuppressions.addResourceSuppressions(api, [{ id: 'AwsSolutions-APIG2', reason: 'Request validation is enforced through smithy' }]);
    NagSuppressions.addResourceSuppressions(api.deploymentStage, [{ id: 'AwsSolutions-APIG3', reason: 'WAF is not required' }]);

    const apiCloudWatchRole = new Role(this, 'ApiCloudWatchRole', {
      roleName: 'foxbat-api-cloudwatch-role',
      assumedBy: new ServicePrincipal(regionInfo.servicePrincipal('apigateway.amazonaws.com') ?? ''),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs')]
    });
    NagSuppressions.addResourceSuppressions(apiCloudWatchRole, [{ id: 'AwsSolutions-IAM4', reason: 'Managed policies are fine' }]);

    const apiAccount = new CfnAccount(this, 'ApiAccount', {
      cloudWatchRoleArn: apiCloudWatchRole.roleArn
    });
    apiAccount.node.addDependency(api.node.findChild('Resource'));

    const executionLogs = new LogGroup(this, 'ApiExecutionLogs', {
      encryptionKey,
      logGroupName: `API-Gateway-Execution-Logs_${api.restApiId}/${stageName}`,
      removalPolicy: RemovalPolicy.DESTROY,
      retention: RetentionDays.TWO_MONTHS
    });
    [api.deploymentStage.node, api.latestDeployment!.node].forEach(node => {
      node.addDependency(executionLogs);
      node.addDependency(apiAccount);
    });

    const domainName = 'foxbat.stelo.dev';
    const hostedZone = new PublicHostedZone(this, 'DomainHostedZone', {
      zoneName: domainName,
      caaAmazon: true,
      comment: `Delegation for ${domainName} resources`
    });
    const certificate = new Certificate(this, 'DomainCertificate', {
      domainName,
      subjectAlternativeNames: [`*.${domainName}`],
      certificateName: 'foxbat-cert',
      validation: CertificateValidation.fromDns(hostedZone)
    });

    new ARecord(this, 'ApiAlias', {
      deleteExisting: true,
      target: RecordTarget.fromAlias(
        new ApiGatewayDomain(
          api.addDomainName('ApiDomain', {
            domainName: `api.${hostedZone.zoneName}`,
            certificate,
            endpointType: EndpointType.REGIONAL,
            securityPolicy: SecurityPolicy.TLS_1_2
          })
        )
      ),
      recordName: `api.${hostedZone.zoneName}`,
      zone: hostedZone,
      comment: 'Routes traffic to Api distribution'
    });
  }
}

export class FoxbatApiStage extends Stage {
  constructor(scope: Construct, props: Omit<StageProps, 'stageName'>) {
    super(scope, 'Api', { stageName: 'foxbat-api', ...props });
    new FoxbatApiStack(this, props);
  }
}
