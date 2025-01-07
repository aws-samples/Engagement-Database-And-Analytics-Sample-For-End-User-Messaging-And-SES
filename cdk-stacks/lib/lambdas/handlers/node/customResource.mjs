import { configure, sendSuccess, sendFailure, sendResponse, LOG_VERBOSE, SUCCESS } from 'cfn-custom-resource';
import { PinpointSMSVoiceV2Client, CreateEventDestinationCommand, CreateConfigurationSetCommand, DeleteConfigurationSetCommand, DeleteEventDestinationCommand } from "@aws-sdk/client-pinpoint-sms-voice-v2"; // ES Modules import
const pinpointClient = new PinpointSMSVoiceV2Client({});

import crypto from 'crypto';

/****************
 * Helper Functions
****************/

const createEventDestination = async (configurationSetName, firehoseArn, iamRoleArn) => {
  const input = { // CreateEventDestinationRequest
    ConfigurationSetName: configurationSetName, 
    EventDestinationName: `${process.env.CdkAppName.toLowerCase()}-eum-event-destination`, 
    MatchingEventTypes: [ "ALL"],
    KinesisFirehoseDestination: { 
      IamRoleArn: iamRoleArn, 
      DeliveryStreamArn: firehoseArn, 
    }
  };

  try {
    const command = new CreateEventDestinationCommand(input);
    const results = await pinpointClient.send(command);
    return results
  } catch (error) {
    console.error(error);
    return false
  }
}

const createConfigurationSet = async () => {
  const input = { // CreateConfigurationSetRequest
    ConfigurationSetName: `${process.env.CdkAppName.toLowerCase()}-eum-configuration-set`, 
  };

  try {
    const command = new CreateConfigurationSetCommand(input);
    const results = await pinpointClient.send(command);
    return results
  } catch (error) {
    console.error(error);
    return false
  }
}

const deleteConfigurationSet = async (configurationSetName) => {
  const input = { // DeleteConfigurationSetRequest
    ConfigurationSetName: configurationSetName, 
  };  

  try {
    const command = new DeleteConfigurationSetCommand(input);
    const results = await pinpointClient.send(command);
    return results
  } catch (error) {
    console.error(error);
    return false
  }
}

const deleteEventDestination = async (configurationSetName, eventDestinationName) => {
  const input = { // DeleteEventDestinationRequest
    ConfigurationSetName: configurationSetName, 
    EventDestinationName: eventDestinationName, 
  };  

  try {
    const command = new DeleteEventDestinationCommand(input);
    const results = await pinpointClient.send(command);
    return results
  } catch (error) {
    console.error(error);
    return false
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
        case 'Custom::CreateEUMConfigurationSet':
          if (requestType === 'Create' || requestType === 'Update'){
            const configurationSet = await createConfigurationSet()
            await createEventDestination(`${process.env.CdkAppName.toLowerCase()}-eum-configuration-set`, props.EventFirehoseArn, props.EventFirehoseIamRoleArn)
            const result = await sendSuccess(physicalId, { }, event);
            return result
          } else if (requestType === 'Delete'){
            await deleteConfigurationSet(`${process.env.CdkAppName.toLowerCase()}-eum-configuration-set`)
            await deleteEventDestination(`${process.env.CdkAppName.toLowerCase()}-eum-configuration-set`, `${process.env.CdkAppName.toLowerCase()}-eum-event-destination`)
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

