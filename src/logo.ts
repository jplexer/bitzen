export const brandColor = "#d78e69";

// Shared colour pixels drive the SVG and the terminal's two-pixels-per-cell mark.
export const pixelPalette: Record<string, string> = {
  C: "#586c7f", // weathered blue hat
  G: "#bba479", // aged brass badge
  F: "#8eac9d", // sea-green face
  E: "#755634", // dark amber eyes
  T: "#719584", // tentacle beard
  B: "#91b6a2", // lighter tentacle tips
};
export const pixelArt = [
  "000CCCCCC000",
  "00CCCGGCCC00",
  "0CCCCCCCCCC0",
  "00FFFFFFFF00",
  "00FFEFFEFF00",
  "00FFEFFEFF00",
  "00FFFFFFFF00",
  "000TTTTTT000",
  "000TT00TT000",
  "00BB0000BB00",
] as const;
export const compactPixelArt = ["00CCCC00", "0CCCGCC0", "CCCCCCCC", "0FFFFFF0", "0FEFFEF0", "0FFFFFF0"];
// Plain-text fallback keeps eyes and badge visible through negative space.
const monochrome = (rows: readonly string[]) => rows.map(row => [...row].map(pixel => ["0", "E", "G"].includes(pixel) ? "0" : "1").join(""));
export const pixelMark = monochrome(pixelArt);
const compactMark = monochrome(compactPixelArt);

export function terminalColorCells(rows: readonly string[]): { text: string; fg?: string; bg?: string }[] {
  return rows.flatMap((row, y) => {
    if (y % 2) return [];
    const cells = [...row].map((pixel, x) => {
      const upper = pixelPalette[pixel], lower = pixelPalette[rows[y + 1]?.[x] ?? "0"];
      if (upper && lower && upper !== lower) return {text:"▀",fg:upper,bg:lower};
      return {text:upper ? lower ? "█" : "▀" : lower ? "▄" : " ",fg:upper ?? lower};
    });
    return y + 2 < rows.length ? [...cells, {text:"\n"}] : cells;
  });
}

export function terminalPixels(rows: readonly string[]): string {
  const blocks = [" ", "▀", "▄", "█"];
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y += 2) {
    lines.push([...rows[y]!].map((pixel, x) => blocks[Number(pixel === "1") + 2 * Number(rows[y + 1]?.[x] === "1")]).join(""));
  }
  return lines.join("\n");
}
export const terminalLogo = terminalPixels(pixelMark);
export const compactTerminalLogo = terminalPixels(compactMark);

// Custom 5 × 7 lowercase glyphs; SVG lettering never depends on a local font.
export const pixelLetters: Record<string, readonly string[]> = {
  b: ["10000", "10000", "10110", "11001", "10001", "10001", "11110"],
  i: ["00100", "00000", "01100", "00100", "00100", "00100", "01110"],
  t: ["00100", "00100", "11111", "00100", "00100", "00101", "00010"],
  z: ["00000", "00000", "11111", "00010", "00100", "01000", "11111"],
  e: ["00000", "00000", "01110", "10001", "11111", "10000", "01111"],
  n: ["00000", "00000", "11110", "10001", "10001", "10001", "10001"],
};
