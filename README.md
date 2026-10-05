# Trading Card Image Scanner for OpenClaw

Validates card scan images before on-chain upload. Application-layer quality control — our subjective standard, not a protocol requirement.

- **DPI detection** — Requires ≥ 600 DPI equivalent (trading card is 2.5" × 3.5")
- **Card edge detection** — Must find a rectangular card in the image
- **Black background** — Border region must be predominantly black
- **No auto-correction** — If orientation is wrong, rescan. No rotation, no resampling.

## Dependency Philosophy

The CARDIMG protocol is intentionally dumb — it accepts any image bytes. Quality control lives entirely in the application layer. This module is our fork's standard. Other upload providers can set their own standards. The protocol stays permissionless.

This module validates. The [Trading Card Image Uploader](https://github.com/axiemaid/cardimg-upload) broadcasts. They are independent — any scan that passes can be uploaded by any uploader.

## Install

```bash
git clone https://github.com/axiemaid/cardimg-scan.git
cd cardimg-scan
npm install sharp   # or: npm install pngjs (PNG-only, no native deps)
```

## Usage

### CLI

```bash
node scripts/scan.cjs card.png
```

### Library

```javascript
const { scanCard } = require('./lib/scan.js')

const result = await scanCard('card.png')
// { passed, hash, format, width, height, dpi, edges, background, failures }
```

## What This Is Not

- Not an uploader (use the [Trading Card Image Uploader](https://github.com/axiemaid/cardimg-upload))
- Not an indexer (use the [CARDIMG indexer](https://github.com/axiemaid/cardimg-indexer))
- Not an API (use the [CARDIMG API](https://github.com/axiemaid/cardimg-api))
- Not a protocol (the protocol is just `OP_FALSE OP_RETURN "CARDIMG" <image_data>`)

## License

MIT
