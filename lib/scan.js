/**
 * CARDIMG Scanner — Core Library
 * 
 * Validates card scan images before on-chain upload.
 * Application-layer quality control — subjective standards for our fork.
 * 
 * Checks:
 *   1. Resolution — must be ≥ 600 DPI equivalent
 *   2. Card edge detection — must find a rectangular card in the image
 *   3. Background — must be black (or near-black)
 * 
 * Does NOT:
 *   - Upload to chain (use Trading Card Image Uploader)
 *   - Rotate or auto-correct (rescan if orientation is wrong)
 *   - Add metadata (protocol is image-only)
 *   - Enforce quality on the protocol layer (this is our app's standard)
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Standard trading card dimensions (inches)
const CARD_WIDTH_IN = 2.5
const CARD_HEIGHT_IN = 3.5
const MIN_DPI = 600

// Background detection
const BLACK_THRESHOLD = 30 // RGB values below this = "black" (0-255)

/**
 * Detect image format from magic bytes.
 */
function detectFormat(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return { format: 'JPEG', mime: 'image/jpeg' }
  if (buf[0] === 0x89 && buf[1] === 0x50) return { format: 'PNG', mime: 'image/png' }
  if (buf[0] === 0x52 && buf.slice(8, 12).toString('ascii') === 'WEBP') return { format: 'WebP', mime: 'image/webp' }
  return { format: 'unknown', mime: 'application/octet-stream' }
}

/**
 * Extract pixel data from image buffer.
 * Uses sharp if available, falls back to raw buffer parsing for PNG.
 */
async function getPixels(buf) {
  // Try sharp first (best performance, handles all formats)
  try {
    const sharp = require('sharp')
    const { data, info } = await sharp(buf)
      .raw()
      .toBuffer({ resolveWithObject: true })
    return {
      width: info.width,
      height: info.height,
      channels: info.channels,
      data
    }
  } catch (e) {
    // sharp not available — try pngjs for PNG
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      const PNG = require('pngjs').PNG
      const png = PNG.sync.read(buf)
      return {
        width: png.width,
        height: png.height,
        channels: 4,
        data: png.data
      }
    }
    throw new Error('No image decoder available. Install sharp or pngjs.')
  }
}

/**
 * Get pixel at (x, y) as { r, g, b }.
 */
function getPixel(pixels, x, y) {
  const idx = (y * pixels.width + x) * pixels.channels
  return {
    r: pixels.data[idx],
    g: pixels.data[idx + 1],
    b: pixels.data[idx + 2]
  }
}

/**
 * Check if a pixel is "black" (below threshold on all channels).
 */
function isBlack(pixel) {
  return pixel.r < BLACK_THRESHOLD && pixel.g < BLACK_THRESHOLD && pixel.b < BLACK_THRESHOLD
}

/**
 * Check if a pixel is "non-black" (card content vs background).
 */
function isContent(pixel) {
  return pixel.r >= BLACK_THRESHOLD || pixel.g >= BLACK_THRESHOLD || pixel.b >= BLACK_THRESHOLD
}

/**
 * Detect effective DPI from image dimensions.
 * Assumes the card fills most of the frame.
 * Trading card is 2.5" × 3.5" — we check both orientations.
 */
function detectDPI(width, height) {
  // Portrait orientation (height > width): card is 2.5" wide × 3.5" tall
  // Landscape orientation (width > height): card is 3.5" wide × 2.5" tall
  let dpiW, dpiH
  if (height >= width) {
    dpiW = width / CARD_WIDTH_IN
    dpiH = height / CARD_HEIGHT_IN
  } else {
    dpiW = width / CARD_HEIGHT_IN
    dpiH = height / CARD_WIDTH_IN
  }
  // Effective DPI = min of both axes (lowest quality axis is the bottleneck)
  const effectiveDPI = Math.min(dpiW, dpiH)
  return {
    width,
    height,
    dpiW: Math.round(dpiW),
    dpiH: Math.round(dpiH),
    effectiveDPI: Math.round(effectiveDPI),
    meetsMinimum: effectiveDPI >= MIN_DPI
  }
}

/**
 * Detect card edges by scanning rows/columns for the black-to-content boundary.
 * Scans from each edge inward to find where the card starts.
 */
function detectCardEdges(pixels) {
  const { width, height } = pixels
  const sampleStep = Math.max(1, Math.floor(Math.min(width, height) / 100))
  const thresholdRatio = 0.3 // 30% of samples must be "content" to count as past the edge

  // Find top edge (scan downward from y=0)
  let top = 0
  for (let y = 0; y < height; y += sampleStep) {
    let contentCount = 0
    let samples = 0
    for (let x = 0; x < width; x += sampleStep) {
      samples++
      if (isContent(getPixel(pixels, x, y))) contentCount++
    }
    if (contentCount / samples > thresholdRatio) {
      top = y
      break
    }
  }

  // Find bottom edge (scan upward from y=height-1)
  let bottom = height - 1
  for (let y = height - 1; y >= 0; y -= sampleStep) {
    let contentCount = 0
    let samples = 0
    for (let x = 0; x < width; x += sampleStep) {
      samples++
      if (isContent(getPixel(pixels, x, y))) contentCount++
    }
    if (contentCount / samples > thresholdRatio) {
      bottom = y
      break
    }
  }

  // Find left edge (scan rightward from x=0)
  let left = 0
  for (let x = 0; x < width; x += sampleStep) {
    let contentCount = 0
    let samples = 0
    for (let y = 0; y < height; y += sampleStep) {
      samples++
      if (isContent(getPixel(pixels, x, y))) contentCount++
    }
    if (contentCount / samples > thresholdRatio) {
      left = x
      break
    }
  }

  // Find right edge (scan leftward from x=width-1)
  let right = width - 1
  for (let x = width - 1; x >= 0; x -= sampleStep) {
    let contentCount = 0
    let samples = 0
    for (let y = 0; y < height; y += sampleStep) {
      samples++
      if (isContent(getPixel(pixels, x, y))) contentCount++
    }
    if (contentCount / samples > thresholdRatio) {
      right = x
      break
    }
  }

  const cardWidth = right - left
  const cardHeight = bottom - top

  return {
    top,
    bottom,
    left,
    right,
    cardWidth,
    cardHeight,
    found: cardWidth > 0 && cardHeight > 0
  }
}

