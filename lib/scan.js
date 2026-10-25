/**
 * CARDIMG Scanner — Core Library
 * 
 * Validates card scan images before on-chain upload.
 * Application-layer quality control — subjective standards for our fork.
 * 
 * Checks:
 *   1. Resolution — must be ≥ 600 DPI equivalent
 *   2. Card edge detection — must find a rectangular card in the image
 *   3. Card dimensions — must match expected size at detected DPI
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

// Reference card pixel dimensions — empirically derived from known-good 600 DPI scans.
// Hyper Battle One Piece cards on a 600 DPI scanner produce ~1386 × 2005 px
// of detected card content. This is our ground truth — not calculated from
// physical measurements, but observed from actual scans that passed validation.
// Both the reference and test scans go through the same edge detection,
// so boundary pixel loss cancels out.
const REF_CARD_WIDTH_600 = 1386
const REF_CARD_HEIGHT_600 = 2005
const REF_DPI = 600

// Card size tolerance — accounts for edge detection variation between scans
const CARD_SIZE_TOLERANCE = 0.10  // ±10%

const MIN_DPI = 500


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
      .rotate() // auto-orient based on EXIF
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
 * Check if a pixel is "white" (above threshold on all channels).
 */
const WHITE_THRESHOLD = 225
function isWhite(pixel) {
  return pixel.r > WHITE_THRESHOLD && pixel.g > WHITE_THRESHOLD && pixel.b > WHITE_THRESHOLD
}

/**
 * Check if a pixel is background (black or white scanner background,
 * not card content). White = scanner lid, black = scanner bed.
 */
function isBackground(pixel) {
  return isBlack(pixel) || isWhite(pixel)
}

/**
 * Check if a pixel is card content (not background).
 */
/**
 * Check if a pixel is "strong content" — not just "not background" but has real color.
 * Penny sleeve edges read as gray (e.g. 211,211,211) — low brightness, zero saturation.
 * Real card artwork has saturation (color). This filters out translucent sleeve edges.
 * saturation = (max - min) / max. Sleeve edge: sat=0.00. Card content: sat=0.40+.
 */
const CONTENT_SAT_THRESHOLD = 0.08 // Minimum saturation to count as real card content

