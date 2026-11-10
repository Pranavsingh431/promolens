/**
 * Upload limits shared by the browser and the server. The server enforces them.
 * The browser only uses them to tell an editor early that a file is too large.
 */
export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
