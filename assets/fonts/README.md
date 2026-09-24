# Fonts

Both fonts are under the SIL Open Font License 1.1; the licence texts are
beside them. The build embeds them in the CSS (`scripts/build.mjs`), licence
notices included, so the app needs no network to show them.

| File | Font | Used for | Made with |
|---|---|---|---|
| `arapey-regular.woff` | Arapey Regular, whole font | names, headings, the wordmark, wheel and list answers | `pyftsubset Arapey-Regular.ttf --unicodes="*" --layout-features='*' --flavor=woff` |
| `flamenco-digits.woff` | Flamenco Regular, digits, `+` and `!` only | the numbers on dice and dice totals | `pyftsubset Flamenco-Regular.ttf --unicodes="U+0030-0039,U+002B,U+2212,U+0021" --flavor=woff` |

The sources are the Google Fonts downloads of each family. Flamenco has no
minus sign, so a Fate die's "−" falls back to the system font; the CSS
`unicode-range` makes that automatic.
