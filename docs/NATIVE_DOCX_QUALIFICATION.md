# Native DOCX qualification

The October 13 synthetic actual-owned-route qualification uses signed official LibreOffice 26.8.1 on macOS ARM64, with a separate temporary user profile and read-only installed system fonts. No provider is invoked and no fonts are copied into the repository or redistributed.

The initial isolated renderer silently chose substitute fonts despite `Georgia` in the source DOCX. Its native PDF embedded FrankRuhlHofshi/LinuxLibertine; that output cannot qualify Georgia. Correcting font discovery produces actual Georgia/Georgia-Bold and removes the original text corruption. The production DOCX writer already records the selected font correctly; no font replacement or production renderer change is necessary.

Use an explicit renderer-local Fontconfig file:

```xml
<?xml version="1.0"?>
<fontconfig>
  <dir>/System/Library/Fonts/Supplemental</dir>
  <dir>/System/Library/Fonts</dir>
  <cachedir>/tmp/ap-docx-qualification/font-cache</cachedir>
</fontconfig>
```

Pass its path in `FONTCONFIG_FILE` for the renderer process only, and use a separate `-env:UserInstallation=file:///...` temporary profile. These are supported [Fontconfig configuration](https://fontconfig.pages.freedesktop.org/fontconfig/fontconfig-user.html) and [LibreOffice command-line](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html) mechanisms. Do not alter a system font catalog or an owner's application profile. Other platforms must explicitly discover their lawfully installed selected fonts.

The qualification gate requires all of:

1. The exact DOCX downloaded through the authenticated owned export route, with a recorded hash and source format settings.
2. Source XML retaining the selected font, A4 dimensions, 12 pt body, exact 360-twip line height (150%) and `A1B2C3` accent.
3. Supported native rendering with embedded Georgia/Georgia-Bold, three A4 pages and measured text inside printable bounds. Substitute fonts fail the gate.
4. Independent visual inspection of every page for clipping, overlap, missing/reordered content and format fidelity.
5. Complete ordered source text as supplemental evidence, not a substitute for visual review. PDF.js verifies all source characters; PDFKit's reading-order heuristic can move a continuation word despite correct visible geometry.

The default Arial résumé and letter also render with actual Arial, complete ordered source text and respectively two and one pages. The direct application PDF uses its existing Helvetica/Times mapping; the Georgia preview discloses this difference. Native DOCX qualification establishes selected-font fidelity for the tested files and environment, not pixel identity with that direct PDF, universal reader behavior or Gemini writing quality.
