import { S3Client } from "bun";

export type StorageConfig = {
  R2_ACCOUNT_ID?: string | undefined;
  S3_ENDPOINT?: string | undefined;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
};

export type ObjectHead = { size: number; contentType: string; etag: string; lastModified: Date };

export type Storage = {
  putObject(
    key: string,
    body: string | Uint8Array | ArrayBuffer | Blob | ReadableStream,
    contentType?: string,
  ): Promise<void>;
  /** Streams the object body. Rejects when the key does not exist. */
  getObject(key: string): Promise<ReadableStream<Uint8Array>>;
  /** Object metadata, or null when the key does not exist. */
  headObject(key: string): Promise<ObjectHead | null>;
  presignGet(key: string, ttlSeconds: number): string;
  /** Deletes every object under `prefix` and returns how many were removed. */
  deletePrefix(prefix: string): Promise<number>;
};

const DELETE_CONCURRENCY = 16;

const isMissing = (err: unknown) => {
  const code = (err as { code?: string } | null)?.code;
  return code === "NoSuchKey" || code === "NotFound";
};

export function createStorage(cfg: StorageConfig): Storage {
  const endpoint = cfg.S3_ENDPOINT ?? `https://${cfg.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const client = new S3Client({
    endpoint,
    accessKeyId: cfg.R2_ACCESS_KEY_ID,
    secretAccessKey: cfg.R2_SECRET_ACCESS_KEY,
    bucket: cfg.R2_BUCKET,
    region: "auto",
  });

  return {
    async putObject(key, body, contentType) {
      const data = body instanceof ReadableStream ? new Response(body) : body;
      await client.write(key, data, contentType ? { type: contentType } : undefined);
    },

    async getObject(key) {
      const file = client.file(key);
      if (!(await file.exists())) throw new Error(`object not found: ${key}`);
      return file.stream();
    },

    async headObject(key) {
      try {
        const s = await client.file(key).stat();
        return { size: s.size, contentType: s.type, etag: s.etag, lastModified: s.lastModified };
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },

    presignGet(key, ttlSeconds) {
      return client.presign(key, { method: "GET", expiresIn: ttlSeconds });
    },

    async deletePrefix(prefix) {
      if (!prefix.endsWith("/")) throw new Error("deletePrefix needs a prefix ending in '/'");
      let removed = 0;
      for (;;) {
        // Deleting while paging would skip keys, so always re-list from the start until empty.
        const page = await client.list({ prefix, maxKeys: 1000 });
        const keys = (page.contents ?? []).map((o) => o.key);
        if (keys.length === 0) return removed;
        for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
          await Promise.all(keys.slice(i, i + DELETE_CONCURRENCY).map((k) => client.delete(k)));
        }
        removed += keys.length;
      }
    },
  };
}

/** Key builders (SYSTEM_DESIGN section 6). Keys contain only UUIDs, never personal data. */
export const keys = {
  billFile: (businessId: string, billId: string, fileId: string, ext: string) =>
    `b/${businessId}/bills/${billId}/${fileId}.${ext}`,
  billThumb: (businessId: string, billId: string) => `b/${businessId}/bills/${billId}/thumb.jpg`,
  export: (businessId: string, exportId: string, ext: string) =>
    `b/${businessId}/exports/${exportId}.${ext}`,
  businessPrefix: (businessId: string) => `b/${businessId}/`,
  billPrefix: (businessId: string, billId: string) => `b/${businessId}/bills/${billId}/`,
};
