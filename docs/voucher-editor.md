# Voucher editor (step 3)

Voucher offerings can now use a fixed split layout instead of an uploaded PDF. Tenants control the background, text and accent colors; website-builder font presets; title weight; studio name, title, subtitle, message and footer; logo and image; and image cover/contain. Code and expiry remain system-controlled. The voucher value is preserved in its financial snapshot and is not printed in the built-in artwork. The subscription limit continues to count active voucher offerings, not design revisions.

The main title also supports an independent `colors.title` hex color. When omitted, it follows the general text color, including for saved designs created before this control existed. Choosing "Use text color" in the editor removes the override. Subtitle, body copy, footer and redemption details continue to use `colors.text`. Deploy the server's optional-field support before the client control.

## Data and delivery

- `Product.voucherDesign` holds a strict version-1 JSON design. Omitted fields preserve the existing design; explicit `null` switches back to the existing or newly uploaded PDF. Existing PDF offerings remain on their original path until the tenant chooses the editor.
- Product saves validate ownership of every asset and render the design before persistence. Switching back to a PDF requires a template, checked again under the tenant mutation lock.
- Checkout and manual issuance copy the design into the order/code snapshots. Issuance prefers the purchase snapshot, including its immutable asset keys, over current offering artwork. Editing or archiving the offering does not change purchased content, asset references or financial snapshots. Legacy orders retain their original PDF behavior.
- SVG previews and PDF delivery use the same measured layout and actual website fonts: Manrope, Playfair Display with Geist body copy, or Fraunces with Geist body copy. The legacy Barlow Condensed website preset remains supported. New designs and restored defaults inherit the exact published website preset; saved `sans`, `serif`, and `mono` designs retain their original Noto families.
- The built-in split composition uses an exact 50/50 division on its 840-by-400-point page. The right image fills the entire 420-by-400-point half, edge to edge, with `cover` as the default; explicitly saved `contain` designs remain supported. Without an image, the tenant accent supplies a clean color panel. The left half holds prominent studio branding, title, supporting copy, any personal message, the voucher code, expiry and footer. The code replaces the former value block; no monetary amount or code is placed over/below the image. Optional personal messages never reduce the image height. Text adapts to the available space without truncation. Manrope display copy remains semibold, and empty margins around uploaded logos are trimmed.
- This is a shared rendering update for existing version-1 `split` designs, without rewriting saved design content, immutable asset keys or financial snapshots. Historical built-in vouchers use this new geometry when downloaded or resent again. Existing PDFs already delivered to customers stay unchanged, and uploaded PDF templates remain on their original rendering path. No schema migration or new layout discriminator is introduced.
- Manrope 400/600/700 is bundled under the SIL Open Font License in `assets/fonts/manrope/`. The install/build hook verifies local hashes. Other Fontsource families remain pinned npm dependencies. Text is rendered as glyph artwork in SVG/PDF; no font network request occurs during rendering.
- Sample downloads always show a non-redeemable sample code and label. Actual built-in PDFs print the purchased code and local expiry; value and currency remain validated authoritative metadata but are not displayed. Sample and real PDFs share the same geometry.
- Text is bounded and validated; unsupported glyphs or overflowing copy produce a validation error instead of silently dropping text. The bundled fonts cover Latin (including Czech), Greek and Cyrillic. Automatic labels have Czech and English variants.

## Workspace endpoints

All endpoints below are under the existing products route and require an authenticated workspace session and `PRODUCTS_MANAGE` permission.

| Method | Path                       | Result                                                                                                 |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/voucher-design/defaults` | Design seeded from the tenant's published branding and language, with platform defaults                |
| POST   | `/voucher-design/assets`   | Validated immutable asset key and upload metadata; multipart `file` plus `purpose` (`logo` or `image`) |
| POST   | `/voucher-design/preview`  | Server-rendered SVG sample                                                                             |
| POST   | `/voucher-design/pdf`      | Downloadable PDF sample                                                                                |

Preview requests contain `design`, `productName`, `amountMinor`, `currency`, `validity` and optional `locale`. The server supplies the sample code and tenant timezone. The anonymous catalog exposes only `hasVoucherDesign`, never the design or its private asset keys.

## Asset retention and limits

Uploads accept PNG, JPEG or static WebP up to 8 MiB. The server verifies image bytes, bounds decoded dimensions, removes metadata and normalizes to PNG/JPEG at a maximum edge of 1600 pixels. SVG, animated files, external URLs and assets belonging to another tenant are rejected. Published-site logos must be uploaded explicitly into the voucher asset namespace.

Asset keys are immutable and retained when designs are changed or offerings are deleted, so pending purchases and saved designs can still render. Cleanup of abandoned uploads is deferred; it must account for both offering and issued-order references before deletion. This release adds no database migration or index requirement beyond the voucher foundation.

## Editor behavior and validation

The client debounces previews, aborts superseded requests and ignores late responses. Invalid artwork and pending image uploads block saving. Resetting to tenant defaults and closing with unsaved edits require confirmation. Browser unload and link navigation are guarded; same-document browser Back/Forward is a known navigation limitation.

Regression tests cover design and image validation, workspace route permissions, currencies/fonts, matching renderer output, design-only catalog/import readiness, immutable checkout snapshots, legacy delivery, retries, product persistence and concurrent template switching. Client tests cover persistence, uploads, stale previews, template selection, reset/discard confirmation, public catalog eligibility and locale parity.
