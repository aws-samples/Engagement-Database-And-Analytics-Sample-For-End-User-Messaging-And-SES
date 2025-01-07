const Velocity = require('velocityjs');
const Compile = Velocity.Compile;
const { getObject } = require('./services/S3Service.mjs');
const { logErrorMetric } = require('./services/CloudWatchService.mjs');
const { executeAthenaQuery } = require('./services/AthenaService.mjs');
const JSON5 = require('json5') //Using JSON5 as it's more forgiving than JSON.parse. i.e. allows trailing commas.
import { customMethodHandlers } from './utils/customMethodHandlers.mjs'

const templatesBucket = process.env.TEMPLATES_BUCKET
const whatsappStatusTemplate = process.env.WHATSAPP_STATUS_TEMPLATE_KEY
const whatsappMessageTemplate = process.env.WHATSAPP_MESSAGE_TEMPLATE_KEY
const messagingTemplateKey = process.env.MESSAGING_TEMPLATE_KEY
const sesTemplateKey = process.env.SES_TEMPLATE_KEY
const cache = {}
let waStatusCompile, waMessageCompile, messagingCompile, sesCompile

const fetchTemplates = async (bucket, key) => {
  //Get Whatsapp Status Template
  if (!waStatusCompile){
    const waStatusTemplate = await getCachedFile(templatesBucket, whatsappStatusTemplate)
    const compiledWAStatusTemplate = Velocity.parse(waStatusTemplate);
    waStatusCompile = new Compile(compiledWAStatusTemplate, { 
      customMethodHandlers
    }); 
  }

  //Get Whatsapp Message Template
  if (!waMessageCompile){
    const waMessageTemplate = await getCachedFile(templatesBucket, whatsappMessageTemplate)
    const compiledWAMessageTemplate = Velocity.parse(waMessageTemplate);
    waMessageCompile = new Compile(compiledWAMessageTemplate, { 
      customMethodHandlers
    }); 
  }
    
  //Get Messaging Template
  if (!messagingCompile){
    const messagingTemplate = await getCachedFile(templatesBucket, messagingTemplateKey)
    const compiledMessagingTemplate = Velocity.parse(messagingTemplate);
    messagingCompile = new Compile(compiledMessagingTemplate, { 
      customMethodHandlers
    }); 
  }

  //Get SES Template
  if (!sesCompile){
    const sesTemplate = await getCachedFile(templatesBucket, sesTemplateKey)
    const compiledSESTemplate = Velocity.parse(sesTemplate);
    sesCompile = new Compile(compiledSESTemplate, { 
      customMethodHandlers
    }); 
  }
}

const getCachedFile = async (bucket, key) => {
  //Check cache
  const cacheKey = `${bucket}/${key}`
  if (cache[cacheKey] && cache[cacheKey].expiresOn > Date.now()) {
      console.debug("Cache hit: ", cacheKey);
      return cache[cacheKey].file;
  } else {
      console.debug("Cache miss:", cacheKey);
      //Get file from S3
      const file = await getObject(bucket, key);
      //Set cache. NOTE: This is storing in lambda memory, If templates get larger, may need to cache to /tmp
      cache[cacheKey] = {
          file: file,
          expiresOn: Date.now() + parseInt(process.env.CACHE_EXPIRATION_SECONDS) * 1000, // Set expiry time from env var
      }
      return file;
  } 
}

function expandJsonEvents(jsonData) {
  const expandedEvents = [];
  
  // Get the base properties (everything except whatsAppWebhookEntry)
  const baseProperties = {
      context: jsonData.context,
      aws_account_id: jsonData.aws_account_id,
      message_timestamp: jsonData.message_timestamp,
      whatsAppWebhookEntry: jsonData.whatsAppWebhookEntry
  };

  // Process each change in the changes array
  if (jsonData.parsedWhatsAppWebhookEntry && jsonData.parsedWhatsAppWebhookEntry.changes) {
    //Statuses
    jsonData.parsedWhatsAppWebhookEntry.changes.forEach((change) => {
          if (change.value && change.value.statuses && Array.isArray(change.value.statuses)) {
              // Process each status in the statuses array
              change.value.statuses.forEach((status) => {
                  // Create new JSON object with base properties
                  const newJson = {
                      ...baseProperties,
                      parsedWhatsAppWebhookEntry: {
                          changes: [{
                              field: change.field,
                              value: {
                                  metadata: change.value.metadata,
                                  statuses: [status],
                                  messaging_product: change.value.messaging_product
                              }
                          }],
                          id: jsonData.parsedWhatsAppWebhookEntry.id
                      }
                  };
                  
                  expandedEvents.push(newJson);
              });
          }

          //Messages
          if (change.value && change.value.messages && Array.isArray(change.value.messages)) {
              // Process each message in the messages array
              change.value.messages.forEach((message) => {
                  // Create new JSON object with base properties
                  const newJson = {
                      ...baseProperties,
                      parsedWhatsAppWebhookEntry: {
                          changes: [{
                              field: change.field,
                              value: {
                                  metadata: change.value.metadata,
                                  messages: [message],
                                  messaging_product: change.value.messaging_product
                              }
                          }],
                          id: jsonData.parsedWhatsAppWebhookEntry.id
                      }
                  };
                  expandedEvents.push(newJson);
              });
          } 
      });
  }

  return expandedEvents;
}

