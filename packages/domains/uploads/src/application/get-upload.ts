import type { UserId } from "@x1agent/kernel";
import type { Upload, UploadId } from "../domain/upload.js";
import { UploadNotFoundError } from "../domain/errors.js";
import type { UploadRepository } from "../ports/upload-repository.js";

/**
 * Resolve an upload by id and verify the caller owns it. Cross-tenant
 * + foreign-user hits surface as `upload_not_found` (404) so we don't
 * leak existence. This is the only place an ACL check belongs — every
 * route calls this before reading the body / deleting the upload.
 */
export async function getOwnedUpload(
  uploads: UploadRepository,
  id: UploadId,
  userId: UserId,
): Promise<Upload> {
  const u = await uploads.findById(id);
  if (!u || u.userId !== userId) throw new UploadNotFoundError();
  return u;
}
