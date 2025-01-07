import { configure, sendSuccess, sendFailure, sendResponse, LOG_VERBOSE, SUCCESS } from 'cfn-custom-resource';

const { AthenaClient, StartQueryExecutionCommand } = require("@aws-sdk/client-athena");
const athenaClient = new AthenaClient({});

import { QuickSightClient, StartAssetBundleImportJobCommand, DescribeAssetBundleImportJobCommand } from "@aws-sdk/client-quicksight";
const quicksightClient = new QuickSightClient({});

import crypto from 'crypto';

//To create additional views, add them to this array.
const views = [
  `CREATE OR REPLACE VIEW "engagementdb-glue-db"."whatsapp_message_status" AS 
  SELECT
    messageid
  , sendingaddress sending_address
  , destinationaddress[1] destination_address
  , MAX((CASE WHEN (status = 'sent') THEN from_unixtime((timestamp / 1000)) ELSE null END)) message_timestamp
  , MAX((CASE WHEN (status = 'accepted') THEN from_unixtime((timestamp / 1000)) ELSE null END)) accepted_timestamp
  , MAX((CASE WHEN (status = 'sent') THEN from_unixtime((timestamp / 1000)) ELSE null END)) sent_timestamp
  , MAX((CASE WHEN (status = 'delivered') THEN from_unixtime((timestamp / 1000)) ELSE null END)) delivered_timestamp
  , MAX((CASE WHEN (status = 'read') THEN from_unixtime((timestamp / 1000)) ELSE null END)) read_timestamp
  , MAX((CASE WHEN (status = 'failed') THEN from_unixtime((timestamp / 1000)) ELSE null END)) failed_timestamp
  , COALESCE(MAX(json_extract_scalar(rawevent, '$.changes[0].value.statuses[0].biz_opaque_callback_data')), null) biz_opaque
  , COALESCE(MAX(statuscode), null) status_code
  , COALESCE(MAX(json_extract_scalar(rawevent, '$.changes[0].value.statuses[0].conversation.id')), null) conversation_id
  , COALESCE(MAX(json_extract_scalar(rawevent, '$.changes[0].value.statuses[0].conversation.origin.type')), null) origin_type
  FROM
    "engagementdb-glue-db"."engagementdb-events-table"
  WHERE ((channel = 'whatsapp') AND (type = 'messageStatus') AND (messageid IS NOT NULL))
  GROUP BY messageid, sendingaddress, destinationaddress
  `,
  `CREATE OR REPLACE VIEW "engagementdb-glue-db"."whatsapp_conversation_view" AS 
  SELECT
    json_extract_scalar(rawevent, '$.changes[0].value.statuses[0].conversation.id') conversation_id
  , COUNT(DISTINCT messageid) total_messages
  , MIN(from_unixtime((timestamp / 1000))) message_timestamp
  , MIN(from_unixtime((timestamp / 1000))) first_message_timestamp
  , MAX(from_unixtime((timestamp / 1000))) last_message_timestamp
  , CAST((to_unixtime(MAX(from_unixtime((timestamp / 1000)))) - to_unixtime(MIN(from_unixtime((timestamp / 1000))))) AS INTEGER) conversation_duration_seconds
  , CAST(((to_unixtime(MAX(from_unixtime((timestamp / 1000)))) - to_unixtime(MIN(from_unixtime((timestamp / 1000))))) / 60) AS DOUBLE) conversation_duration_minutes
  , sendingaddress sending_address
  , destinationaddress[1] destination_address
  , COALESCE(MAX(json_extract_scalar(rawevent, '$.changes[0].value.statuses[0].biz_opaque_callback_data')), null) biz_opaque
  , COALESCE(MAX(statuscode), null) status_code
  , COALESCE(MAX(json_extract_scalar(rawevent, '$.changes[0].value.statuses[0].conversation.origin.type')), null) origin_type
  FROM
    "engagementdb-glue-db"."engagementdb-events-table"
  WHERE ((channel = 'whatsapp') AND (type = 'messageStatus') AND (status <> 'accepted') AND (json_extract_scalar(rawevent, '$.changes[0].value.statuses[0].conversation.id') IS NOT NULL) AND (messageid IS NOT NULL))
  GROUP BY json_extract_scalar(rawevent, '$.changes[0].value.statuses[0].conversation.id'), sendingaddress, destinationaddress[1]
  `,
  `CREATE OR REPLACE VIEW "engagementdb-glue-db"."whatsapp_message_conversion_rates" AS 
  SELECT
    sending_address
  , DATE(COALESCE(sent_timestamp, accepted_timestamp, delivered_timestamp, read_timestamp)) message_timestamp
  , DATE(COALESCE(sent_timestamp, accepted_timestamp, delivered_timestamp, read_timestamp)) message_date
  , COUNT(*) total_messages
  , COUNT(accepted_timestamp) accepted_count
  , COUNT(sent_timestamp) sent_count
  , COUNT(delivered_timestamp) delivered_count
  , COUNT(read_timestamp) read_count
  , COUNT(failed_timestamp) failed_count
  , ROUND(CAST((CASE WHEN (COUNT(sent_timestamp) > 0) THEN (CAST(COUNT(accepted_timestamp) AS DOUBLE) / COUNT(sent_timestamp)) ELSE 0 END) AS DOUBLE), 3) accepted_to_sent_rate
  , ROUND(CAST((CASE WHEN (COUNT(sent_timestamp) > 0) THEN (CAST(COUNT(delivered_timestamp) AS DOUBLE) / COUNT(sent_timestamp)) ELSE 0 END) AS DOUBLE), 3) sent_to_delivered_rate
  , ROUND(CAST((CASE WHEN (COUNT(delivered_timestamp) > 0) THEN (CAST(COUNT(read_timestamp) AS DOUBLE) / COUNT(delivered_timestamp)) ELSE 0 END) AS DOUBLE), 3) delivered_to_read_rate
  , ROUND(CAST((CASE WHEN (COUNT(sent_timestamp) > 0) THEN (CAST(COUNT(failed_timestamp) AS DOUBLE) / COUNT(sent_timestamp)) ELSE 0 END) AS DOUBLE), 3) sent_to_failed_rate
  FROM
    "engagementdb-glue-db"."whatsapp_message_status"  
  GROUP BY sending_address, DATE(COALESCE(sent_timestamp, accepted_timestamp, delivered_timestamp, read_timestamp))
  `,
  `
  CREATE OR REPLACE VIEW "sms_message_status" AS 
  WITH
    latest_event AS (
     SELECT
       messageid
     , MAX(timestamp) latest_timestamp
     FROM
       "engagementdb-glue-db"."engagementdb-events-table"
     WHERE (channel = 'text')
     GROUP BY messageid
  ) 
  SELECT
    e.messageid
  , MAX(json_extract_scalar(e.rawevent, '$.isoCountryCode')) iso_country_code
  , MAX(e.type) type
  , MAX(CAST(json_extract_scalar(e.rawevent, '$.totalCarrierFee') AS DOUBLE)) carrier_fee
  , MAX(CAST(json_extract_scalar(e.rawevent, '$.totalMessagePrice') AS DOUBLE)) message_price
  , MAX(CAST(json_extract_scalar(e.rawevent, '$.totalMessageParts') AS INTEGER)) message_parts
  , ROUND((MAX(CAST(json_extract_scalar(e.rawevent, '$.totalCarrierFee') AS DOUBLE)) + MAX(CAST(json_extract_scalar(e.rawevent, '$.totalMessagePrice') AS DOUBLE))), 5) total_price
  , e.destinationaddress[1] destination_address
  , e.sendingaddress sending_address
  , MAX(json_extract_scalar(e.rawevent, '$.carrierName')) carrier_name
  , MAX((CASE WHEN (json_extract_scalar(e.rawevent, '$.eventType') = 'TEXT_DELIVERED') THEN FROM_UNIXTIME((e.timestamp / 1000)) END)) text_delivered
  , MAX((CASE WHEN (json_extract_scalar(e.rawevent, '$.eventType') = 'TEXT_SUCCESSFUL') THEN FROM_UNIXTIME((e.timestamp / 1000)) END)) text_successful
  , MAX((CASE WHEN (json_extract_scalar(e.rawevent, '$.eventType') = 'TEXT_QUEUED') THEN FROM_UNIXTIME((e.timestamp / 1000)) END)) text_queued
  , MAX((CASE WHEN (json_extract_scalar(e.rawevent, '$.eventType') = 'TEXT_PENDING') THEN FROM_UNIXTIME((e.timestamp / 1000)) END)) text_pending
  , MAX((CASE WHEN (json_extract_scalar(e.rawevent, '$.eventType') = 'TEXT_BLOCKED') THEN FROM_UNIXTIME((e.timestamp / 1000)) END)) text_blocked
  , MAX((CASE WHEN (json_extract_scalar(e.rawevent, '$.eventType') = 'TEXT_TTL_EXPIRED') THEN FROM_UNIXTIME((e.timestamp / 1000)) END)) text_ttl_expired
  , MAX((CASE WHEN (json_extract_scalar(e.rawevent, '$.eventType') = 'TEXT_CARRIER_UNREACHABLE') THEN FROM_UNIXTIME((e.timestamp / 1000)) END)) text_carrier_unreachable
  , MAX((CASE WHEN (json_extract_scalar(e.rawevent, '$.eventType') = 'TEXT_INVALID') THEN FROM_UNIXTIME((e.timestamp / 1000)) END)) text_invalid
  , MAX((CASE WHEN (json_extract_scalar(e.rawevent, '$.eventType') = 'TEXT_INVALID_MESSAGE') THEN FROM_UNIXTIME((e.timestamp / 1000)) END)) text_invalid_message
  , MAX((CASE WHEN (json_extract_scalar(e.rawevent, '$.eventType') = 'TEXT_CARRIER_BLOCKED') THEN FROM_UNIXTIME((e.timestamp / 1000)) END)) text_carrier_blocked
  , MAX((CASE WHEN (json_extract_scalar(e.rawevent, '$.eventType') = 'TEXT_UNREACHABLE') THEN FROM_UNIXTIME((e.timestamp / 1000)) END)) text_unreachable
  , MAX((CASE WHEN (json_extract_scalar(e.rawevent, '$.eventType') = 'TEXT_SPAM') THEN FROM_UNIXTIME((e.timestamp / 1000)) END)) text_spam
  , MAX((CASE WHEN (json_extract_scalar(e.rawevent, '$.eventType') = 'TEXT_UNKNOWN') THEN FROM_UNIXTIME((e.timestamp / 1000)) END)) text_unknown
  , e.tags context
  , FROM_UNIXTIME((MIN(e.timestamp) / 1000)) message_timestamp
  , MAX((CASE WHEN (e.timestamp = le.latest_timestamp) THEN json_extract_scalar(e.rawevent, '$.messageStatus') END)) last_status
  , MAX((CASE WHEN (e.timestamp = le.latest_timestamp) THEN json_extract_scalar(e.rawevent, '$.messageStatusDescription') END)) status_description
  , MAX((CASE WHEN (e.timestamp = le.latest_timestamp) THEN (CASE WHEN (json_extract_scalar(e.rawevent, '$.eventType') IN ('TEXT_DELIVERED', 'TEXT_SUCCESSFUL')) THEN 'success' WHEN (json_extract_scalar(e.rawevent, '$.eventType') IN ('TEXT_QUEUED', 'TEXT_PENDING')) THEN 'pending' WHEN (json_extract_scalar(e.rawevent, '$.eventType') IN ('TEXT_BLOCKED', 'TEXT_TTL_EXPIRED', 'TEXT_CARRIER_UNREACHABLE', 'TEXT_INVALID', 'TEXT_INVALID_MESSAGE', 'TEXT_CARRIER_BLOCKED', 'TEXT_UNREACHABLE', 'TEXT_SPAM', 'TEXT_UNKNOWN')) THEN 'failed' ELSE 'unknown' END) END)) message_status
  FROM
    ("engagementdb-glue-db"."engagementdb-events-table" e
  INNER JOIN latest_event le ON (e.messageid = le.messageid))
  WHERE (e.channel = 'text')
  GROUP BY e.messageid, e.destinationaddress, e.sendingaddress, e.tags
  `,
  `
  CREATE OR REPLACE VIEW "sms_conversion_rates_view" AS 
  SELECT
    DATE(message_timestamp) message_date
  , iso_country_code
  , type
  , sending_address
  , COUNT(*) total_messages
  , COUNT((CASE WHEN (message_status = 'success') THEN 1 END)) successful_messages
  , ROUND((CAST(COUNT((CASE WHEN (message_status = 'success') THEN 1 END)) AS DOUBLE) / COUNT(*)), 3) success_rate_percentage
  , ROUND(SUM(message_price), 4) total_message_price
  , ROUND(SUM(carrier_fee), 4) total_carrier_fee
  , ROUND(SUM(total_price), 4) total_cost
  , ROUND(AVG(message_parts), 2) avg_message_parts
  FROM
    sms_message_status
  GROUP BY DATE(message_timestamp), iso_country_code, type, sending_address
  ORDER BY message_date ASC, iso_country_code ASC, type ASC, sending_address ASC
  `,
  `
  CREATE OR REPLACE VIEW "email_message_status" AS 
  SELECT
    messageid
  , sendingaddress
  , destinationaddress[1] destinationaddress
  , FROM_UNIXTIME((MIN(timestamp) / 1000)) message_timestamp
  , MAX((CASE WHEN (type = 'Send') THEN from_unixtime((timestamp / 1000)) ELSE null END)) send_timestamp
  , MAX((CASE WHEN (type = 'Bounce') THEN from_unixtime((timestamp / 1000)) ELSE null END)) bounce_timestamp
  , MAX((CASE WHEN (type = 'Complaint') THEN from_unixtime((timestamp / 1000)) ELSE null END)) complaint_timestamp
  , MAX((CASE WHEN (type = 'Delivery') THEN from_unixtime((timestamp / 1000)) ELSE null END)) delivery_timestamp
  , MAX((CASE WHEN (type = 'Reject') THEN from_unixtime((timestamp / 1000)) ELSE null END)) reject_timestamp
  , MAX((CASE WHEN (type = 'Open') THEN from_unixtime((timestamp / 1000)) ELSE null END)) last_open_timestamp
  , SUM((CASE WHEN (type = 'Open') THEN 1 ELSE 0 END)) open_count
  , MAX((CASE WHEN (type = 'Click') THEN from_unixtime((timestamp / 1000)) ELSE null END)) last_click_timestamp
  , SUM((CASE WHEN (type = 'Click') THEN 1 ELSE 0 END)) click_count
  , COALESCE(MAX((CASE WHEN (type = 'Click') THEN json_extract_scalar(rawevent, '$.click.link') END)), null) last_clicked_link
  , MAX((CASE WHEN (type = 'Rendering Failure') THEN from_unixtime((timestamp / 1000)) ELSE null END)) rendering_failure_timestamp
  , MAX((CASE WHEN (type = 'DeliveryDelay') THEN from_unixtime((timestamp / 1000)) ELSE null END)) delivery_delay_timestamp
  , MAX((CASE WHEN (type = 'Subscription') THEN from_unixtime((timestamp / 1000)) ELSE null END)) subscription_timestamp
  , MAX(json_extract_scalar(rawevent, '$.bounce.bounceType')) bouncetype
  , MAX(json_extract_scalar(rawevent, '$.bounce.bounceSubType')) bounceSubType
  , MAX(json_extract_scalar(rawevent, '$.complaint.complaintFeedbackType')) complaintFeedbackType
  , (CASE WHEN (MAX((CASE WHEN (type = 'Bounce') THEN timestamp ELSE null END)) IS NOT NULL) THEN 'Bounce' WHEN (MAX((CASE WHEN (type = 'Complaint') THEN timestamp ELSE null END)) IS NOT NULL) THEN 'Complaint' WHEN (MAX((CASE WHEN (type = 'Delivery') THEN timestamp ELSE null END)) IS NOT NULL) THEN 'Delivery' WHEN (MAX((CASE WHEN (type = 'Reject') THEN timestamp ELSE null END)) IS NOT NULL) THEN 'Reject' WHEN (MAX((CASE WHEN (type = 'Send') THEN timestamp ELSE null END)) IS NOT NULL) THEN 'Send' ELSE null END) last_status
  , (CASE WHEN (REGEXP_EXTRACT(destinationaddress[1], '@([a-zA-Z0-9.-]+)$') = 'gmail.com') THEN 'gmail' WHEN (REGEXP_EXTRACT(destinationaddress[1], '@([a-zA-Z0-9.-]+)$') = 'yahoo.com') THEN 'yahoo' ELSE REGEXP_EXTRACT(destinationaddress[1], '@([a-zA-Z0-9.-]+)$', 1) END) isp
  , (CASE WHEN (REGEXP_EXTRACT(sendingaddress, '@([a-zA-Z0-9.-]+)$', 1) IS NOT NULL) THEN REGEXP_EXTRACT(sendingaddress, '@([a-zA-Z0-9.-]+)$', 1) ELSE 'none' END) sending_domain
  , CAST(MAX(tags['ses:source-tls-version']) AS VARCHAR) source_tls_version
  , CAST(MAX(channeldata['subject']) AS VARCHAR) subject
  , CAST(MAX(tags['ses:source-ip']) AS VARCHAR) source_ip
  , COALESCE(CAST(MAX(tags['ses:configuration-set']) AS VARCHAR), 'none') configuration_set
  , COALESCE(CAST(MAX(tags['campaign']) AS VARCHAR), 'none') campaign
  FROM
    "engagementdb-glue-db"."engagementdb-events-table"
  WHERE (channel = 'email')
  GROUP BY messageid, sendingaddress, destinationaddress[1]
  `,
  `
  CREATE OR REPLACE VIEW "email_conversion_rates_view" AS 
  SELECT
    DATE(message_timestamp) message_date
  , isp
  , sending_domain
  , campaign
  , configuration_set
  , MIN(send_timestamp) message_timestamp
  , COUNT(*) total_emails_sent
  , SUM((CASE WHEN (delivery_timestamp IS NOT NULL) THEN 1 ELSE 0 END)) total_deliveries
  , SUM((CASE WHEN (bounce_timestamp IS NOT NULL) THEN 1 ELSE 0 END)) total_bounces
  , SUM((CASE WHEN (complaint_timestamp IS NOT NULL) THEN 1 ELSE 0 END)) total_complaints
  , COUNT(DISTINCT (CASE WHEN (open_count > 0) THEN messageid ELSE null END)) total_emails_opened
  , COUNT(DISTINCT (CASE WHEN (click_count > 0) THEN messageid ELSE null END)) total_emails_clicked
  , ROUND((CASE WHEN (COUNT(*) > 0) THEN ((SUM((CASE WHEN (delivery_timestamp IS NOT NULL) THEN 1 ELSE 0 END)) * 1E0) / COUNT(*)) ELSE 0 END), 2) delivery_rate
  , ROUND((CASE WHEN (SUM((CASE WHEN (delivery_timestamp IS NOT NULL) THEN 1 ELSE 0 END)) > 0) THEN ((COUNT(DISTINCT (CASE WHEN (open_count > 0) THEN messageid ELSE null END)) * 1E0) / SUM((CASE WHEN (delivery_timestamp IS NOT NULL) THEN 1 ELSE 0 END))) ELSE 0 END), 2) open_rate
  , ROUND((CASE WHEN (COUNT(DISTINCT (CASE WHEN (open_count > 0) THEN messageid ELSE null END)) > 0) THEN ((COUNT(DISTINCT (CASE WHEN (click_count > 0) THEN messageid ELSE null END)) * 1E0) / COUNT(DISTINCT (CASE WHEN (open_count > 0) THEN messageid ELSE null END))) ELSE 0 END), 2) open_to_click_rate
  , ROUND((CASE WHEN (SUM((CASE WHEN (delivery_timestamp IS NOT NULL) THEN 1 ELSE 0 END)) > 0) THEN ((SUM((CASE WHEN (bounce_timestamp IS NOT NULL) THEN 1 ELSE 0 END)) * 1E0) / SUM((CASE WHEN (delivery_timestamp IS NOT NULL) THEN 1 ELSE 0 END))) ELSE 0 END), 2) bounce_rate
  , ROUND((CASE WHEN (SUM((CASE WHEN (delivery_timestamp IS NOT NULL) THEN 1 ELSE 0 END)) > 0) THEN ((SUM((CASE WHEN (complaint_timestamp IS NOT NULL) THEN 1 ELSE 0 END)) * 1E0) / SUM((CASE WHEN (delivery_timestamp IS NOT NULL) THEN 1 ELSE 0 END))) ELSE 0 END), 2) complaint_rate
  FROM
    "engagementdb-glue-db"."email_message_status"
  GROUP BY DATE(message_timestamp), isp, sending_domain, campaign, configuration_set
  `
]
const overrideParameters = {
  "Dashboards":[
    {
      "DashboardId": "0de397ec-60ed-4462-b675-f512ff9f590d",
      "Name": "Messaging Dashboard"
    }
  ]
}
const overridePermissions = {
  "DataSources": [
      {
          "DataSourceIds": ["*"],
          "Permissions": {
              "Principals": [process.env.QUICKSIGHT_PRINCIPAL_ARN],
              "Actions": [
                  "quicksight:UpdateDataSourcePermissions",
                  "quicksight:DescribeDataSourcePermissions",
                  "quicksight:PassDataSource",
                  "quicksight:DescribeDataSource",
                  "quicksight:DeleteDataSource",
                  "quicksight:UpdateDataSource"
              ]
          }
      }
  ],
  "DataSets": [
      {
          "DataSetIds": ["*"],
          "Permissions": {
              "Principals": [process.env.QUICKSIGHT_PRINCIPAL_ARN],
              "Actions": [
                  "quicksight:DeleteDataSet",
                  "quicksight:UpdateDataSetPermissions",
                  "quicksight:PutDataSetRefreshProperties",
                  "quicksight:CreateRefreshSchedule",
                  "quicksight:CancelIngestion",
                  "quicksight:PassDataSet",
                  "quicksight:ListRefreshSchedules",
                  "quicksight:UpdateRefreshSchedule",
                  "quicksight:DeleteRefreshSchedule",
                  "quicksight:DescribeDataSetRefreshProperties",
                  "quicksight:DescribeDataSet",
                  "quicksight:CreateIngestion",
                  "quicksight:DescribeRefreshSchedule",
                  "quicksight:ListIngestions",
                  "quicksight:DescribeDataSetPermissions",
                  "quicksight:UpdateDataSet",
                  "quicksight:DeleteDataSetRefreshProperties",
                  "quicksight:DescribeIngestion"
              ]
          }
      }
  ],
  "Themes": [
      {
          "ThemeIds": ["*"],
          "Permissions": {
              "Principals": [process.env.QUICKSIGHT_PRINCIPAL_ARN],
              "Actions": [
                  "quicksight:ListThemeVersions",
                  "quicksight:UpdateThemeAlias",
                  "quicksight:DescribeThemeAlias",
                  "quicksight:UpdateThemePermissions",
                  "quicksight:DeleteThemeAlias",
                  "quicksight:DeleteTheme",
                  "quicksight:ListThemeAliases",
                  "quicksight:DescribeTheme",
                  "quicksight:CreateThemeAlias",
                  "quicksight:UpdateTheme",
                  "quicksight:DescribeThemePermissions"
              ]
          }
      }
  ],
  "Analyses": [
      {
          "AnalysisIds": ["*"],
          "Permissions": {
              "Principals": [process.env.QUICKSIGHT_PRINCIPAL_ARN],
              "Actions": [
                  "quicksight:RestoreAnalysis",
                  "quicksight:UpdateAnalysisPermissions",
                  "quicksight:DeleteAnalysis",
                  "quicksight:DescribeAnalysisPermissions",
                  "quicksight:QueryAnalysis",
                  "quicksight:DescribeAnalysis",
                  "quicksight:UpdateAnalysis"
              ]
          }
      }
  ],
  "Dashboards": [
      {
          "DashboardIds": ["*"],
          "Permissions": {
              "Principals": [process.env.QUICKSIGHT_PRINCIPAL_ARN],
              "Actions": [
                  "quicksight:DescribeDashboard",
                  "quicksight:ListDashboardVersions",
                  "quicksight:UpdateDashboardPermissions",
                  "quicksight:QueryDashboard",
                  "quicksight:UpdateDashboard",
                  "quicksight:DeleteDashboard",
                  "quicksight:DescribeDashboardPermissions",
                  "quicksight:UpdateDashboardPublishedVersion",
                  "quicksight:UpdateDashboardLinks"
              ]
          }
      }
  ]
}

