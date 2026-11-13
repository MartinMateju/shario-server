import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  buildR2Endpoint,
  buildR2PublicUrl,
  parseR2Environment,
  R2_JURISDICTIONS,
  type R2Environment,
  type R2Jurisdiction,
} from "@/config/r2-env.js";

export {
  buildR2Endpoint,
  buildR2PublicUrl,
  R2_JURISDICTIONS,
  type R2Jurisdiction,
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";

let client: S3Client | null = null;
let endpoint: string | null = null;
let configuration: R2Environment | null = null;

type UploadBufferToR2Params = {
  key: string;
  buffer: Buffer | Uint8Array;
  contentType?: string;
  cacheControl?: string;
};

type GetObjectBufferFromR2Params = {
  key: string;
};

type DeleteObjectFromR2Params = {
  key: string;
};

type GetPresignedR2UrlParams = {
  key: string;
  expiresInSeconds?: number;
  responseContentType?: string;
  responseContentDisposition?: string;
  responseCacheControl?: string;
};

type UploadBufferToR2Result = {
  key: string;
};

type R2ClientConfiguration = Pick<
  R2Environment,
  | "R2_ACCOUNT_ID"
  | "R2_ENDPOINT"
  | "R2_JURISDICTION"
  | "R2_ACCESS_KEY_ID"
  | "R2_SECRET_ACCESS_KEY"
>;

const getR2Configuration = (): R2Environment => {
  configuration ??= parseR2Environment(process.env);
  return configuration;
};

export const createR2Client = (configured: R2ClientConfiguration): S3Client =>
  new S3Client({
    region: "auto",
    endpoint: buildR2Endpoint({
      accountId: configured.R2_ACCOUNT_ID,
      jurisdiction: configured.R2_JURISDICTION,
      endpoint: configured.R2_ENDPOINT,
    }),
    forcePathStyle: true,
    maxAttempts: 3,
    credentials: {
      accessKeyId: configured.R2_ACCESS_KEY_ID,
      secretAccessKey: configured.R2_SECRET_ACCESS_KEY,
    },
  });

export const getR2Endpoint = (): string => {
  const configured = getR2Configuration();

  return buildR2Endpoint({
    accountId: configured.R2_ACCOUNT_ID,
    jurisdiction: configured.R2_JURISDICTION,
    endpoint: configured.R2_ENDPOINT,
  });
};

export const getR2BucketName = (): string => {
  return getR2Configuration().R2_BUCKET;
};

export const getR2PublicUrl = (key: string): string => {
  return buildR2PublicUrl(getR2Configuration().R2_PUBLIC_URL, key);
};

export const getR2Client = (): S3Client => {
  if (client) {
    return client;
  }

  const configured = getR2Configuration();
  endpoint = getR2Endpoint();
  client = createR2Client(configured);

  return client;
};

export const getR2ClientEndpoint = (): string => {
  return endpoint ?? getR2Endpoint();
};

export const uploadBufferToR2 = async ({
  key,
  buffer,
  contentType = DEFAULT_CONTENT_TYPE,
  cacheControl = DEFAULT_CACHE_CONTROL,
}: UploadBufferToR2Params): Promise<UploadBufferToR2Result> => {
  if (!key.trim()) {
    throw new Error("uploadBufferToR2: key is required");
  }

  if (!buffer || buffer.byteLength === 0) {
    throw new Error("uploadBufferToR2: buffer is required");
  }

  const command = new PutObjectCommand({
    Bucket: getR2BucketName(),
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: cacheControl,
  });

  await getR2Client().send(command);

  return { key };
};

export const deleteObjectFromR2 = async ({
  key,
}: DeleteObjectFromR2Params): Promise<void> => {
  if (!key.trim()) {
    throw new Error("deleteObjectFromR2: key is required");
  }

  await getR2Client().send(
    new DeleteObjectCommand({
      Bucket: getR2BucketName(),
      Key: key,
    }),
  );
};

export const getObjectBufferFromR2 = async ({
  key,
}: GetObjectBufferFromR2Params): Promise<Buffer> => {
  if (!key.trim()) {
    throw new Error("getObjectBufferFromR2: key is required");
  }

  const command = new GetObjectCommand({
    Bucket: getR2BucketName(),
    Key: key,
  });

  const response: GetObjectCommandOutput = await getR2Client().send(command);

  if (!response.Body) {
    throw new Error("getObjectBufferFromR2: response body is missing");
  }

  const chunks: Buffer[] = [];

  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};

export const getR2ObjectMetadata = async ({ key }: { key: string }) => {
  if (!key.trim()) {
    throw new Error("getR2ObjectMetadata: key is required");
  }

  const object = await getR2Client().send(
    new HeadObjectCommand({ Bucket: getR2BucketName(), Key: key }),
  );
  return {
    contentType: object.ContentType,
    contentLength: object.ContentLength,
  };
};

export const getPresignedR2Url = async ({
  key,
  expiresInSeconds = 300,
  responseContentType,
  responseContentDisposition,
  responseCacheControl,
}: GetPresignedR2UrlParams): Promise<string> => {
  if (!key.trim()) {
    throw new Error("getPresignedR2Url: key is required");
  }

  const expiresIn = Math.min(Math.max(Math.floor(expiresInSeconds), 30), 900);
  return getSignedUrl(
    getR2Client(),
    new GetObjectCommand({
      Bucket: getR2BucketName(),
      Key: key,
      ...(responseContentType
        ? { ResponseContentType: responseContentType }
        : {}),
      ...(responseContentDisposition
        ? { ResponseContentDisposition: responseContentDisposition }
        : {}),
      ...(responseCacheControl
        ? { ResponseCacheControl: responseCacheControl }
        : {}),
    }),
    { expiresIn },
  );
};
