import { App } from 'aws-cdk-lib';

import { FoxbatPipelineStack } from '../src/stack/pipeline-stack';

const app = new App();
new FoxbatPipelineStack(app, { env: { account: process.env.FOXBAT_ACCOUNT, region: 'us-west-2' } });
app.synth();