/**
 * Validate that the background is predominantly black.
 * Samples the border region (outside detected card edges).
 */
function validateBackground(pixels, edges) {
  const { width, height } = pixels
  const { top, bottom, left, right } = edges
  const sampleStep = Math.max(1, Math.floor(Math.min(width, height) / 200))

  let blackCount = 0
  let totalCount = 0

  // Sample border regions (outside the card)
  // Top border
  for (let y = 0; y < top; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      totalCount++
      if (isBlack(getPixel(pixels, x, y))) blackCount++
    }
  }
  // Bottom border
  for (let y = bottom + 1; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      totalCount++
      if (isBlack(getPixel(pixels, x, y))) blackCount++
    }
  }
  // Left border
  for (let x = 0; x < left; x += sampleStep) {
    for (let y = top; y <= bottom; y += sampleStep) {
      totalCount++
      if (isBlack(getPixel(pixels, x, y))) blackCount++
    }
  }
  // Right border
  for (let x = right + 1; x < width; x += sampleStep) {
    for (let y = top; y <= bottom; y += sampleStep) {
      totalCount++
      if (isBlack(getPixel(pixels, x, y))) blackCount++
    }
  }

  const blackRatio = totalCount > 0 ? blackCount / totalCount : 0
  return {
    blackRatio: Math.round(blackRatio * 100) / 100,
    samples: totalCount,
    isBlack: blackRatio >= 0.9 // 90% of border pixels must be black
  }
}

/**
 * Scan and validate a card image.
 * 
 * @param {string|Buffer} image - Path to image file, or raw image buffer
 * @returns {Promise<object>} Scan result
 */
const SCAN_OUTPUT_DIR = path.join(process.env.HOME || '/root', '.openclaw', 'card-scans')
const LOG_PATH = path.join(SCAN_OUTPUT_DIR, 'scan-log.json')
const JPEG_QUALITY = 90

/**
 * Append an entry to the scan log.
 * Log file: ~/.openclaw/card-scans/scan-log.json
 */
function appendLog(entry) {
  fs.mkdirSync(SCAN_OUTPUT_DIR, { recursive: true })
  let log = []
  if (fs.existsSync(LOG_PATH)) {
    try { log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')) } catch { log = [] }
  }
  log.push(entry)
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2))
}

/**
 * Convert image to JPEG for efficient on-chain storage.
 * PNG scans are 5-6MB; JPEG at quality 90 is ~300-600KB — 10x smaller, visually identical.
 * Returns the converted buffer + new hash.
 */
async function convertToJpeg(imageBuf) {
  const sharp = require('sharp')
  const jpegBuf = await sharp(imageBuf)
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer()
  return jpegBuf
}

async function scanCard(image) {
  const imageBuf = typeof image === 'string' ? fs.readFileSync(image) : image
  const { format } = detectFormat(imageBuf)

  // Get pixel data from original image
  const pixels = await getPixels(imageBuf)
  const { width, height } = pixels

  // 1. DPI detection
  const dpiInfo = detectDPI(width, height)

  // 2. Card edge detection
  const edges = detectCardEdges(pixels)

  // 3. Background validation
  const background = edges.found
    ? validateBackground(pixels, edges)
    : { blackRatio: 0, samples: 0, isBlack: false }

  // Overall pass/fail
  const passed = dpiInfo.meetsMinimum && edges.found && background.isBlack

  // If passed, convert to JPEG for upload
  let uploadBuf = null
  let uploadHash = null
  let uploadSize = 0

  if (passed) {
    uploadBuf = await convertToJpeg(imageBuf)
    uploadHash = crypto.createHash('sha256').update(uploadBuf).digest('hex')
    uploadSize = uploadBuf.length

    // Save to card-scans dir
    fs.mkdirSync(SCAN_OUTPUT_DIR, { recursive: true })
    const outPath = path.join(SCAN_OUTPUT_DIR, `${uploadHash}.jpg`)
    fs.writeFileSync(outPath, uploadBuf)
  }

  // Hash of original for reference
  const originalHash = crypto.createHash('sha256').update(imageBuf).digest('hex')

  return {
    passed,
    hash: uploadHash || originalHash,
    originalHash,
    format,
    width,
    height,
    size: uploadSize || imageBuf.length,
    originalSize: imageBuf.length,
    dpi: dpiInfo,
    edges,
    background,
    uploadBuffer: uploadBuf,
    checks: {
      resolution: dpiInfo.meetsMinimum,
      cardDetected: edges.found,
      blackBackground: background.isBlack
    },
    failures: [
      ...(!dpiInfo.meetsMinimum ? [`Resolution ${dpiInfo.effectiveDPI} DPI (minimum ${MIN_DPI})`] : []),
      ...(!edges.found ? ['Card edges not detected'] : []),
      ...(!background.isBlack ? [`Background not black enough (${Math.round(background.blackRatio * 100)}%)`] : [])
    ]
  }
}

module.exports = {
  scanCard,
  detectDPI,
  detectCardEdges,
  validateBackground,
  detectFormat,
  getPixels,
  appendLog,
  MIN_DPI,
  CARD_WIDTH_IN,
  CARD_HEIGHT_IN
}
