import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { AvatarMimeType } from '@agentmesh/protocol';
import type { AvatarStore } from './avatars.js';

/**
 * Avatars in S3, for the serverless deployment.
 *
 * The bucket stays private and the images are served back through the API
 * rather than by a public URL or a presigned link. Avatars are a few kilobytes
 * and are cached hard by the browser, so the cost of proxying them is
 * negligible - and in exchange the bucket needs no public access, no CORS
 * rules, and no signed URLs leaking into logs and screenshots.
 */
export class S3AvatarStore implements AvatarStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region?: string,
  ) {
    this.client = new S3Client(region ? { region } : {});
  }

  async put(key: string, body: Buffer, contentType: AvatarMimeType): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Belt and braces: even if this object were ever reached directly, a
        // browser must not be talked into treating it as something else.
        ContentDisposition: 'inline',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = await response.Body?.transformToByteArray();
      if (!body) return null;
      return { body: Buffer.from(body), contentType: response.ContentType ?? 'application/octet-stream' };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || status === 403) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
      .catch(() => undefined);
  }
}
