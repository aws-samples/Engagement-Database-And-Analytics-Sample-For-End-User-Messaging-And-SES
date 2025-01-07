// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
export const customMethodHandlers = [ 
    { 
        uid: 'toEscapedJson', 
        match: function({ property, context }) { 
            return property === 'toEscapedJson';
        }, 
        resolve({ params }) { 
            var myJSONString = JSON.stringify(params[0]);
            var myEscapedJSONString = myJSONString
            .replace(/[\\]/g, '\\\\')
            .replace(/[\"]/g, '\\\"')
            .replace(/[\/]/g, '\\/')
            .replace(/[\b]/g, '\\b')
            .replace(/[\f]/g, '\\f')
            .replace(/[\n]/g, '\\n')
            .replace(/[\r]/g, '\\r')
            .replace(/[\t]/g, '\\t');
            return myEscapedJSONString
        }, 
    },{ 
        uid: 'toJson', 
        match: function({ property, context }) { 
            return property === 'toJson';
        }, 
        resolve({ params }) { 
            var myJSONString = JSON.stringify(params[0]);
            return myJSONString
        }, 
    },
    {
        uid: 'retrieveItemFromRaw', 
        match: function({ property, context }) { 
            return property === 'retrieveItemFromRaw';
        }, 
        resolve({ params }) { 
            let value = '';

            try {
                // Parse the JSON string
                const parsedData = JSON.parse(params[0]);

                // Access the property if it exists
                if (parsedData && params[1] in parsedData) {
                    value = parsedData[params[1]];
                } else {
                    console.warn(`retrieveItemFromRaw: Property "${params[1]}" not found in JSON data`);
                }
            } catch (error) {
                console.error('retrieveItemFromRaw: Error parsing JSON data:', error.message);
                throw new Error(error.message);
            }
            return value
        }, 
    },
    {
        uid: 'convertTime', 
        match: function({ property, context }) { 
            return property === 'convertTime';
        }, 
        resolve({ params }) { 
            const date = new Date(params[0]);
            return date.getTime();
        }, 
    },
    {
        uid: 'formatPhoneNumber', 
        match: function({ property, context }) { 
            return property === 'formatPhoneNumber';
        }, 
        resolve({ params }) { 
            const phoneNumber = params[0];
            return `+${phoneNumber.replace(/[^0-9]/g, '')}`;
        }, 
    },
    {
        uid: 'fetchAccountId', 
        match: function({ property, context }) { 
            return property === 'fetchAccountId';
        }, 
        resolve({ params }) { 
            return process.env.AWS_ACCOUNT_ID;
        }, 
    },
    {
        uid: 'determineChannel', 
        match: function({ property, context }) { 
            return property === 'determineChannel';
        }, 
        resolve({ params }) { 
            try {
                return params[0].split('_')[0].toLowerCase();
            } catch (error) {
                console.warn('determineChannel: Error determining channel:', error.message);
                return 'unknown';
            }
        }, 
    },
    {
        uid: 'formatSESTags', 
        match: function({ property, context }) { 
            return property === 'formatSESTags';
        }, 
        resolve({ params }) { 
            try {
                let newTags = {};
                //loop through all object properties of params[0]   
                for (let tag in params[0]) {
                    newTags[tag] = params[0][tag][0];
                }
                return JSON.stringify(newTags);
            } catch (error) {
                console.warn('formatSESTags: Error formatting SES tags:', error.message);
                return 'unknown';
            }
        }, 
    }
]; 