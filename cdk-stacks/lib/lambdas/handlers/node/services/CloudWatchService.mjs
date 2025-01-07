const { CloudWatchClient, PutMetricDataCommand } = require("@aws-sdk/client-cloudwatch");
const client = new CloudWatchClient({}); 

export async function logErrorMetric(namespace, errorName, count = 1) {
  const params = {
    MetricData: [
      {
        MetricName: "ErrorCount",
        Dimensions: [
          {
            Name: "ErrorType",
            Value: errorName,
          },
        ],
        Unit: "Count",
        Value: count,
      },
    ],
    Namespace: namespace, 
  };

  try {
    // Send the metric data to CloudWatch
    const command = new PutMetricDataCommand(params);
    const response = await client.send(command);
    console.log("Error metric logged successfully:", response);
  } catch (error) {
    console.error("Failed to log error metric:", error);
  }
}