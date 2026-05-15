import { Buffer } from "node:buffer";

/**
 * Minimal STORED-mode ZIP builder. Pure-JS, no deps. Used by the share
 * download endpoint so an operator can pull every file in a share in
 * one click rather than navigating per-file.
 *
 * STORED (no compression) is chosen deliberately:
 *   - Shares are typically small (kB to low MB) and often already
 *     compressed binaries (PNG, PDF). DEFLATE buys nothing.
 *   - Avoids pulling in `node:zlib` async streaming + a dependency.
 *
 * Limitations: 32-bit sizes/offsets (no ZIP64). A share larger than 4
 * GiB total or with a single file > 4 GiB will produce an invalid
 * archive. Both are far outside what shares are used for today.
 */

interface ZipEntry {
  /** Archive path. Forward-slash separated. Must not be empty. */
  path: string;
  bytes: Buffer;
  /** Last-modified time. Defaults to "now" if omitted. */
  mtime?: Date;
}

export function buildStoredZip(entries: readonly ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, "utf8");
    const crc = crc32(entry.bytes);
    const size = entry.bytes.length;
    const { time, date } = dosDateTime(entry.mtime ?? new Date());

    // Local file header (signature 0x04034b50, 30 bytes + name).
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0x0800, 6); // general purpose: UTF-8 filename
    lfh.writeUInt16LE(0, 8); // method = stored
    lfh.writeUInt16LE(time, 10);
    lfh.writeUInt16LE(date, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(size, 18); // compressed size
    lfh.writeUInt32LE(size, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra field length
    chunks.push(lfh, nameBuf, entry.bytes);

    // Central directory header (signature 0x02014b50, 46 bytes + name).
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0x0800, 8); // general purpose: UTF-8
    cdh.writeUInt16LE(0, 10); // method = stored
    cdh.writeUInt16LE(time, 12);
    cdh.writeUInt16LE(date, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(size, 20);
    cdh.writeUInt32LE(size, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra
    cdh.writeUInt16LE(0, 32); // comment
    cdh.writeUInt16LE(0, 34); // disk #
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + size;
  }

  const centralBuf = Buffer.concat(central);

  // End of central directory record (signature 0x06054b50, 22 bytes).
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk #
  eocd.writeUInt16LE(0, 6); // disk where CD starts
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // entries total
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// CRC32 (IEEE 802.3 polynomial, 0xEDB88320). Lazy table init.
let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[i] = c >>> 0;
    }
    CRC_TABLE = t;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    (d.getDate() & 0x1f);
  return { time, date };
}
