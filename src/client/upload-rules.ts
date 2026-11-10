import { MAX_ARCHIVE_BYTES } from "@/domain/screenplay/limits";

import { formatFileSize } from "./format";

/**
 * Quick checks that save an editor a wasted upload. They are not security:
 * the server reads every archive itself and enforces its own rules.
 */

export const UPLOAD_LIMIT_LABEL = formatFileSize(MAX_ARCHIVE_BYTES);

export type UploadCheck = { ok: true; file: File } | { ok: false; message: string };

export function checkUpload(files: readonly File[]): UploadCheck {
  if (files.length === 0) return { ok: false, message: "No file was added. Choose a ZIP file." };
  if (files.length > 1) {
    return { ok: false, message: "Add one ZIP at a time, with every episode of the show inside." };
  }
  const file = files[0] as File;
  if (!/\.zip$/i.test(file.name)) {
    return { ok: false, message: `${file.name} is not a ZIP file. Choose a file ending in .zip.` };
  }
  if (file.size === 0) {
    return { ok: false, message: `${file.name} is empty. Choose the ZIP again.` };
  }
  if (file.size > MAX_ARCHIVE_BYTES) {
    return {
      ok: false,
      message: `${file.name} is ${formatFileSize(file.size)}. The limit is ${UPLOAD_LIMIT_LABEL}.`,
    };
  }
  return { ok: true, file };
}
