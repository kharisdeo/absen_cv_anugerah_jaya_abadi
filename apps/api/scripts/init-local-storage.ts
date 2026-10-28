import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

import { env } from '../src/config/env.js';

const { STORAGE_ACCESS_KEY, STORAGE_BUCKET, STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_SECRET_KEY } =
  env;

if (!STORAGE_ACCESS_KEY || !STORAGE_BUCKET || !STORAGE_SECRET_KEY) {
  throw new Error(
    'Local object storage requires STORAGE_BUCKET, STORAGE_ACCESS_KEY, and STORAGE_SECRET_KEY.',
  );
}

const client = new S3Client({
  region: STORAGE_REGION,
  ...(STORAGE_ENDPOINT ? { endpoint: STORAGE_ENDPOINT, forcePathStyle: true } : {}),
  credentials: {
    accessKeyId: STORAGE_ACCESS_KEY,
    secretAccessKey: STORAGE_SECRET_KEY,
  },
});

try {
  try {
    await client.send(new HeadBucketCommand({ Bucket: STORAGE_BUCKET }));
  } catch (error) {
    const metadata =
      typeof error === 'object' && error !== null && '$metadata' in error
        ? error.$metadata
        : undefined;
    const statusCode =
      typeof metadata === 'object' &&
      metadata !== null &&
      'httpStatusCode' in metadata &&
      typeof metadata.httpStatusCode === 'number'
        ? metadata.httpStatusCode
        : undefined;
    const errorName =
      typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;

    if (statusCode !== 404 && errorName !== 'NotFound' && errorName !== 'NoSuchBucket') {
      throw error;
    }

    await client.send(new CreateBucketCommand({ Bucket: STORAGE_BUCKET }));
  }

  console.log('Local private selfie bucket ready.');
} finally {
  client.destroy();
}