function isContent(pixel) {
  // Must not be background
  if (isBackground(pixel)) return false
  // Must have some color (filters out translucent sleeve edges)
  const maxC = Math.max(pixel.r, pixel.g, pixel.b)
  const minC = Math.min(pixel.r, pixel.g, pixel.b)
  const sat = maxC === 0 ? 0 : (maxC - minC) / maxC
  if (maxC < 50 && sat < CONTENT_SAT_THRESHOLD) return false // Dark gray = not content
  if (maxC >= 50 && maxC <= 220 && sat < CONTENT_SAT_THRESHOLD) return false // Mid/low gray = sleeve edge
  return true
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
  const thresholdRatio = 0.3 // 30% of samples must be content to count as past the edge

  // Find top edge (scan downward from y=0)
  // Skip pure background rows (all black or all white)
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
    for (let y = top; y <= bottom; y += sampleStep) {
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
    for (let y = top; y <= bottom; y += sampleStep) {
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
 * Validate card dimensions against empirical reference.
 * At 600 DPI, a complete card produces ~1386 × 2005 px of content.
 * Expected px at other DPIs scales proportionally: ref_px * (dpi / 600).
 * ±10% tolerance for edge detection variation between scans.
 */
const CARD_SIZE_TOLERANCE_PCT = Math.round(CARD_SIZE_TOLERANCE * 100)

function validateCardDimensions(edges, dpi) {
  const { cardWidth, cardHeight } = edges

  if (cardWidth <= 0 || cardHeight <= 0) {
    return { valid: false, reason: 'Card dimensions zero or negative' }
  }

  const isPortrait = cardHeight >= cardWidth
  const scale = dpi / REF_DPI
  const expectedW = Math.round((isPortrait ? REF_CARD_WIDTH_600 : REF_CARD_HEIGHT_600) * scale)
  const expectedH = Math.round((isPortrait ? REF_CARD_HEIGHT_600 : REF_CARD_WIDTH_600) * scale)

  const widthRatio = cardWidth / expectedW
  const heightRatio = cardHeight / expectedH
  const minRatio = Math.min(widthRatio, heightRatio)

  // Card must be at least (1 - tolerance) of expected size on both axes
  const minAcceptable = 1 - CARD_SIZE_TOLERANCE
  const valid = widthRatio >= minAcceptable && heightRatio >= minAcceptable

  if (!valid) {
    const worst = minRatio < widthRatio ? 'height' : 'width'
    const actual = minRatio < widthRatio ? cardHeight : cardWidth
    const expected = minRatio < widthRatio ? expectedH : expectedW
    return {
      valid: false,
      reason: `Card ${worst} is ${actual}px but expected ~${expected}px at ${dpi} DPI (±${CARD_SIZE_TOLERANCE_PCT}%) — card may be cut off`,
      widthRatio: Math.round(widthRatio * 100) / 100,
      heightRatio: Math.round(heightRatio * 100) / 100,
      expectedWidth: expectedW,
      expectedHeight: expectedH
    }
  }

  return {
    valid: true,
    orientation: isPortrait ? 'portrait' : 'landscape',
    widthRatio: Math.round(widthRatio * 100) / 100,
    heightRatio: Math.round(heightRatio * 100) / 100,
    expectedWidth: expectedW,
    expectedHeight: expectedH
  }
}

/**
 * Report card/image DPI.
 * Priority:
 *   1. Image metadata (embedded by scanner) — most accurate
 *   2. Inferred from card content vs empirical reference — card becomes the ruler
 *   3. Fall back to 600 if no metadata and no edges
 */
function detectCardDPI(edges, imageDpi) {
  const { cardWidth, cardHeight } = edges
  const isPortrait = cardHeight >= cardWidth

  let dpi, source
  if (imageDpi) {
    dpi = imageDpi
    source = 'metadata'
  } else {
    // Infer DPI from detected card content vs empirical reference
    // Reference: 1386×2005px at 600 DPI
    const widthDpi = (cardWidth / REF_CARD_WIDTH_600) * REF_DPI
    const heightDpi = (cardHeight / REF_CARD_HEIGHT_600) * REF_DPI
    dpi = Math.round((widthDpi + heightDpi) / 2) // average of both axes
    source = 'inferred'
  }

  return {
    cardWidth,
    cardHeight,
    dpiW: dpi,
    dpiH: dpi,
    effectiveDPI: dpi,
    meetsMinimum: dpi >= MIN_DPI,
    orientation: isPortrait ? 'portrait' : 'landscape',
    source
  }
}

/**
 * Detect if any card edges are flush with the image boundary.
 * Not a failure by itself — the card may legitimately fill the frame.
 * But combined with a dimension check, helps identify cut-off scans.
 */
function detectFlushEdges(edges, imageWidth, imageHeight) {
  const flush = []
  if (edges.top <= 0) flush.push('top')
  if (edges.bottom >= imageHeight - 1) flush.push('bottom')
  if (edges.left <= 0) flush.push('left')
  if (edges.right >= imageWidth - 1) flush.push('right')
  return { flush, hasFlush: flush.length > 0 }
}

/**
 * Scan and validate a card image.
 * 
 * @param {string|Buffer} image - Path to image file, or raw image buffer
 * @returns {Promise<object>} Scan result
 */
const LOG_DIR = path.join(process.env.HOME || '/root', '.openclaw', 'cardimg-scan')
const LOG_PATH = path.join(LOG_DIR, 'scan-log.json')
const JPEG_QUALITY = 90

/**
 * Append an entry to the scan log.
 * Log file: ~/.openclaw/cardimg-scan/scan-log.json
 */
function appendLog(entry) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
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
async function convertToJpeg(imageBuf, crop) {
  const sharp = require('sharp')
  let pipeline = sharp(imageBuf).rotate() // auto-orient based on EXIF
  if (crop) {
    pipeline = pipeline.extract({
      left: crop.left,
      top: crop.top,
      width: crop.width,
      height: crop.height
    })
  }
  const jpegBuf = await pipeline
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer()
  return jpegBuf
}

async function scanCard(image) {
  const imageBuf = typeof image === 'string' ? fs.readFileSync(image) : image
  const { format } = detectFormat(imageBuf)

  // Read DPI from image metadata (embedded by scanner)
  // Only trust metadata DPI ≥100 — JPEGs default to 72 which is not a real scanner reading
  let imageDpi = null
  try {
    const sharp = require('sharp')
    const meta = await sharp(imageBuf).metadata()
    if (meta.density && meta.density >= 100) imageDpi = meta.density
  } catch {}

  // Get pixel data from original image
  const pixels = await getPixels(imageBuf)
  const { width, height } = pixels

  // 1. Card edge detection
  const edges = detectCardEdges(pixels)

  // 2. Card DPI (from image metadata, trusted)
  const cardDpi = edges.found ? detectCardDPI(edges, imageDpi) : null

  // 3. Card dimension validation (absolute pixel size at detected DPI)
  const dimensions = edges.found ? validateCardDimensions(edges, cardDpi.effectiveDPI) : null

  // 4. Flush edge detection (informational)
  const flushEdges = edges.found ? detectFlushEdges(edges, width, height) : null

  // Overall pass/fail — dimension check is the real gate for card completeness
  const passed = edges.found
    && cardDpi.meetsMinimum
    && dimensions.valid

  // If passed, convert to JPEG for upload
  let uploadBuf = null
  let uploadHash = null
  let uploadSize = 0

  // Crop: if background margin on a side exceeds 5% of card width,
  // trim it to 5%. If less, keep the existing margin as-is.
  const MAX_MARGIN_RATIO = 0.05
  let crop = null
  if (passed && edges.found) {
    const maxMargin = Math.round(edges.cardWidth * MAX_MARGIN_RATIO)
    const leftMargin = edges.left
    const rightMargin = width - edges.right - 1
    const topMargin = edges.top
    const bottomMargin = height - edges.bottom - 1

    const cropLeft = leftMargin > maxMargin ? edges.left - maxMargin : 0
    const cropTop = topMargin > maxMargin ? edges.top - maxMargin : 0
    const cropRight = rightMargin > maxMargin ? edges.right + maxMargin : width
    const cropBottom = bottomMargin > maxMargin ? edges.bottom + maxMargin : height

    // Only crop if we're actually trimming something
    if (cropLeft > 0 || cropTop > 0 || cropRight < width || cropBottom < height) {
      crop = {
        left: Math.max(0, cropLeft),
        top: Math.max(0, cropTop),
        width: Math.min(width, cropRight) - Math.max(0, cropLeft),
        height: Math.min(height, cropBottom) - Math.max(0, cropTop)
      }
    }
  }

  if (passed) {
    uploadBuf = await convertToJpeg(imageBuf, crop)
    uploadHash = crypto.createHash('sha256').update(uploadBuf).digest('hex')
    uploadSize = uploadBuf.length

    // Save to cardimg-scan output dir
    const OUTPUT_DIR = path.join(__dirname, '..', 'output')
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
    const outPath = path.join(OUTPUT_DIR, `${uploadHash}.jpg`)
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
    dpi: cardDpi,
    edges,
    crop,
    dimensions,                   // { valid, orientation, aspect } or null
    flushEdges,                    // { flush, hasFlush } or null
    uploadBuffer: uploadBuf,
    checks: {
      resolution: cardDpi ? cardDpi.meetsMinimum : false,
      cardDetected: edges.found,
      dimensions: dimensions ? dimensions.valid : false
    },
    warnings: [
      ...(flushEdges && flushEdges.hasFlush ? [`Card is flush with image edge (${flushEdges.flush.join(', ')}) — verify card is not cut off`] : []),
    ],
    failures: [
      ...(!edges.found ? ['Card edges not detected'] : []),
      ...(edges.found && !cardDpi.meetsMinimum ? [`Scanner DPI ${cardDpi.effectiveDPI} (minimum ${MIN_DPI})`] : []),
      ...(edges.found && !dimensions.valid ? [dimensions.reason] : [])
    ]
  }
}

module.exports = {
  scanCard,
  detectDPI,
  detectCardDPI,
  detectCardEdges,
  validateCardDimensions,
  detectFlushEdges,
  detectFormat,
  getPixels,
  appendLog,
  MIN_DPI,
  REF_CARD_WIDTH_600,
  REF_CARD_HEIGHT_600,
  REF_DPI,
  CARD_SIZE_TOLERANCE
}
