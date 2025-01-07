import { Stack, StackProps, Duration, CustomResource } from 'aws-cdk-lib';
import { Construct } from "constructs";
import * as iam from 'aws-cdk-lib/aws-iam';
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import { loadSSMParams } from '../lib/infrastructure/ssm-params-util';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as S3Deployment from "aws-cdk-lib/aws-s3-deployment";
import {NagSuppressions} from 'cdk-nag'

const configParams = require('../config.params.json');

export class QuicksightStack extends Stack {
    constructor(scope: Construct, id: string, props: StackProps) {
        super(scope, id, props);

        NagSuppressions.addStackSuppressions(this, [{
          id: 'AwsSolutions-IAM4',
          reason: 'The stack creates a Custom Resource, and a Lambda handler to initiate Athena query to generate view table. The role in question is the AWS managed Lambda role'
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'This a CDK BucketDeployment which spins up a custom resource lambda...we have no control over the policy it builds.  This is only used to deploy a quicksight dashboard bundle'
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'This a CDK BucketDeployment which spins up a custom resource lambda...we have no control over the python version it deploys'
        }
      ])
    
        const ssmParams = loadSSMParams(this);
        const qsPrincipalARN = `arn:aws:quicksight:${this.region}:${this.account}:user/default/${ssmParams.quicksightAdminUsername}`;
        const athenaDatabase = 'engagementdb-glue-db';
        const athenaEventsTable = 'engagementdb-events-table';
        const athenaConversationsTable = 'engagementdb-conversations-table';

        const configLambda = new nodeLambda.NodejsFunction(this, 'ConfigLambda', {
            runtime: Runtime.NODEJS_22_X,
            entry: path.join(__dirname, 'lambdas/handlers/node/createViews.mjs'),
            timeout: Duration.seconds(720), //Quicksight bundle import job can take a while
            memorySize: 512,
            environment: { 
                ATHENA_DATABASE: athenaDatabase.toLowerCase() || "",
                ATHENA_EVENTS_TABLE: athenaEventsTable || "",
                ATHENA_CONVERSATIONS_TABLE: athenaConversationsTable || "",
                ATHENA_OUTPUT_URI: `s3://${ssmParams.athenaQueryStorageS3BucketName}/queryresults`,
                REGION: this.region,
                AWS_ACCOUNT_ID: this.account,
                QUICKSIGHT_PRINCIPAL_ARN: qsPrincipalARN
            },
            initialPolicy: 
            [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['athena:StartQueryExecution'],
                resources: ['arn:aws:athena:'+this.region+':'+this.account+':workgroup/primary']
              }),
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['s3:PutObject','s3:GetBucketLocation', 's3:ListBucket', 's3:GetObject'],
                resources: [
                    `arn:aws:s3:::${ssmParams.athenaQueryStorageS3BucketName}/*`,
                    `arn:aws:s3:::${ssmParams.athenaQueryStorageS3BucketName}`
                ]
              }),
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['glue:GetTable','glue:CreateTable', `glue:GetDatabases`],
                resources: [
                    'arn:aws:glue:'+this.region+':'+this.account+':catalog',
                    'arn:aws:glue:'+this.region+':'+this.account+':database/'+athenaDatabase.toLowerCase(),
                    'arn:aws:glue:'+this.region+':'+this.account+':table/'+athenaDatabase.toLowerCase()+'/*'
                ]
              }),
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                  "quicksight:StartAssetBundleImportJob",
                  "quicksight:DescribeAssetBundleImportJob",
                  "quicksight:ListAssetBundleImportJobs",
                  "quicksight:UpdateDataSourcePermissions",
                  "quicksight:DescribeDataSourcePermissions",
                  "quicksight:PassDataSource",
                  "quicksight:DescribeDataSource",
                  "quicksight:CreateDataSource",
                  "quicksight:UpdateDataSource",
                  "quicksight:UpdateDataSourcePermissions",
                  "quicksight:DescribeDataSourcePermissions",
                  "quicksight:DescribeDataSet",
                  "quicksight:CreateDataSet",
                  "quicksight:DeleteDataSet",
                  "quicksight:PassDataSet",
                  "quicksight:DescribeDataSetPermissions",
                  "quicksight:UpdateDataSetPermissions",
                  "quicksight:DescribeAnalysis",
                  "quicksight:CreateAnalysis",
                  "quicksight:UpdateAnalysis",
                  "quicksight:PassAnalysis",
                  "quicksight:DescribeAnalysisPermissions",
                  "quicksight:UpdateAnalysisPermissions",
                  "quicksight:DescribeDashboard",
                  "quicksight:CreateDashboard",
                  "quicksight:UpdateDashboard", 
                  "quicksight:PassDashboard",
                  "quicksight:DescribeDashboardPermissions",
                  "quicksight:UpdateDashboardPermissions",
                  "quicksight:CreateRefreshSchedule",
                  "quicksight:DescribeDataSetRefreshProperties",
                  "quicksight:UpdateDashboardPublishedVersion"
                ],
                resources: [
                    '*'
                ]
              })
            ]
          });

          NagSuppressions.addResourceSuppressionsByPath(this,`QuicksightStack/ConfigLambda/ServiceRole/DefaultPolicy/Resource`, [{
            id: 'AwsSolutions-IAM5',
            reason: 'The QuickSight deployment deploys to the account so will need the * access. This only runs once during stack deployment. It also creates lots of different objects (dashboards, datasets, analyses, etc.) which is why you see so many actions   See: https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonquicksight.html#amazonquicksight-StartAssetBundleImportJob for more information'
          }])
      
          const createViews = new CustomResource(this, `createViews`, {
            resourceType: 'Custom::CreateViews',
            serviceToken: configLambda.functionArn, 
            properties: {
              Random: Date.now().toString(), 
              OutputLocation: `s3://${ssmParams.athenaQueryStorageS3BucketName}/queryresults/`
            }
          });

          if (!ssmParams.athenaQueryStorageS3BucketName.includes('dummy-value-for-')) { //TODO: why is this here?
            const bucket = s3.Bucket.fromBucketName(this, "logBucket", `${ssmParams.athenaQueryStorageS3BucketName}`)
            const bucketDeployment = new S3Deployment.BucketDeployment(this, "Deployment", {
                sources: [S3Deployment.Source.asset('lib/quicksightdashboards/')],
                destinationBucket: bucket,
            });

            const deployQuicksightDashboardBundle = new CustomResource(this, `deployQuicksightDashboardBundle`, {
              resourceType: 'Custom::DeployQuicksightDashboardBundle',
              serviceToken: configLambda.functionArn, 
              properties: {
                Random: Date.now().toString(), 
                BundleLocation: `s3://${ssmParams.athenaQueryStorageS3BucketName}/quicksightdashboardbundles/messaging-dashboard.qs`
              }
            });
            deployQuicksightDashboardBundle.node.addDependency(bucketDeployment);
          }
    }

}