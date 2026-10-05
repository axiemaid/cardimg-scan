---
name: cardimg-scan
description: Validate card scan images and upload to BSV — DPI, edge detection, black background
---

# CARDIMG Scanner Skill

Web UI for scanning and uploading card images. User selects files, scanner validates (DPI, card edges, black background), and if passed, uploads to BSV automatically via the Trading Card Image Uploader.

## Dependency Philosophy

The CARDIMG protocol is intentionally dumb — it accepts any image bytes. Quality control lives entirely in the application layer. This module is our fork's standard. Other upload providers can set their own standards. The protocol stays permissionless.

This module calls the [Trading Card Image Uploader](https://github.com/axiemaid/cardimg-upload) as a dependency — it validates, the uploader broadcasts. Files that pass are uploaded automatically. No manual step between scan and upload.

## Setup

Install dependencies:

```bash
npm install
```

Install the Trading Card Image Uploader as a sibling module:

```bash
cd ~/.openclaw
git clone https://github.com/axiemaid/cardimg-upload.git
cd cardimg-upload && npm install
```

Requires a dedicated BSV wallet at `~/.openclaw/cardimg-scanner-wallet.json`. To create and fund one, use the [BSV wallet skill](https://github.com/axiemaid/bsv-openclaw-skill).

## Start the server

```bash
node scripts/serve.cjs
```

Opens at `http://localhost:3020`. Drag and drop or select card scan images. The scanner validates each file and uploads to BSV if it passes.

## Checks

1. **Resolution** — Must be ≥ 600 DPI equivalent (trading card is 2.5" × 3.5")
2. **Card edge detection** — Must find a rectangular card in the image
3. **Black background** — Border region must be predominantly black

Does NOT check:
- Orientation/rotation (rescan if wrong — no auto-correction)
- Sharpness/focus (future consideration)
- Color accuracy (future consideration)

## CLI (batch validation only — no upload)

```bash
node scripts/scan.cjs card.png
```

CLI mode validates only. Use the web UI for the full scan + upload flow.

## What it does NOT do

- No indexing (use the [CARDIMG indexer](https://github.com/axiemaid/cardimg-indexer))
- No serving (use the [CARDIMG API](https://github.com/axiemaid/cardimg-api))
- No auto-rotation or correction (rescan if orientation is wrong)
- No wallet management (see the [BSV wallet skill](https://github.com/axiemaid/bsv-openclaw-skill))

## Composability

Application layer — sits on top of the protocol plumbing:

- **[Trading Card Image Uploader](https://github.com/axiemaid/cardimg-upload)** — called automatically on scan pass
- **[CARDIMG indexer](https://github.com/axiemaid/cardimg-indexer)** — index all CARDIMG txs from anyone
- **[CARDIMG API](https://github.com/axiemaid/cardimg-api)** — serve indexed images and metadata over HTTP
- **[BSV wallet skill](https://github.com/axiemaid/bsv-openclaw-skill)** — create and fund the wallet
