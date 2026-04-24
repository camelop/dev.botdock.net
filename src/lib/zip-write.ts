/**
 * Tiny pure-JS writer for uncompressed (STORE) ZIP archives.
 *
 * Why not shell out to `zip`? The binary isn't on every BotDock host by
 * default (Debian minimal has `unzip` but not `zip`) and asking the user
 * to `apt install` it for a single feature felt silly. Writing STORE
 * zip by hand is ~80 lines and lets us keep the data-dir bundle creation
 * self-contained. Import still uses the `unzip` CLI since it's already
 * a prereq for the file-bundle archive path.
 *
 * Spec reference: PKZIP APPNOTE.TXT. We emit:
 *   1. Per-entry local file header (PK\x03\x04) + filename + body
 *   2. Per-entry central directory record (PK\x01\x02) + filename
 *   3. End-of-central-directory record (PK\x05\x06)
 *
 * STORE mode means compression_method=0 and compressed_size=uncompressed_size.
 * All sizes stay under 4 GiB so no ZIP64 extensions needed.
 */

export type ZipEntry = {
  /** Path inside the archive. Uses forward slashes. Must not start with "/". */
  path: string;
  /** File contents. Pass Buffer for binary, string is encoded as UTF-8. */
  data: Buffer | string;
  /** Unix mode bits (0o644 default for files, 0o600 for secrets). */
  mode?: number;
};

export function writeZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  const now = new Date();
  const { dosTime, dosDate } = dosTimestamp(now);

  for (const entry of entries) {
    if (entry.path.startsWith("/")) {
      throw new Error(`zip entry path must be relative: ${entry.path}`);
    }
    const nameBuf = Buffer.from(entry.path, "utf8");
    const body = typeof entry.data === "string"
      ? Buffer.from(entry.data, "utf8")
      : entry.data;
    const crc = crc32(body);
    const size = body.length;
    const mode = entry.mode ?? 0o644;

    // Local file header (30 bytes + name)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);       // signature "PK\x03\x04"
    lfh.writeUInt16LE(20, 4);               // version needed to extract (2.0)
    lfh.writeUInt16LE(0x0800, 6);           // general purpose bit flag — bit 11 = UTF-8 names
    lfh.writeUInt16LE(0, 8);                // compression method (0 = store)
    lfh.writeUInt16LE(dosTime, 10);         // last mod file time
    lfh.writeUInt16LE(dosDate, 12);         // last mod file date
    lfh.writeUInt32LE(crc, 14);             // crc-32
    lfh.writeUInt32LE(size, 18);            // compressed size
    lfh.writeUInt32LE(size, 22);            // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);  // filename length
    lfh.writeUInt16LE(0, 28);               // extra field length

    localParts.push(lfh, nameBuf, body);

    // Central directory record (46 bytes + name)
    const cdr = Buffer.alloc(46);
    cdr.writeUInt32LE(0x02014b50, 0);       // signature "PK\x01\x02"
    cdr.writeUInt16LE(0x031e, 4);           // version made by — 0x03 = Unix, 0x1e = v3.0
    cdr.writeUInt16LE(20, 6);               // version needed to extract
    cdr.writeUInt16LE(0x0800, 8);           // general purpose bit flag
    cdr.writeUInt16LE(0, 10);               // compression method
    cdr.writeUInt16LE(dosTime, 12);         // last mod file time
    cdr.writeUInt16LE(dosDate, 14);         // last mod file date
    cdr.writeUInt32LE(crc, 16);             // crc-32
    cdr.writeUInt32LE(size, 20);            // compressed size
    cdr.writeUInt32LE(size, 24);            // uncompressed size
    cdr.writeUInt16LE(nameBuf.length, 28);  // filename length
    cdr.writeUInt16LE(0, 30);               // extra field length
    cdr.writeUInt16LE(0, 32);               // file comment length
    cdr.writeUInt16LE(0, 34);               // disk number start
    cdr.writeUInt16LE(0, 36);               // internal file attributes
    // External file attributes: high 16 bits = Unix mode (file) or'd with
    // the file-type nibble (0x8000 = regular file).
    cdr.writeUInt32LE(((0x8000 | (mode & 0xffff)) << 16) >>> 0, 38);
    cdr.writeUInt32LE(offset, 42);          // offset of local header

    centralParts.push(cdr, nameBuf);
    offset += 30 + nameBuf.length + size;
  }

  const centralBuf = Buffer.concat(centralParts);
  const centralSize = centralBuf.length;
  const centralOffset = offset;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);        // signature "PK\x05\x06"
  eocd.writeUInt16LE(0, 4);                 // disk number
  eocd.writeUInt16LE(0, 6);                 // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);    // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);   // total entries
  eocd.writeUInt32LE(centralSize, 12);      // central dir size
  eocd.writeUInt32LE(centralOffset, 16);    // central dir offset
  eocd.writeUInt16LE(0, 20);                // zip file comment length

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// --- crc32 (table-based, IEEE 802.3 polynomial) ---------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- DOS timestamp ---------------------------------------------------------

function dosTimestamp(d: Date): { dosTime: number; dosDate: number } {
  // DOS time: bits 15-11 hour, 10-5 minute, 4-0 second/2
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >>> 1);
  // DOS date: bits 15-9 year-1980, 8-5 month, 4-0 day
  const year = Math.max(1980, d.getFullYear()) - 1980;
  const dosDate = (year << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { dosTime, dosDate };
}
