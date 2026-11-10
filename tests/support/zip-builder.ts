import { crc32, deflateRawSync } from "node:zlib";

/**
 * Minimal ZIP writer for tests. Unlike real ZIP libraries it will happily
 * write hostile archives: unsafe paths, false sizes, wrong checksums,
 * symbolic links, and unsupported flags.
 */
export type ZipEntrySpec = {
  name: string;
  data?: string | Uint8Array;
  /** "store", "deflate", or a raw compression method number. */
  method?: "store" | "deflate" | number;
  /** Uncompressed size to write in the headers instead of the real one. */
  declaredSize?: number;
  /** CRC-32 to write instead of the real one. */
  crc?: number;
  symlink?: boolean;
  encrypted?: boolean;
};

const DOS_DATE_1980_01_01 = 0x21;

export function buildZip(entries: readonly ZipEntrySpec[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const spec of entries) {
    const name = Buffer.from(spec.name, "utf8");
    const raw =
      typeof spec.data === "string" ? Buffer.from(spec.data, "utf8") : Buffer.from(spec.data ?? []);
    const method =
      spec.method === "deflate"
        ? 8
        : spec.method === "store" || spec.method === undefined
          ? 0
          : spec.method;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const size = spec.declaredSize ?? raw.length;
    const crc = (spec.crc ?? crc32(raw)) >>> 0;
    const flags = 0x0800 | (spec.encrypted ? 0x0001 : 0);
    const mode = spec.symlink ? 0o120777 : spec.name.endsWith("/") ? 0o040755 : 0o100644;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4); // made on Unix, so the mode bits are meaningful
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE((mode << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
