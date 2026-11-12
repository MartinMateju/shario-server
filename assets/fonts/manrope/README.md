# Manrope voucher fonts

These static 400, 600 and 700 faces use the same approved Manrope source as the
Shario client. They are distributed under SIL Open Font License 1.1; preserve
`OFL.txt` with the font files.

The `shario-sans-v1` voucher preset uses these fonts. Preset identifiers and all
other font choices remain unchanged. The renderer keeps the existing glyph
outline path for both PDF and SVG output, with Noto fallbacks for unsupported
scripts and symbols.

The files were generated from `shario-client/src/fonts/Manrope-Variable.ttf`
with FontTools 4.60.2 (`instantiateVariableFont`, `wght` 400/600/700,
`updateFontNames=True`). This is a preparation step, not a deployment dependency.
`font-manifest.json` records SHA-256 checksums. `npm install` and `npm run build`
verify these bundled files without downloading fonts.

Upstream source: https://github.com/google/fonts/tree/main/ofl/manrope