export const handler = async (event) => {
  console.trace(JSON5.stringify(event, null, 2));

  await fetchTemplates()
  
  /* Process the list of records and transform them */
  let transformedRecords = []
  for (const record of event.records) {
    const decoded = Buffer.from(record.data, 'base64');
    console.trace(`Decoded: ${decoded}`);

    let source, result, targets=[], partition_keys, message, recordType

    //Parse Input
    try{
        source = JSON5.parse(decoded);
        if (source.Message) { //This came from SNS
          message = JSON5.parse(source.Message)
        } else {
          message = source //Direct put from Firehose
        }
        console.trace(`Message: ${JSON5.stringify(message, null, 2)}`);
        result = 'Ok'
    }
    catch (parseError){
        await logErrorMetric('FirehoseTransformer', 'JsonParsingError')
        console.error('json parsing error: ', parseError);
    }

    //Apply Template
    try{
      if(result === 'Ok'){ //no sense continuing if parsing failed. 

        if(message.whatsAppWebhookEntry){  //WhatsApp

          // Go ahead and parse the whatsAppWebhookEntry to make things easier in Velocity
          message.parsedWhatsAppWebhookEntry = JSON5.parse(message.whatsAppWebhookEntry);

          //Expand the nested WA changes, messages, and statuses into multiple records
          //If you add multiple records to the output, that are delimited
          //by a newline, then Firehose will still send provided they have the same recordId.
          //And Athena will properly parse them into multiple rows. 
          let expandedRecords = expandJsonEvents(message);

          for (const expandedRecord of expandedRecords){
            console.trace(JSON5.stringify(expandedRecord, null, 2))
            if (expandedRecord.parsedWhatsAppWebhookEntry.changes[0]?.value?.messages?.length > 0) { //WhatsApp Message
              recordType = 'whatsappMessage'
              targets.push(waMessageCompile.render(expandedRecord))        
            } else if (expandedRecord.parsedWhatsAppWebhookEntry.changes[0]?.value?.statuses?.length > 0) { //WhatsApp Status
              console.trace('dave',expandedRecord.parsedWhatsAppWebhookEntry.changes[0]?.value?.statuses[0]?.id)
              if(expandedRecord.parsedWhatsAppWebhookEntry.changes[0]?.value?.statuses[0]?.id ) {
                  recordType = 'whatsappStatus'
                  targets.push(waStatusCompile.render(expandedRecord))  
                } else {
                  recordType = 'unknown'
                  console.warn('Record with no id...dropping')
                  result = 'Dropped' //Setting to Dropped so it's not writted to S3 Errors
                  targets.push('')
                }
            }
          }
        } else if (message['messageId']) { //Messaging Service
          recordType = 'messaging'
          message.originalEvent = structuredClone(message) // Append the originalEvent property to the eumSMSMessage object
          targets.push(messagingCompile.render(message))
        } else if (message['mail']) { //SES
          recordType = 'ses'
          message.originalEvent = structuredClone(message) // Append the originalEvent property to the eumSMSMessage object
          targets.push(sesCompile.render(message))
        } else {
          recordType = 'unknown'
          console.warn('Unknown record type.')
          result = 'ProcessingFailed'
          targets.push('')
        }    

        if (recordType !== 'unknown'){
          //Parse date for partition keys.  We might have multiple records in targets due to WhatsApp, but they should all have the same date.
          //so just using the first one
          const decodedRecord = JSON5.parse(targets[0]);
          console.trace(JSON5.stringify(decodedRecord, null, 2))
          const date = new Date(decodedRecord['timestamp']);
          partition_keys = {
            "year": date.getFullYear().toString(),
            "month": (date.getMonth() + 1).toString().padStart(2, '0'),
            "day": date.getDate().toString().padStart(2, '0'),
            "hour": date.getHours().toString().padStart(2, '0')
          }
          console.trace(JSON5.stringify(partition_keys, null, 2))
          //Update glue table partition
          let s3Bucket = 's3://' + process.env.EVENTS_BUCKET

          let query = `ALTER TABLE \`${process.env.ATHENA_DATABASE}\`.\`${process.env.ATHENA_EVENTS_TABLE}\` ADD IF NOT EXISTS PARTITION (ingest_timestamp='${partition_keys.year}-${partition_keys.month}-${partition_keys.day} ${partition_keys.hour}:00:00') LOCATION '${s3Bucket}/events/${partition_keys.year}/${partition_keys.month}/${partition_keys.day}/${partition_keys.hour}'`
      
          console.debug(query)
          await executeAthenaQuery({
            databaseName: process.env.ATHENA_DATABASE,
            sqlQuery: query,
            outputLocation: `s3://${process.env.LOG_BUCKET}/queryresults`
          })

          //Format for Athena which likes JSON on a single line
          targets = targets.map(target => {
            let newTarget = target.replace(/\s+(?=((\\[\\"]|[^\\"])*"(\\[\\"]|[^\\"])*")*(\\[\\"]|[^\\"])*$)/g, '') //Remove whitespace except for between double quotes
                                  .replace(/\n/g, "") //Newlines
                                  .replace(/\,(?!\s*?[\{\[\"\'\w^(\\\")])/g, '') //Trailing commas
            return newTarget
          })
        }
      } else {
        result = 'ProcessingFailed'
        targets = []
      } 
    }
    catch (velocityError){
        console.error('velocity template error: ', velocityError);
        console.trace(targets)
        await logErrorMetric('FirehoseTransformer', 'VelocityTemplateError')
        result = 'ProcessingFailed'
        targets = []
    }

    console.trace(JSON5.stringify(targets, null, 2))
    transformedRecords.push({
      recordId: record.recordId,
      result: result,
      data: Buffer.from(targets.join(''), 'utf-8').toString('base64'),
      'metadata': { 'partitionKeys': partition_keys }
    })

  }
  console.info(`Processing completed.  Successful records ${transformedRecords.length}.`);
  console.trace(`Transformed Records: `, transformedRecords);
  return { records: transformedRecords };
};