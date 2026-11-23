// Reads a JPEG's width and height from its frame header (SOF marker) without decoding the image.

const STANDALONE = new Set([0x01, 0xd8, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
// SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
const isFrameHeader = (marker) => marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

/** `{ width, height }` of a JPEG in `buf`, or null when it isn't one. */
export function jpegSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    i += 2;
    if (STANDALONE.has(marker)) continue;
    // End of image, or image data, before any frame header.
    if (marker === 0xd9 || marker === 0xda || i + 2 > buf.length) return null;
    const length = buf.readUInt16BE(i);
    if (length < 2) return null;
    if (isFrameHeader(marker)) {
      if (i + 7 > buf.length) return null;
      return { height: buf.readUInt16BE(i + 3), width: buf.readUInt16BE(i + 5) };
    }
    i += length;
  }
  return null;
}
