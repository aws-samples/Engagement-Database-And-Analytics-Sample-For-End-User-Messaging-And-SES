// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {CfnOutput, Stack, StackProps, Duration, RemovalPolicy, CustomResource} from "aws-cdk-lib";
import {Construct} from "constructs";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime} from "aws-cdk-lib/aws-lambda";
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as glue from "@aws-cdk/aws-glue-alpha";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as ses from "aws-cdk-lib/aws-ses";
import {CfnDeliveryStream} from 'aws-cdk-lib/aws-kinesisfirehose';
import * as S3Deployment from "aws-cdk-lib/aws-s3-deployment";
import { loadSSMParams } from '../lib/infrastructure/ssm-params-util';
import { NagSuppressions } from 'cdk-nag'
import path = require('path');

const configParams = require('../config.params.json');

export class BaseStack extends Stack {

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const ssmParams = loadSSMParams(this);

    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'This is the default Lambda Execution Policy which just grants writes to CloudWatch.'
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'This a CDK BucketDeployment which spins up a custom resource lambda...we have no control over the pythong version it deploys'
      },{
        id: 'AwsSolutions-IAM5',
        reason: 'This a CDK BucketDeployment which spins up a custom resource lambda...we have no control over the policy it builds.  This is only used to deploy static files and these templates are only used internally to generate sample test data.'
      }
    ])


    //log bucket
    const accessLogsBucket = new s3.Bucket(this, "accessLogsBucket", {
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      removalPolicy: RemovalPolicy.RETAIN, 
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL
    });

    NagSuppressions.addResourceSuppressions(accessLogsBucket, [
        {
          id: 'AwsSolutions-S1',
          reason: 'This is the Log Bucket.'
        },
    ])

    const templatesBucket = new s3.Bucket(this, "templatesBucket", {
      blockPublicAccess: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'templates',
    });

    const eventsBucket = new s3.Bucket(this, "eventsBucket", {
      blockPublicAccess: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'events',
    });

    //Deploy Templates
    const bucketDeployment = new S3Deployment.BucketDeployment(this, "Deployment", {
      sources: [S3Deployment.Source.asset('lib/templates/')],
      destinationBucket: templatesBucket,
    });

    NagSuppressions.addResourceSuppressions(bucketDeployment, [
      {
        id: 'AwsSolutions-L1',
        reason: 'This a CDK BucketDeployment which spins up a custom resource lambda...we have no control over the python version it deploys'
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'This a CDK BucketDeployment which spins up a custom resource lambda...we have no control over the policy it builds.  This is only used to deploy static templates.'
      }
    ])

    //Firehose Transformer Lambda
    const firehoseTransformerNodeLambda = new nodeLambda.NodejsFunction(this, 'firehoseTransformerNodeLambda', {
      description: "Created By CDK Solution. DO NOT EDIT",
      runtime: Runtime.NODEJS_22_X,
      entry: path.join(__dirname, 'lambdas/handlers/node/firehoseTransformer.mjs'),
      timeout: Duration.minutes(2),
      memorySize: 512,
      environment: { 
          "APPLICATION_VERSION": `v${this.node.tryGetContext('application_version')} (${new Date().toISOString()})`,
          "TEMPLATES_BUCKET": templatesBucket.bucketName,
          "EVENTS_BUCKET": eventsBucket.bucketName,
          "LOG_BUCKET": accessLogsBucket.bucketName,
          "ATHENA_DATABASE": `${configParams.CdkAppName.toLowerCase()}-glue-db`,
          "ATHENA_EVENTS_TABLE": `${configParams.CdkAppName.toLowerCase()}-events-table`,
          "WHATSAPP_STATUS_TEMPLATE_KEY": "whatsapp-status-template.vm",
          "WHATSAPP_MESSAGE_TEMPLATE_KEY": "whatsapp-message-template.vm",
          "MESSAGING_TEMPLATE_KEY": "messaging-template.vm",
          "SES_TEMPLATE_KEY": "ses-template.vm",
          "AWS_ACCOUNT_ID": `${this.account}`
      }
    });

    // Firehose Stream
    const deliveryStreamPolicy = new iam.PolicyDocument({
      statements:[
          new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                  "s3:AbortMultipartUpload",
                  "s3:GetBucketLocation",
                  "s3:GetObject",
                  "s3:ListBucket",
                  "s3:ListBucketMultipartUploads",
                  "s3:PutObject"
              ],
              resources: [
                eventsBucket.bucketArn,
                `${eventsBucket.bucketArn}/*`
              ],
          }),new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "glue:GetTable",
                "glue:GetTableVersion",
                "glue:GetTableVersions"
              ],
              resources: [
                `arn:aws:glue:${this.region}:${this.account}:database/${configParams.CdkAppName.toLowerCase()}-glue-db`,
                `arn:aws:glue:${this.region}:${this.account}:table/${configParams.CdkAppName.toLowerCase()}-glue-db/*`,
                `arn:aws:glue:${this.region}:${this.account}:catalog`
              ],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                "lambda:InvokeFunction",
                "lambda:GetFunctionConfiguration"
            ],
            resources: [
              firehoseTransformerNodeLambda.functionArn
            ],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                "logs:PutLogEvents"
            ],
            resources: [
              `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/kinesisfirehose/*:log-stream:*`
            ],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              "logs:CreateLogGroup",
              "logs:CreateLogStream",
              "logs:PutLogEvents"
            ],
            resources: [
              `arn:aws:logs:${this.region}:${this.account}:*`
            ],
          })
        ]
    });



    // Create an IAM role
    const firehoseRole = new iam.Role(this, 'FirehoseRole', {
        assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
        inlinePolicies: {
            'policy': deliveryStreamPolicy
        }
    });

    NagSuppressions.addResourceSuppressions(firehoseRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'This is the Firehose Role which is used to grant permissions to the Firehose Stream to write to the Events Bucket.  For more information see: https://docs.aws.amazon.com/firehose/latest/dev/controlling-access.html#using-iam-s3'
      }
    ])


    const firehoseStream = new CfnDeliveryStream(this, 'FirehoseStream', {
      deliveryStreamType: 'DirectPut',
      deliveryStreamEncryptionConfigurationInput: {
          keyType: "AWS_OWNED_CMK"
      },
      extendedS3DestinationConfiguration: {
          bucketArn: `${eventsBucket.bucketArn}`,
          roleArn: firehoseRole.roleArn,
          bufferingHints: {
              intervalInSeconds: 60,
              sizeInMBs: 64
          },  
          cloudWatchLoggingOptions: {
              enabled: true, 
              logGroupName: 'firehoseLogs', 
              logStreamName: 'firehoseStreamLogs' 
          },
          compressionFormat: 'UNCOMPRESSED',
          prefix: 'events/!{partitionKeyFromLambda:year}/!{partitionKeyFromLambda:month}/!{partitionKeyFromLambda:day}/!{partitionKeyFromLambda:hour}/',
          errorOutputPrefix: 'errors/',
          dataFormatConversionConfiguration: {
            enabled: true,
            inputFormatConfiguration: {
              deserializer: {
                openXJsonSerDe: {}
              }
            },
            outputFormatConfiguration: {
              serializer: {
                parquetSerDe: {}
              }
            },
            schemaConfiguration: {
              databaseName: `${configParams.CdkAppName.toLowerCase()}-glue-db`,
              region: this.region,
              roleArn: firehoseRole.roleArn,
              tableName: `${configParams.CdkAppName.toLowerCase()}-events-table`,
              versionId: 'LATEST',
              catalogId: this.account
            }
          },
          dynamicPartitioningConfiguration: {
            enabled: true,
            retryOptions: {
              durationInSeconds: 120
            }
          },
          processingConfiguration: {
            enabled: true,
            processors: [{
              type : 'Lambda',
              parameters : [ 
                {
                  parameterName : 'LambdaArn',
                  parameterValue : firehoseTransformerNodeLambda.functionArn
                },
                {
                  parameterName : 'RoleArn',
                  parameterValue : firehoseRole.roleArn
                }
              ]
            }]
          }
      },
  });

  const conversationFirehoseStream = new CfnDeliveryStream(this, 'ConversationFirehoseStream', {
    deliveryStreamType: 'DirectPut',
    deliveryStreamEncryptionConfigurationInput: {
        keyType: "AWS_OWNED_CMK"
    },
    extendedS3DestinationConfiguration: {
        bucketArn: `${eventsBucket.bucketArn}`,
        roleArn: firehoseRole.roleArn,
        bufferingHints: {
            intervalInSeconds: 60,
            sizeInMBs: 64
        },  
        cloudWatchLoggingOptions: {
            enabled: true, 
            logGroupName: 'conversationFirehoseLogs', 
            logStreamName: 'conversationFirehoseStreamLogs' 
        },
        compressionFormat: 'UNCOMPRESSED',
        prefix: 'conversations/!{partitionKeyFromQuery:YYYY}/!{partitionKeyFromQuery:MM}/!{partitionKeyFromQuery:DD}/!{partitionKeyFromQuery:HH}/',
        errorOutputPrefix: 'conversationErrors/',
        dynamicPartitioningConfiguration: {
          enabled: true,
          retryOptions: {
            durationInSeconds: 120
          }
        },
        processingConfiguration: {
          enabled: true,
          processors: [{
            type : 'MetadataExtraction',
            parameters : [ 
              {
                parameterName : 'MetadataExtractionQuery',
                parameterValue : '{YYYY : (.timestamp/1000) | strftime("%Y"), MM : (.timestamp/1000) | strftime("%m"), DD : (.timestamp/1000) | strftime("%d"), HH: (.timestamp/1000) | strftime("%H")}'
              },
              {
                parameterName : 'JsonParsingEngine',
                parameterValue : 'JQ-1.6'
              }
            ]
          },
          {
            type : 'AppendDelimiterToRecord',
            parameters : [ 
              {
                parameterName : 'Delimiter',
                parameterValue : '\\n'
              }
            ]
          }        
        ]
      }
    }
  });

    //Example policy for Lambda
    firehoseTransformerNodeLambda.role?.attachInlinePolicy(new iam.Policy(this, 'firehoseTransformerNodeLambdaPolicy', {
        statements: [
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [                
                  "s3:GetBucketLocation",
                  "s3:GetObject",
                  "s3:ListBucket",
                  "s3:ListBucketMultipartUploads",
                  "s3:ListMultipartUploadParts",
                  "s3:AbortMultipartUpload",
                  "s3:CreateBucket",
                  "s3:PutObject"
                ],
                resources: [
                  `${templatesBucket.bucketArn}/*`,
                  `${accessLogsBucket.bucketArn}/*`,
                  `${accessLogsBucket.bucketArn}`
                ]
            }), 
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [                
                  "cloudwatch:PutMetricData",
              ],
              resources: [`*`]
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [                
                  "firehose:PutRecord",
                  "firehose:PutRecordBatch",
                  "firehose:DescribeDeliveryStream",
              ],
              resources: [
                firehoseStream.attrArn,
                conversationFirehoseStream.attrArn]
          }),
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['athena:StartQueryExecution'],
                resources: ['arn:aws:athena:'+this.region+':'+this.account+':workgroup/primary']
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              "glue:GetDatabase",
              "glue:GetDatabases",
              "glue:GetTable",
              "glue:GetTables",
              "glue:GetPartition",
              "glue:GetPartitions",
              "glue:CreateTable",
              "glue:CreatePartition",
              "glue:BatchCreatePartition"

            ],
            resources: [
              `arn:aws:glue:${this.region}:${this.account}:catalog`,
              `arn:aws:glue:${this.region}:${this.account}:database/${configParams.CdkAppName.toLowerCase()}-glue-db`, //TODO can we scope this down to the database?
              `arn:aws:glue:${this.region}:${this.account}:table/${configParams.CdkAppName.toLowerCase()}-glue-db/*`
            ]
          }),
        ]
    }));

    NagSuppressions.addResourceSuppressionsByPath(this, '/EngagementDBBackend/firehoseTransformerNodeLambdaPolicy/Resource', [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'This is granting permission to insert CloudWatch Metrics and there is no way to scope this down to a specific resource.'
      }
    ])

    // CloudWatch Metrics and Alarms
    const jsonMetric = new cloudwatch.Metric({
      namespace: 'FirehoseTransformer',
      metricName: 'JsonParsingError'
    })

    const jsonAlarm = new cloudwatch.Alarm(this, 'TransformerLambdaJSONErrors', {
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 1,
      evaluationPeriods: 1,
      metric: jsonMetric,
    });

    const velocityMetric = new cloudwatch.Metric({
      namespace: 'FirehoseTransformer',
      metricName: 'VelocityTemplateError'
    })

    const velocityAlarm = new cloudwatch.Alarm(this, 'TransformerLambdaVelocityErrors', {
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 1,
      evaluationPeriods: 1,
      metric: velocityMetric,
    });

  //Glue
  const glueDatabase = new glue.Database(this, "GlueDatabase", {
    databaseName: `${configParams.CdkAppName.toLowerCase()}-glue-db`,
  });

  const glueTable = new glue.S3Table(this, "GlueTable", {
    database: glueDatabase,
    bucket: eventsBucket,
    compressed: true,
    s3Prefix: 'events/',
    tableName: `${configParams.CdkAppName.toLowerCase()}-events-table`,
    dataFormat: glue.DataFormat.PARQUET,
    partitionKeys: [
      {
        name: "ingest_timestamp",
        type: glue.Schema.TIMESTAMP
      }
    ],
    columns: [
      {
        name: "accountid",
        type: glue.Schema.STRING
      },
      {
          name: "organizationid",
          type: glue.Schema.STRING
      },
      {
          name: "sendingid",
          type: glue.Schema.STRING
      },
      {
          name: "sendingaddress",
          type: glue.Schema.STRING
      },  
      {
          name: "destinationaddress",
          type: glue.Schema.array(glue.Schema.STRING)
      },
      {
          name: "channel",
          type: glue.Schema.STRING
      },
      {
          name: "type",
          type: glue.Schema.STRING
      },
      {
          name: "status",
          type: glue.Schema.STRING
      },
      {
          name: "statuscode",
          type: glue.Schema.STRING
      },
      {
          name: "statusmessage",
          type: glue.Schema.STRING
      },
      {
          name: "rawstatus",
          type: glue.Schema.STRING
      },
      {
          name: "isocountrycode",
          type: glue.Schema.STRING
      },
      {
          name: "timestamp",
          type: glue.Schema.BIG_INT
      },
      {
          name: "messageid",
          type: glue.Schema.STRING
      },
      {
          name: "tags",
          type: glue.Schema.map(glue.Schema.STRING, glue.Schema.STRING)
      },
      {
        name: "channelData",
        type: glue.Schema.map(glue.Schema.STRING, glue.Schema.STRING)
      },
      {
          name: "rawevent",
          type: glue.Schema.STRING
      } 
    ],
  });

  const conversationGlueTable = new glue.S3Table(this, "ConversationGlueTable", {
    database: glueDatabase,
    bucket: eventsBucket,
    compressed: false,
    s3Prefix: 'conversations/',
    tableName: `${configParams.CdkAppName.toLowerCase()}-conversations-table`,
    dataFormat: glue.DataFormat.JSON,
    columns: [
      {
        name: "accountid",
        type: glue.Schema.STRING
      },
      {
          name: "organizationid",
          type: glue.Schema.STRING
      },
      {
          name: "messageid",
          type: glue.Schema.STRING
      }, 
      {
          name: "sendingaddress",
          type: glue.Schema.STRING
      }, 
      {
          name: "destinationaddress",
          type: glue.Schema.STRING
      },
      {
          name: "channel",
          type: glue.Schema.STRING
      },
      {
          name: "direction",
          type: glue.Schema.STRING
      },
      {
          name: "knowledgebaseid",
          type: glue.Schema.STRING
      },
      {
          name: "sessionid",
          type: glue.Schema.STRING
      },
      {
          name: "source",
          type: glue.Schema.STRING
      },
      {
          name: "message",
          type: glue.Schema.STRING
      },
      {
          name: "timestamp",
          type: glue.Schema.BIG_INT
      },
      {
          name: "tags",
          type: glue.Schema.map(glue.Schema.STRING, glue.Schema.STRING)
      }
    ],
  });

  const snsRole = new iam.Role(this, 'snsRole', {
    assumedBy: new iam.ServicePrincipal('sns.amazonaws.com')
  });

  snsRole.addToPolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "firehose:DescribeDeliveryStream",
        "firehose:ListDeliveryStreams",
        "firehose:ListTagsForDeliveryStream",
        "firehose:PutRecord",
        "firehose:PutRecordBatch"
      ],
      resources: [
        firehoseStream.attrArn
      ]
    })
  )

  if (ssmParams.whatsappEnabled) {
    const whatsappTopic = sns.Topic.fromTopicArn(this, 'whatsappTopic', ssmParams.eumWhatsappSNSTopicArn)
    let subscription = new sns.Subscription(this, 'whatsappSubscription', {
      endpoint: firehoseStream.attrArn,
      protocol: sns.SubscriptionProtocol.FIREHOSE,
      topic: whatsappTopic,
      subscriptionRoleArn: snsRole.roleArn
    })
  }

    // Sample SMS and SES Configuration Sets
    //SES
    const sesFirehosePutRole = new iam.Role(this, 'sesFirehosePutRole', {
      assumedBy: new iam.ServicePrincipal('ses.amazonaws.com'),
      inlinePolicies: {
        sesFirehosePutPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "firehose:DescribeDeliveryStream",
                "firehose:ListDeliveryStreams",
                "firehose:ListTagsForDeliveryStream",
                "firehose:PutRecord",
                "firehose:PutRecordBatch"
              ],
              resources: [
                firehoseStream.attrArn
              ]
            })
          ]
        })
      }
    });

    const sesConfigurationSet = new ses.ConfigurationSet(this, 'SESConfigurationSet', {});

    const sesEventDestination = new ses.CfnConfigurationSetEventDestination(this, 'SESConfigurationSetEventDestination', {
      configurationSetName: sesConfigurationSet.configurationSetName,

      eventDestination: {
        enabled: true,
        matchingEventTypes: [
          'SEND', 
          'REJECT', 
          'BOUNCE', 
          'COMPLAINT', 
          'DELIVERY', 
          'OPEN', 
          'CLICK', 
          'RENDERING_FAILURE', 
          'DELIVERY_DELAY',
          'SUBSCRIPTION'
        ],
        kinesisFirehoseDestination: {
          deliveryStreamArn: firehoseStream.attrArn,
          iamRoleArn: sesFirehosePutRole.roleArn,
        }
      },
    });

    //End User Messaging Configuration Set (need to use a custom resource as there is no CloudFormation resource for this)

    const eumFirehosePutRole = new iam.Role(this, 'eumFirehosePutRole', {
      assumedBy: new iam.ServicePrincipal('sms-voice.amazonaws.com'),
      inlinePolicies: {
        sesFirehosePutPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "firehose:DescribeDeliveryStream",
                "firehose:ListDeliveryStreams",
                "firehose:ListTagsForDeliveryStream",
                "firehose:PutRecord",
                "firehose:PutRecordBatch"
              ],
              resources: [
                firehoseStream.attrArn
              ]
            })
          ]
        })
      }
    });

    const configLambda = new nodeLambda.NodejsFunction(this, 'ConfigLambda', {
      runtime: Runtime.NODEJS_22_X,
      entry: path.join(__dirname, 'lambdas/handlers/node/customResource.mjs'),
      timeout: Duration.seconds(30),
      memorySize: 512,
      environment: {
        CdkAppName: configParams.CdkAppName
      },
      initialPolicy: 
      [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [                
            "sms-voice:UpdateEventDestination",
            "sms-voice:DeleteEventDestination",
            "sms-voice:CreateConfigurationSet",
            "sms-voice:CreateEventDestination",
            "sms-voice:DeleteConfigurationSet"
          ],
          resources: [`*`]
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [                
            "ses:UpdateConfigurationSetEventDestination",
            "ses:CreateConfigurationSet",
            "ses:CreateConfigurationSetEventDestination",
            "ses:DeleteConfigurationSet",
            "ses:DeleteConfigurationSetEventDestination"
          ],
          resources: [`*`]
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [                
            "iam:PassRole"
          ],
          resources: [
            eumFirehosePutRole.roleArn
          ]
        }),
      ]
    });

    NagSuppressions.addResourceSuppressionsByPath(this, '/EngagementDBBackend/ConfigLambda/ServiceRole/DefaultPolicy/Resource', [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'This is a Custom Resource Lambda that is used to create the End User Messaging Configuration Sets during the deployment of the CDK stack.  These API calls operate at the account level and are scoped down as much as possible according to: https://docs.aws.amazon.com/service-authorization/latest/reference/list_awsendusermessagingsmsandvoicev2.html#awsendusermessagingsmsandvoicev2-CreateConfigurationSet'
      }
    ])

    const createConfigurationSet = new CustomResource(this, `createEUMConfigurationSet`, {
      resourceType: 'Custom::CreateEUMConfigurationSet',
      serviceToken: configLambda.functionArn,
      properties: {
        EventFirehoseArn: firehoseStream.attrArn,
        EventFirehoseIamRoleArn: eumFirehosePutRole.roleArn,
        Random: Date.now().toString() //TODO This forces CR to run every deploy. 
      }
    });

    /**************************************************************************************************************
      * CDK Outputs *
    **************************************************************************************************************/

    new CfnOutput(this, "firehoseTransformerNodeLambdaName", {
      value: firehoseTransformerNodeLambda.functionName
    });

    new CfnOutput(this, 'EventFirehoseName', {
      value: firehoseStream.ref
    });
    new CfnOutput(this, 'EventFirehoseArn', {
      value: firehoseStream.attrArn
    });

    new CfnOutput(this, 'ConversationFirehoseName', {
      value: conversationFirehoseStream.ref
    });
    new CfnOutput(this, 'ConversationFirehoseArn', {
      value: conversationFirehoseStream.attrArn
    });

    new CfnOutput(this, "TransformerLambdaJSONErrorsAlarm", {
      value: jsonAlarm.alarmName
    });

    new CfnOutput(this, "TransformerLambdaVelocityErrorsAlarm", {
      value: velocityAlarm.alarmName
    });

    new CfnOutput(this, "SESConfigurationSetName", {
      value: sesConfigurationSet.configurationSetName
    });

    new CfnOutput(this, "EndUserMessagingConfigurationSetName", {
      value: `${configParams.CdkAppName.toLowerCase()}-eum-configuration-set`
    });

    new CfnOutput(this, "AccessLogsBucketName", {
      value: accessLogsBucket.bucketName
    });

  }
}
