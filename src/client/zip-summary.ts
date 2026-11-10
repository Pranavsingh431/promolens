/**
 * Counts the screenplay files in a ZIP and their uncompressed size, from the
 * archive's directory alone, so the upload screen can estimate time and cost
 * before anything is sent. Nothing is decompressed and no content is read.
 * The server still inspects every archive itself; this is only for estimates.
 */

export type ZipSummary = { episodes: number; textKb: number };

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
/** The end record is 22 bytes plus a comment of at most 65,535 bytes. */
const TAIL_BYTES = 22 + 65_535;

const isScreenplay = (name: string) =>
  /\.txt$/i.test(name) &&
  !name.endsWith("/") &&
  !name.startsWith("__MACOSX/") &&
  !/(^|\/)\._/.test(name);

async function bytesOf(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

export async function summarizeZip(file: Blob): Promise<ZipSummary | null> {
  try {
    const tailStart = Math.max(0, file.size - TAIL_BYTES);
    const tail = await bytesOf(file.slice(tailStart));
    let end = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === END_OF_DIRECTORY) {
        end = i;
        break;
      }
    }
    if (end < 0) return null;
    const entries = tail.getUint16(end + 10, true);
    const size = tail.getUint32(end + 12, true);
    const offset = tail.getUint32(end + 16, true);
    // ZIP64 archives mark these fields as unknown; they are far over the upload limit anyway.
    if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) return null;
    if (offset + size > file.size) return null;

    const directory = await bytesOf(file.slice(offset, offset + size));
    const decoder = new TextDecoder();
    let episodes = 0;
    let bytes = 0;
    let at = 0;
    for (let n = 0; n < entries && at + 46 <= directory.byteLength; n++) {
      if (directory.getUint32(at, true) !== DIRECTORY_ENTRY) return null;
      const uncompressed = directory.getUint32(at + 24, true);
      const nameLength = directory.getUint16(at + 28, true);
      const extraLength = directory.getUint16(at + 30, true);
      const commentLength = directory.getUint16(at + 32, true);
      const name = decoder.decode(
        new Uint8Array(directory.buffer, directory.byteOffset + at + 46, nameLength),
      );
      if (isScreenplay(name)) {
        episodes += 1;
        bytes += uncompressed;
      }
      at += 46 + nameLength + extraLength + commentLength;
    }
    return episodes > 0 ? { episodes, textKb: bytes / 1024 } : null;
  } catch {
    return null;
  }
}
