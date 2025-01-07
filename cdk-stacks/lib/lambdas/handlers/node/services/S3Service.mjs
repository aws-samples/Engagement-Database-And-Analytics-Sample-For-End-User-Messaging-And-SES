// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const s3Client = new S3Client({});

export async function getObject (bucket, key) {

    try {    
        const params = {
            Bucket: bucket,
            Key: key
        }

        const command = new GetObjectCommand(params);
        const response = await s3Client.send(command);
        // The Body object also has 'transformToByteArray' and 'transformToWebStream' methods.
        const str = await response.Body.transformToString();
        console.debug(str);
        return str;

    }
    catch (err){
        if (err.name === 'NoSuchKey') {
            console.warn('S3.getObject: Key not found: ', bucket, key);
            return false
        } else {
            console.error('S3.getObject: ', err);
            throw new Error(err.message);
        }

    }
}