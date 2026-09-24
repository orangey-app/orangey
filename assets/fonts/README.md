# Fonts

Both fonts are under the SIL Open Font License 1.1; the licence texts are
beside them. The build embeds them in the CSS (`scripts/build.mjs`), licence
notices included, so the app needs no network to show them.

| File | Font | Used for | Made with |
|---|---|---|---|
| `arapey-regular.woff` | Arapey Regular, whole font | names, headings, the wordmark, wheel and list answers | `pyftsubset Arapey-Regular.ttf --unicodes="*" --layout-features='*' --flavor=woff` |
| `youngserif-digits.woff` | Young Serif Regular, digits, `+`, `−` and `!` only | the numbers on dice and dice totals | `pyftsubset YoungSerif-Regular.ttf --unicodes="U+0030-0039,U+002B,U+2212,U+0021" --layout-features='' --flavor=woff` |

The sources are the Google Fonts downloads of each family. Young Serif's
default digits are old-style (3, 4, 5, 7 and 9 hang below the line), which is
the look wanted; no layout features are kept, since nothing here switches
figure styles. Anything else a dice total says falls back to the system font
through the CSS `unicode-range`.
