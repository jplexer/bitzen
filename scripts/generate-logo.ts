import { resolve } from "node:path";
import { brandColor, pixelArt, pixelPalette, pixelLetters, terminalLogo, terminalPixels, terminalColorCells } from "../src/logo.ts";

function pixels(rows: readonly string[], x = 0, y = 0, palette: Record<string, string> = {"1":brandColor}) {
  return rows.flatMap((row, dy) => [...row].flatMap((pixel, dx) => palette[pixel] ? [`<rect x="${x + dx}" y="${y + dy}" width="1" height="1" fill="${palette[pixel]}"/>`] : [])).join("\n");
}
function svg(width: number, height: number, title: string, description: string, artwork: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges" role="img" aria-labelledby="title description">
<title id="title">${title}</title>
<desc id="description">${description}</desc>
<g fill="${brandColor}">${artwork}</g>
</svg>\n`;
}
const root = resolve(import.meta.dir, "..");
const wordRows = ["0".repeat(35), "0".repeat(35), ...Array.from({length:7}, (_, y) => [..."bitzen"].map(letter => pixelLetters[letter]![y]!).join("0"))];
const wordmark = [..."bitzen"].map((letter, index) => pixels(pixelLetters[letter]!, 15 + index * 6, 2)).join("\n");
await Bun.write(resolve(root, "assets/bitzen-logo.svg"), svg(864, 224, "Bitzen", "A pixel squid captain with a weathered blue hat, brass badge, sea-green face, dark amber eyes, and a green tentacle beard beside lowercase bitzen lettering.", `<g transform="translate(32 32) scale(16)">${pixels(pixelArt, 0, 0, pixelPalette)}\n${wordmark}</g>`));
await Bun.write(resolve(root, "assets/bitzen-mark.svg"), svg(256, 256, "Bitzen pixel captain", "A pixel squid captain with a weathered blue hat, sea-green face, dark amber eyes, and green tentacles.", `<g transform="translate(32 48) scale(16)">${pixels(pixelArt, 0, 0, pixelPalette)}</g>`));
await Bun.write(resolve(root, "assets/bitzen-logo.txt"), `${terminalLogo.split("\n").map((line, index) => `${line}   ${terminalPixels(wordRows).split("\n")[index] ?? ""}`).join("\n")}\n`);
const ansi = terminalColorCells(pixelArt).map(cell => {
  if (cell.text === "\n") return "\x1b[0m\n";
  const rgb = (color: string) => [1,3,5].map(offset => parseInt(color.slice(offset, offset + 2),16)).join(";");
  return `${cell.fg ? `\x1b[38;2;${rgb(cell.fg)}m` : "\x1b[39m"}${cell.bg ? `\x1b[48;2;${rgb(cell.bg)}m` : "\x1b[49m"}${cell.text}`;
}).join("") + "\x1b[0m\n";
await Bun.write(resolve(root, "assets/bitzen-mark.ansi"), ansi);
console.log("Generated multicolour SVGs, plain text, and an ANSI terminal mark.");
