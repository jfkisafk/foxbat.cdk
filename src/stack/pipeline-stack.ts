import { RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { ComputeType, LinuxArmBuildImage } from 'aws-cdk-lib/aws-codebuild';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CodePipeline, CodePipelineSource, ShellStep } from 'aws-cdk-lib/pipelines';
import { Fact, FactName } from 'aws-cdk-lib/region-info';
import { Construct } from 'constructs';

import { FoxbatApiStage } from './api-stack';

export class FoxbatPipelineStack extends Stack {
  constructor(scope: Construct, props: Omit<StackProps, 'description' | 'stackName' | 'terminationProtection'>) {
    super(scope, 'Pipeline', {
      stackName: 'foxbat-pipeline',
      description: 'Stack to manage Foxbat pipeline to deploy stacks',
      terminationProtection: true,
      ...props
    });

    Tags.of(this).add('stelo:app', 'foxbat');
    Tags.of(this).add('foxbat:entity', 'pipeline');
    const { region, account } = this;

    ['apigateway.amazonaws.com', 'dynamodb.amazonaws.com', 'cloudwatch.amazonaws.com'].map(sp =>
      Fact.register({ region, name: FactName.servicePrincipal(sp), value: sp })
    );
    const connectionArn = process.env.FOXBAT_GIT_CONN_ARN ?? 'connectionArn';
    const environmentVariables = {
      FOXBAT_GIT_CONN_ARN: { value: connectionArn },
      FOXBAT_ACCOUNT: { value: account }
    };

    const pipeline = new CodePipeline(this, 'CodePipeline', {
      pipelineName: 'foxbat',
      reuseCrossRegionSupportStacks: true,
      crossAccountKeys: true,
      selfMutation: true,
      enableKeyRotation: true,
      publishAssetsInParallel: false,
      useChangeSets: true,
      codeBuildDefaults: {
        buildEnvironment: { buildImage: LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0, computeType: ComputeType.SMALL, environmentVariables }
      },
      synthCodeBuildDefaults: {
        logging: {
          cloudWatch: {
            logGroup: new LogGroup(this, 'SynthCodeBuildLogGroup', {
              logGroupName: '/aws/codebuild/foxbat-synth',
              retention: RetentionDays.TWO_MONTHS,
              removalPolicy: RemovalPolicy.DESTROY
            })
          }
        }
      },
      selfMutationCodeBuildDefaults: {
        logging: {
          cloudWatch: {
            logGroup: new LogGroup(this, 'SelfMutateCodeBuildLogGroup', {
              logGroupName: '/aws/codebuild/foxbat-mutate',
              retention: RetentionDays.TWO_MONTHS,
              removalPolicy: RemovalPolicy.DESTROY
            })
          }
        }
      },
      assetPublishingCodeBuildDefaults: {
        logging: {
          cloudWatch: {
            logGroup: new LogGroup(this, 'AssetsCodeBuildLogGroup', {
              logGroupName: '/aws/codebuild/foxbat-assets',
              retention: RetentionDays.TWO_MONTHS,
              removalPolicy: RemovalPolicy.DESTROY
            })
          }
        }
      },
      synth: new ShellStep('Synth', {
        input: CodePipelineSource.connection('jfkisafk/foxbat.cdk', 'main', { connectionArn, codeBuildCloneOutput: true, actionName: 'foxbat.cdk' }),
        additionalInputs: {
          '../model': CodePipelineSource.connection('jfkisafk/foxbat.model', 'main', { connectionArn, codeBuildCloneOutput: true, actionName: 'foxbat.model' })
        },
        commands: ['cd ../model/', './gradlew build', 'cd $CODEBUILD_SRC_DIR/', 'npm ci', 'npm run build', 'npx cdk synth']
      })
    });

    const wave = pipeline.addWave('Global');
    wave.addStage(new FoxbatApiStage(this, props));
  }
}
