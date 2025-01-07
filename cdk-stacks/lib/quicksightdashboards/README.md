# Exporting and Importing Quicksight Dashboards
 Look at this blog post: https://aws.amazon.com/blogs/business-intelligence/automate-and-accelerate-your-amazon-quicksight-asset-deployments-using-the-new-apis/

 ## Creating the asset bundle

### List Dashboards
```bash
aws quicksight list-dashboards --aws-account-id 123456789012
```

### Start the export job
```bash
aws quicksight start-asset-bundle-export-job --aws-account-id 123456789012 \
--asset-bundle-export-job-id job-1 \
--resource-arns [dashboard arn] \
--include-all-dependencies \
--export-format QUICKSIGHT_JSON
```

### Check the status of the export job
```bash
aws quicksight describe-asset-bundle-export-job \
--aws-account-id 123456789012 \
--asset-bundle-export-job-id job-1
```

Once the job is complete, the response will include an S3 Signed URL to download the asset bundle which you can place in ./lib/quicksightdashboards/quicksighdashboardbundles