# Notice

Burg Screenshot is Copyright (c) 2026 Burg Media and released under the MIT License (see [LICENSE](LICENSE)).

All JavaScript, HTML and CSS in this repository was written by Burg Media, including the small PDF writer in `lib/pdf.js`. There are no third-party libraries, no bundler and no minified code. The MIT License does not apply to the third-party components below; they keep their own licenses.

## Fonts: `fonts/`

- **Geist** (`geist-latin.woff2`) and **Geist Mono** (`geist-mono-latin.woff2`), Copyright 2024 The Geist Project Authors, https://github.com/vercel/geist-font
- License: SIL Open Font License 1.1, full text in [`fonts/LICENSE-Geist-OFL.txt`](fonts/LICENSE-Geist-OFL.txt).

## Specifications

- **PDF export** in `lib/pdf.js` writes PDF 1.4 files following the structure described in the PDF specification (ISO 32000), with each page holding one JPEG image. No third-party code is included.
