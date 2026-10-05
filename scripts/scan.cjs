#!/usr/bin/env node
/**
 * CARDIMG Scanner CLI
 * 
 * Validates a card scan image before on-chain upload.
 * Checks: DPI, card edge detection, black background.
 * 
 * Usage:
 *   node scripts/scan.cjs <image_path>
 */

const { scanCard } = require('../lib/scan.js')

async function main() {
  const args = process.argv.slice(2)
  const imgPath = args.find(a => !a.startsWith('--'))

  if (!imgPath) {
    console.log('CARDIMG Scanner — validate card scans before upload')
    console.log('')
    console.log('Usage: node scan.cjs <image_path>')
    console.log('')
    console.log('Checks:')
    console.log('  - Resolution ≥ 600 DPI equivalent')
    console.log('  - Card edge detection (rectangular card in frame)')
    console.log('  - Black background')
    process.exit(1)
  }

  const fs = require('fs')
  if (!fs.existsSync(imgPath)) {
    console.error('File not found:', imgPath)
    process.exit(1)
  }

  console.log('Scanning', imgPath, '...')
  const result = await scanCard(imgPath)

  console.log('')
  console.log('=== Scan Result ===')
  console.log(`Format:     ${result.format}`)
  console.log(`Dimensions: ${result.width}×${result.height} px`)
  console.log(`Size:       ${(result.size / 1024).toFixed(1)}KB`)
  console.log(`SHA256:     ${result.hash}`)
  console.log('')
  console.log('DPI:')
  console.log(`  Effective: ${result.dpi.effectiveDPI} DPI`)
  console.log(`  Horizontal: ${result.dpi.dpiW} DPI`)
  console.log(`  Vertical:   ${result.dpi.dpiH} DPI`)
  console.log(`  Meets minimum (${600}): ${result.checks.resolution ? '✓' : '✗'}`)
  console.log('')
  console.log('Card detection:')
  console.log(`  Edges: top=${result.edges.top} bottom=${result.edges.bottom} left=${result.edges.left} right=${result.edges.right}`)
  console.log(`  Card size: ${result.edges.cardWidth}×${result.edges.cardHeight} px`)
  console.log(`  Detected: ${result.checks.cardDetected ? '✓' : '✗'}`)
  console.log('')
  console.log('Background:')
  console.log(`  Black ratio: ${Math.round(result.background.blackRatio * 100)}%`)
  console.log(`  Is black: ${result.checks.blackBackground ? '✓' : '✗'}`)
  console.log('')

  if (result.passed) {
    console.log('✓ PASSED — ready for upload')
    console.log('  Hash:', result.hash)
    console.log('  Upload with: node scripts/upload.cjs ' + imgPath)
  } else {
    console.log('✗ FAILED')
    for (const f of result.failures) {
      console.log('  -', f)
    }
  }
}

main().catch(e => {
  console.error('Error:', e.message)
  process.exit(1)
})