/****************
 * Helper Functions
****************/
const importAssetBundleAndWait = async (params) => {
  const {
    region,
    awsAccountId,
    assetBundleImportJobId,
    assetBundleImportSource,
    overrideParameters,
    overridePermissions,
    pollIntervalMs = 5000, // Default poll interval of 5 seconds
    timeoutMs = 600000 // Default timeout of 10 minutes
  } = params;

  // Start the import job
  const startInput = {
    AwsAccountId: awsAccountId,
    AssetBundleImportJobId: assetBundleImportJobId,
    AssetBundleImportSource: {
      S3Uri: assetBundleImportSource
    },
    OverrideParameters: overrideParameters,
    OverridePermissions: overridePermissions
  };

  console.log (JSON.stringify(startInput, null, 2))

  let importJobId;
  try {
    const startCommand = new StartAssetBundleImportJobCommand(startInput);
    const startResponse = await quicksightClient.send(startCommand);
    console.log("Asset bundle import job started. Job ID:", assetBundleImportJobId);
  } catch (error) {
    console.error("Error starting asset bundle import job:", error);
    throw error;
  }

  // Poll for status
  const startTime = Date.now();
  while (true) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error("Import job polling timed out");
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

    const describeInput = {
      AwsAccountId: awsAccountId,
      AssetBundleImportJobId: assetBundleImportJobId
    };

    try {
      const describeCommand = new DescribeAssetBundleImportJobCommand(describeInput);
      const describeResponse = await quicksightClient.send(describeCommand);
      const jobStatus = describeResponse.JobStatus;
      console.log("Current import job status:", jobStatus);

      if (jobStatus === 'SUCCESSFUL') {
        console.log("Import job completed successfully!");
        return describeResponse;
      } else if (jobStatus === 'FAILED' || jobStatus === 'FAILED_ROLLBACK_IN_PROGRESS') {
        console.error("Import job failed. Error:", JSON.stringify(describeResponse.Errors));
        throw new Error("Import job failed");
      } else if (jobStatus !== 'IN_PROGRESS') {
        console.warn("Unknown job status:", jobStatus, JSON.stringify(describeResponse.Errors));
        throw new Error("Unknown job status");
      }
    } catch (error) {
      console.error("Error checking asset bundle import job status:", error);
      throw error;
    }
  }
}

