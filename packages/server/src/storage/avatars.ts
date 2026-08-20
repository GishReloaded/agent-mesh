import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AVATAR_MAX_BYTES, AgentMeshError, ErrorCode, type AvatarMimeType } from '@agentmesh/protocol';

/**
 * Where uploaded avatars live.
 *
 * Two implementations for the two deployments, exactly as the connection
 * registry has: a directory on disk for a server that owns one, and an S3
 * bucket for Lambda, which owns no disk that survives an invocation.
 */
export interface AvatarStore {
  put(key: string, body: Buffer, contentType: AvatarMimeType): Promise<void>;
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

/**
 * Decide the type from the bytes, never from what the uploader claimed.
 *
 * A file's declared content type is a request, not evidence. Serving something
 * as an image because its sender said so is how a page ends up executing
 * whatever was actually in the file.
 */
export function sniffImageType(body: Buffer): AvatarMimeType | null {
  if (body.length < 12) return null;

  if (body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) return 'image/png';
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  if (body.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (
    body.subarray(0, 4).toString('latin1') === 'RIFF' &&
    body.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** Validate an upload and produce the key it should be stored under. */
export function prepareAvatar(userId: string, body: Buffer): { key: string; contentType: AvatarMimeType } {
  if (body.length === 0) {
    throw new AgentMeshError(ErrorCode.ValidationFailed, 'The uploaded file is empty.');
  }
  if (body.length > AVATAR_MAX_BYTES) {
    throw new AgentMeshError(
      ErrorCode.PayloadTooLarge,
      `Avatars must be ${Math.round(AVATAR_MAX_BYTES / 1024)} KB or smaller.`,
    );
  }

  const contentType = sniffImageType(body);
  if (!contentType) {
    throw new AgentMeshError(
      ErrorCode.ValidationFailed,
      'That file is not a PNG, JPEG, WebP or GIF image. SVG is not accepted.',
    );
  }

  // A fresh suffix on every upload means the URL changes with the image, so no
  // cache anywhere has to be persuaded that the old one is stale.
  const suffix = randomBytes(8).toString('hex');
  const extension = contentType.split('/')[1] ?? 'png';
  return { key: `avatars/${userId}/${suffix}.${extension}`, contentType };
}

/** Filesystem-backed store, for a server that owns a disk. */
export class LocalAvatarStore implements AvatarStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    // Keys are generated here, never taken from a request, but resolving and
    // checking costs nothing and closes the door on that ever changing.
    const full = resolve(this.root, key);
    if (!full.startsWith(resolve(this.root))) {
      throw new AgentMeshError(ErrorCode.ValidationFailed, 'Invalid avatar key.');
    }
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const full = this.path(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async get(key: string): Promise<{ body: Buffer; contentType: string } | null> {
    try {
      const body = await readFile(this.path(key));
      return { body, contentType: sniffImageType(body) ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

/** Default location when no bucket is configured. */
export function defaultAvatarDir(): string {
  return join(process.cwd(), 'data', 'avatars');
}
