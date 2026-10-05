---
name: cardimg-scan
description: Validate card scan images before on-chain upload — DPI, edge detection, black background
---

# CARDIMG Scanner Skill

Validates card scan images before on-chain upload. Application-layer quality control — our subjective standard, not a protocol requirement.

## Dependency Philosophy

The CARDIMG protocol is intentionally dumb — it accepts any image bytes. Quality control lives entirely in the application layer. This module is our fork's standard. Other upload providers can set their own standards. The protocol stays permissionless.

This module calls the [Trading Card Image Uploader](https://github.com/axiemaid/cardimg-upload) as a dependency — it validates, the uploader broadcasts.

## Setup

Requires the `sharp` or `pngjs` npm package for image decoding. Install sharp for best performance:

```bash
npm install sharp
```

Or for PNG-only support without native deps:

```bash
npm install pngjs
```

## Scan a card image

```bash
node scripts/scan.cjs card.png
```

## Checks

1. **Resolution** — Must be ≥ 600 DPI equivalent (trading card is 2.5" × 3.5")
2. **Card edge detection** — Must find a rectangular card in the image
3. **Black background** — Border region must be predominantly black

Does NOT check:
- Orientation/rotation (rescan if wrong — no auto-correction)
- Sharpness/focus (future consideration)
- Color accuracy (future consideration)

## Output

```
✓ PASSED — ready for upload
  Hash: 397cb348667b1926479702d54baf62b0fca6d5aa5a6c76953d1be121fa671073
  Upload with: node scripts/upload.cjs card.png
```

Or:

```
✗ FAILED
  - Resolution 327 DPI (minimum 600)
  - Background not black enough (45%)
```

## What it does NOT do

- No uploading (use the [Trading Card Image Uploader](https://github.com/axiemaid/cardimg-upload))
- No indexing (use the [CARDIMG indexer](https://github.com/axiemaid/cardimg-indexer))
- No serving (use the [CARDIMG API](https://github.com/axiemaid/cardimg-api))
- No auto-rotation or correction (rescan if orientation is wrong)
- No wallet management (see the [BSV wallet skill](https://github.com/axiemaid/bsv-openclaw-skill))

## Composability

Application layer — sits on top of the protocol plumbing:

- **[Trading Card Image Uploader](https://github.com/axiemaid/cardimg-upload)** — upload scans on-chain
- **[CARDIMG indexer](https://github.com/axiemaid/cardimg-indexer)** — index all CARDIMG txs from anyone
- **[CARDIMG API](https://github.com/axiemaid/cardimg-api)** — serve indexed images and metadata over HTTP
- **[BSV wallet skill](https://github.com/axiemaid/bsv-openclaw-skill)** — create and fund the wallet

This module is our app's quality gate. It validates, then hands off to the uploader.
