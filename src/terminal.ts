const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function cleanText(value: string): string {
  return value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "").replace(/\t/g, "  ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function width(char: string): number {
  const code = char.codePointAt(0)!;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(char)) return 2;
  return code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60 || code >= 0xffe0 && code <= 0xffe6 || code >= 0x20000) ? 2 : 1;
}

export function fit(text: string, columns: number): string {
  let result = "", used = 0;
  for (const part of graphemes.segment(cleanText(text).replace(/\n/g, " "))) {
    const size = width(part.segment);
    if (used + size > columns) break;
    result += part.segment; used += size;
  }
  return result + " ".repeat(Math.max(0, columns - used));
}

