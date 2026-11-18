import { ensureBucket } from "../src/platform/storage/ensure-bucket";

// If using Cloudflare R2 directly (R2_ACCOUNT_ID set and no S3_ENDPOINT), bucket is managed in Cloudflare.
if (!process.env.S3_ENDPOINT && process.env.R2_ACCOUNT_ID) {
  console.log("Using Cloudflare R2; bucket creation via S3 API skipped.");
  process.exit(0);
}

const endpoint = process.env.S3_ENDPOINT ?? "http://minio:9000";
const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? "billsnap";
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? "billsnap_secure_storage_key_2026!";
const bucket = process.env.R2_BUCKET ?? "billsnap";

console.log(`Connecting to S3 storage at ${endpoint} to verify bucket '${bucket}'...`);

for (let i = 0; i < 15; i++) {
  try {
    await ensureBucket({ endpoint, accessKeyId, secretAccessKey, bucket });
    console.log(`Bucket verified and ready: ${bucket}`);
    break;
  } catch (err) {
    if (i === 14) {
      console.error(`Failed to ensure bucket '${bucket}' at ${endpoint}:`, err);
      process.exit(1);
    }
    await Bun.sleep(1000);
  }
}
