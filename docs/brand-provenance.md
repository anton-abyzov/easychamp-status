# EasyChamp status brand sources

This independent status site vendors a small, pinned snapshot of the supported EasyChamp design system. No product repository or active design-system checkout was modified.

- UIKit source: `anton-abyzov/ec-uikit` commit `50cee874e45493544981a40506a4c9db671de7a7` (remote develop, verified 2026-10-07). `public/assets/brand/uikit-tokens.css` is the exact `src/styles/tokens.css` blob, including light/dark theme and mobile type roles.
- Logo: exact path data from that commit's `src/shell/BrandLogo.tsx`. The SVG lockups and favicon preserve the canonical loop mark/wordmark geometry. Static SVG exports use the UIKit brand ramp and light/dark ink. No fabricated lettermark is used.
- Typography: self-hosted `@fontsource-variable/inter@5.3.0` and `@fontsource-variable/inter-tight@5.3.0`, Latin variable normal faces; bundled SIL Open Font Licenses accompany the files. No runtime font CDN or product-origin asset dependency.
- Product imagery: unmodified official Console standings and league home captures from `anton-abyzov/ec-landing` commit `63b02fd30c6ff4e194b3711835b26c10706a8247`, `public/media/pages/`. They are labelled product previews and are not current monitoring evidence. The responsive light/dark pictures use actual captured screens, never invented status data.
- Shared context: authenticated `easychamp-umb/claude-project-sync` commit `b1abdacd764007246163d4fe8237cfa8698cbd8e`; single source is UIKit tokens, Inter/Inter Tight, with real product captures.

`brand-assets.json` records source paths, pinned revisions, and SHA-256 digests for every vendored asset. These are source identities, not claims that an operational product is deployed at that commit.

## Status-specific adaptation

The status stylesheet maps existing neutral/brand/semantic UIKit tokens to the status vocabulary. Green means configured checks passed; the brand accent remains indigo. Body and control sizes use rem-based UIKit roles, mobile captions follow UIKit's larger mobile token, controls have 44px minimum targets, and reduced-motion is respected. Observed-history strips read the published monitoring records and never use the product-preview images as evidence.

## Verification boundary

The branding and signal UI were checked headlessly at 1440, 820, 390 and 320 CSS pixels in both themes, with 100% and 200% text. The regression harness checks dynamic registry counts, keyboard history, nested routes, Escape/Close/Back, stale-check invalidation, invalid data, actual assets and fonts, and signal detail rows. Run `npm run check:ui` against the built distribution.

Integration screenshots under `status-redesign-20261007/brand-candidate` use actual captured monitoring observations with an explicitly fixed as-of clock (`2026-10-08T00:05:00Z`): the public generation is `2026-10-07T23:54:04.889Z`, combined with the actual cluster observation at `2026-10-08T00:04:52Z`. Original observation timestamps are preserved. These prove candidate UI behavior, not a deployed release or current production health. The saved report includes input/source SHA-256 identities and the captured inputs are retained beside it. Early overflow failures remain in the evidence directory; intrinsic reflow fixes were retested without weakening assertions.
