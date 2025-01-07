const { AthenaClient, StartQueryExecutionCommand } = require("@aws-sdk/client-athena");
const athenaClient = new AthenaClient({});

export async function executeAthenaQuery(params) {
    console.log(params)
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
      console.log(`Query execution initiated. Query execution ID: ${response.QueryExecutionId}`);
      return response.QueryExecutionId;
    } catch (error) {
      console.error("Error executing Athena query:", error);
      //throw error;
    }
  }