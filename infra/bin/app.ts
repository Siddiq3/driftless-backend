import { App } from 'aws-cdk-lib';
import { DriftlessStack } from '../lib/driftless-stack.js';

// Synth only in Phase 1. Deployment requires an explicit owner decision (Phase 0 instructions).
const app = new App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-south-1',
};
new DriftlessStack(app, 'Driftless-dev', { stage: 'dev', env });
new DriftlessStack(app, 'Driftless-prod', { stage: 'prod', env, terminationProtection: true });
