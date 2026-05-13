import type { UserId } from "@x1agent/kernel";
import type { UploadId } from "../domain/upload.js";
import { getOwnedUpload } from "./get-upload.js";
import type { UploadRepository } from "../ports/upload-repository.js";

/**
 * Soft-delete an upload. The actual storage object is reaped by the
 * next cleanup sweep, which gives us a single code path for object
 * deletion (only the sweep talks to the storage adapter for
 * destructive operations).
 */
export async function deleteUpload(
  uploads: UploadRepository,
  id: UploadId,
  userId: UserId,
): Promise<void> {
  const u = await getOwnedUpload(uploads, id, userId);
  await uploads.markDeleted(u.id);
}
