/** The start of a real JPEG: SOI, an APP0 (JFIF) segment, then a frame header (SOF) holding the size. */
export function fakeJpeg(width, height, sof = 0xc0) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const frame = [0xff, sof, 0x00, 0x11, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...frame, 0xff, 0xd9]);
}
