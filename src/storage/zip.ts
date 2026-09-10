/**
 * A minimal ZIP writer and reader for library export/import (plan C5).
 *
 * Hand-written because the sandbox had no package registry; it produces
 * ordinary ZIP files that any operating system can open, which is the whole
 * point of the feature. Entries are deflated where the platform offers
 * compression streams and stored otherwise.
 */

const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array): Promise<{ data: Uint8Array; method: number }> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!CS) return { data: bytes, method: 0 };
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CS("deflate-raw"));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    return out.length < bytes.length ? { data: out, method: 8 } : { data: bytes, method: 0 };
  } catch {
    return { data: bytes, method: 0 };
  }
}

async function inflate(bytes: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return bytes;
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!DS) throw new Error("this browser cannot read compressed ZIP entries");
  const stream = new Blob([bytes]).stream().pipeThrough(new DS("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ZipEntry {
  path: string;
  text: string;
}

class Writer {
  parts: Uint8Array[] = [];
  length = 0;
  push(part: Uint8Array): void {
    this.parts.push(part);
    this.length += part.length;
  }
  u32(n: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    this.push(b);
  }
  u16(n: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n & 0xffff, true);
    this.push(b);
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/** Build a ZIP archive. Folders are implied by the entry paths. */
export async function createZip(entries: ZipEntry[]): Promise<Uint8Array> {
  const w = new Writer();
  const central: { name: Uint8Array; crc: number; size: number; packed: number; method: number; offset: number }[] = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const raw = encoder.encode(entry.text);
    const { data, method } = await deflate(raw);
    const crc = crc32(raw);
    const offset = w.length;

    w.u32(0x04034b50);
    w.u16(20);
    w.u16(0x0800); // UTF-8 names
    w.u16(method);
    w.u16(0); // time
    w.u16(0); // date
    w.u32(crc);
    w.u32(data.length);
    w.u32(raw.length);
    w.u16(name.length);
    w.u16(0);
    w.push(name);
    w.push(data);

    central.push({ name, crc, size: raw.length, packed: data.length, method, offset });
  }

  const centralStart = w.length;
  for (const e of central) {
    w.u32(0x02014b50);
    w.u16(20);
    w.u16(20);
    w.u16(0x0800);
    w.u16(e.method);
    w.u16(0);
    w.u16(0);
    w.u32(e.crc);
    w.u32(e.packed);
    w.u32(e.size);
    w.u16(e.name.length);
    w.u16(0);
    w.u16(0);
    w.u16(0);
    w.u16(0);
    w.u32(0);
    w.u32(e.offset);
    w.push(e.name);
  }
  const centralSize = w.length - centralStart;

  w.u32(0x06054b50);
  w.u16(0);
  w.u16(0);
  w.u16(central.length);
  w.u16(central.length);
  w.u32(centralSize);
  w.u32(centralStart);
  w.u16(0);
  return w.bytes();
}

/** Read a ZIP archive produced by anything reasonable. */
export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  // Find the end-of-central-directory record, scanning back over any comment.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 65536; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("this does not look like a ZIP file");

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("the ZIP directory is damaged");
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));

    const localNameLen = view.getUint16(offset + 26, true);
    const localExtraLen = view.getUint16(offset + 28, true);
    const dataStart = offset + 30 + localNameLen + localExtraLen;
    const data = bytes.subarray(dataStart, dataStart + packed);

    if (!path.endsWith("/")) {
      entries.push({ path, text: decoder.decode(await inflate(data, method)) });
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