async function createAthenaView(params) {
    const { 
      databaseName, 
      sqlQuery, 
      workGroup = 'primary',
      outputLocation
    } = params;
  
    const input = {
      QueryString: sqlQuery,
      QueryExecutionContext: { Database: databaseName },
      WorkGroup: workGroup,
      ResultConfiguration: { OutputLocation: outputLocation }
    };
  
    try {
      const command = new StartQueryExecutionCommand(input);
      const response = await athenaClient.send(command);
      console.log(`View creation initiated. Query execution ID: ${response.QueryExecutionId}`);
      return response.QueryExecutionId;
    } catch (error) {
      console.error("Error creating Athena view:", error);
      //throw error;
    }
  }

/****************
 * Main
****************/
export const handler = async (event, context, callback) => {
    console.log('Received event:', JSON.stringify(event, null, 2));

    const props = event.ResourceProperties
    const requestType = event.RequestType
    let physicalId = event.PhysicalResourceId

    if (requestType === 'Create') {
        physicalId = `vce.eum-config.${crypto.randomUUID()}`
    } else if(!physicalId) {
        sendResponse(event, context.logStreamName, 'FAILED', `invalid request: request type is '${requestType}' but 'PhysicalResourceId' is not defined`)
    }

    try{
      switch (event.ResourceType){
        case 'Custom::CreateViews':
          if (requestType === 'Create' || requestType === 'Update'){
            for (const view of views){
              await createAthenaView({ databaseName: 'engagementdb-glue-db', sqlQuery: view, outputLocation: props.OutputLocation })
            }
            const result = await sendSuccess(physicalId, { }, event);
            return result
          } else if (requestType === 'Delete'){
            //TODO, delete views?
            const result = await sendSuccess(physicalId, { }, event);
            return result
          }
        case 'Custom::DeployQuicksightDashboardBundle':
          if (requestType === 'Create' || requestType === 'Update'){
            const deploymentResults = await importAssetBundleAndWait({
              region: process.env.REGION,
              awsAccountId: process.env.AWS_ACCOUNT_ID,
              assetBundleImportJobId: crypto.randomUUID(), 
              assetBundleImportSource: props.BundleLocation,
              overrideParameters: overrideParameters,
              overridePermissions: overridePermissions,
              pollIntervalMs: 10000, // Poll every 10 seconds
              timeoutMs: 600000 // Timeout after 10 minutes
            });
            const result = await sendSuccess(physicalId, { }, event);
            return result
          } else if (requestType === 'Delete'){
            //TODO, delete Dashboard?
            const result = await sendSuccess(physicalId, { }, event);
            return result
          }
        default:
          const result = await sendSuccess(physicalId, { }, event);
          return result
      }
    }
    catch (ex){
      console.log(ex);
      const result = await sendSuccess(physicalId, { }, event); //TODO: after testing change this to sendFailure
      return result
    }
};

