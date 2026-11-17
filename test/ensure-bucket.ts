import { createHash, createHmac } from "node:crypto";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s).digest();

/**
 * Creates `bucket` on an S3-compatible endpoint (MinIO) if missing. Bun's S3Client has no bucket
 * operations, and production buckets are provisioned in Cloudflare, so this is dev/test infrastructure only.
 */
export async function ensureBucket(opts: {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
}): Promise<void> {
  const region = opts.region ?? "us-east-1";
  const url = new URL(`/${opts.bucket}`, opts.endpoint);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256("");
  const headers = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signed = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["PUT", url.pathname, "", headers, signed, payloadHash].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kDate = hmac(`AWS4${opts.secretAccessKey}`, day);
  const key = hmac(hmac(hmac(kDate, region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    },
  });
  if (res.ok) return;
  const body = await res.text();
  if (res.status === 409 && /BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(body)) return;
  throw new Error(`creating bucket ${opts.bucket} failed: ${res.status} ${body}`);
}
