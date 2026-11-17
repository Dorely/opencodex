/**
 * Fork (see FORK.md, "Modality probe"): a small PNG showing a random number, used to test whether
 * a model really reads image input. A model that never saw the image cannot guess the number.
 */
import { deflateSync } from "node:zlib";

// 5x7 bitmap digits, one string per row, "#" = ink.
const DIGITS: readonly (readonly string[])[] = [
  [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
];

const SCALE = 12;
const PAD = 2; // in font cells
const GAP = 1;

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Grayscale PNG of `code` (digits only), black on white. */
export function renderDigitsPng(code: string): Uint8Array {
  if (!/^\d{1,12}$/.test(code)) throw new Error("code must be 1-12 digits");
  const cellsWide = PAD * 2 + code.length * 5 + (code.length - 1) * GAP;
  const cellsHigh = PAD * 2 + 7;
  const width = cellsWide * SCALE;
  const height = cellsHigh * SCALE;
  const ink = (cx: number, cy: number): boolean => {
    const row = cy - PAD;
    if (row < 0 || row >= 7) return false;
    const x = cx - PAD;
    if (x < 0) return false;
    const index = Math.floor(x / (5 + GAP));
    const col = x % (5 + GAP);
    if (index >= code.length || col >= 5) return false;
    return DIGITS[Number(code[index])]![row]![col] === "#";
  };
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    const offset = y * (width + 1);
    raw[offset] = 0; // filter: none
    for (let x = 0; x < width; x++) raw[offset + 1 + x] = ink(Math.floor(x / SCALE), Math.floor(y / SCALE)) ? 0 : 255;
  }
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit grayscale, no interlace
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** A random code of `length` digits that does not start with 0. */
export function randomProbeCode(length = 5, random: () => number = Math.random): string {
  let code = String(1 + Math.floor(random() * 9));
  while (code.length < length) code += String(Math.floor(random() * 10));
  return code;
}

/** Whether a model's answer reads back `code`: some digit run in the answer equals it. */
export function answerMatchesCode(answer: string, code: string): boolean {
  const runs: string[] = answer.replace(/(\d)[\s,.-](?=\d)/g, "$1").match(/\d+/g) ?? [];
  return runs.includes(code);
}
