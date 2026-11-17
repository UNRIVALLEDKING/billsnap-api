import { ensureBucket } from "../test/ensure-bucket";

const endpoint = process.env.S3_ENDPOINT ?? "http://localhost:9000";
const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? "billdrop";
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? "billdrop-dev-secret";

for (const bucket of ["billdrop-dev", "billdrop-test"]) {
  await ensureBucket({ endpoint, accessKeyId, secretAccessKey, bucket });
  console.log(`bucket ready: ${bucket}`);
}
