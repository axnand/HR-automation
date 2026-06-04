import { AwsClient } from "aws4fetch";

function getConfig() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_S3_REGION;
  const bucket = process.env.AWS_S3_BUCKET;

  if (!accessKeyId || !secretAccessKey || !region || !bucket) {
    throw new Error(
      "Missing AWS S3 configuration (AWS_S3_BUCKET, AWS_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)"
    );
  }

  const aws = new AwsClient({ accessKeyId, secretAccessKey, region, service: "s3" });
  return { aws, region, bucket };
}

function objectUrl(bucket: string, region: string, key: string): string {
  // Per-segment encoding so slashes in the key stay as path separators
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `https://${bucket}.s3.${region}.amazonaws.com/${encoded}`;
}

export async function uploadToS3(key: string, body: Buffer, mimeType: string): Promise<string> {
  const { aws, bucket, region } = getConfig();
  const url = objectUrl(bucket, region, key);

  const res = await aws.fetch(url, {
    method: "PUT",
    body: new Uint8Array(body),
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(body.length),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`S3 upload failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return key;
}

export async function uploadPdfToS3(key: string, body: Buffer): Promise<string> {
  return uploadToS3(key, body, "application/pdf");
}

export async function getSignedDownloadUrl(key: string, expiresSeconds = 3600): Promise<string> {
  const { aws, bucket, region } = getConfig();
  const url = new URL(objectUrl(bucket, region, key));
  url.searchParams.set("X-Amz-Expires", String(expiresSeconds));

  const signed = await aws.sign(url.toString(), {
    method: "GET",
    aws: { signQuery: true },
  });
  return signed.url;
}
