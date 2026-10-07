# Pixel logo

Bitzen's mascot is a squid captain with a tentacle beard, a weathered blue hat,
brass badge, sea-green face, and amber eyes. The wordmark uses custom pixel glyphs.
All artwork is created with code.

The shared pixel grids and palette live in [src/logo.ts](../src/logo.ts). The TUI
renders them directly with `█`, `▀`, and `▄`, using foreground and background
colours for two pixels per cell. The full mascot takes 12 columns and 5 rows;
a compact portrait takes 8 columns and 3 rows.

## Exports

| File | Purpose |
| --- | --- |
| `assets/bitzen-logo.svg` | Transparent mascot and wordmark |
| `assets/bitzen-mark.svg` | Transparent standalone mascot |
| `assets/bitzen-logo.png`, `assets/bitzen-mark.png` | Raster exports |
| `assets/bitzen-logo-preview.png` | Preview on the TUI background |
| `assets/bitzen-logo.txt` | Monochrome terminal logo |
| `assets/bitzen-mark.ansi` | Multicolour terminal mascot |

Run from the repository root to regenerate SVG and terminal exports:

```sh
bun --no-env-file scripts/generate-logo.ts
```

PNGs are separate raster exports of the SVGs. Re-export them with an SVG renderer
at integer scales when changing the artwork to preserve sharp pixels.

Print the coloured mascot directly:

```sh
cat assets/bitzen-mark.ansi
```
