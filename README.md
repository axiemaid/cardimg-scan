# Trading Card Image Scanner for OpenClaw

Web UI for scanning and uploading card images to BSV. Select files, scanner validates (DPI, card edges, black background), and if passed, uploads to BSV automatically.

- **DPI detection** — Requires ≥ 600 DPI equivalent (trading card is 2.5" × 3.5")
- **Card edge detection** — Must find a rectangular card in the image
- **Black background** — Border region must be predominantly black
- **Auto-upload on pass** — Files that pass validation are uploaded to BSV via the Trading Card Image Uploader. No manual step between scan and upload.

## Dependency Philosophy

The CARDIMG protocol is intentionally dumb — it accepts any image bytes. Quality control lives entirely in the application layer. This module is our fork's standard. Other upload providers can set their own standards. The protocol stays permissionless.

This module validates. The [Trading Card Image Uploader](https://github.com/axiemaid/cardimg-upload) broadcasts. They are independent modules — the scanner calls the uploader as a dependency on validation pass.

## Install

```bash
git clone https://github.com/axiemaid/cardimg-scan.git
cd cardimg-scan
npm install
```

Install the Trading Card Image Uploader as a sibling module:

```bash
cd ~/.openclaw
git clone https://github.com/axiemaid/cardimg-upload.git
cd cardimg-upload && npm install
```

Requires a BSV wallet at `~/.openclaw/bsv-wallet.json`. To create and fund one, use the [BSV wallet skill](https://github.com/axiemaid/bsv-openclaw-skill).

## Usage

### Web UI

```bash
node scripts/serve.cjs
```

Open `http://localhost:3020`. Drag and drop or select card scan images. Each file is validated and uploaded to BSV if it passes.

### CLI (validation only)

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

- Not an uploader (uses the [Trading Card Image Uploader](https://github.com/axiemaid/cardimg-upload) as a dependency)
- Not an indexer (use the [CARDIMG indexer](https://github.com/axiemaid/cardimg-indexer))
- Not an API (use the [CARDIMG API](https://github.com/axiemaid/cardimg-api))
- Not a protocol (the protocol is just `OP_FALSE OP_RETURN "CARDIMG" <image_data>`)

## License

MIT
