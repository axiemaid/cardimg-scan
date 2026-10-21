/**
 * CARDIMG Scanner — Web Server
 * 
 * Web UI for scanning and uploading card images to BSV.
 * 
 * Batch flow:
 *   1. User selects multiple images (front, back, angles of a card)
 *   2. Each image is analyzed independently (validate, crop, JPEG convert)
 *   3. All must pass validation to upload as a batch
 *   4. One "Upload to BSV" button uploads all images + creates CARDSET binding
 *   5. Single image = just CARDIMG. 2+ images = CARDIMG + CARDSET.
 * 
 * Endpoints:
 *   POST /analyze  — validate + process, return results (no upload)
 *   POST /upload-all — upload all passed scans + create CARDSET if 2+
 *   GET  /preview/:scanId — serve processed JPEG
 *   POST /log-fail — log a failed scan
 * 
 * Depends on:
 *   - cardimg-upload (lib/cardimg.js) — for CARDIMG uploads
 *   - cardimg-bind (lib/cardimg-bind.js) — for CARDSET binding
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const express = require('express')
const multer = require('multer')
const { scanCard, appendLog } = require('../lib/scan.js')

const upload = multer({ storage: multer.memoryStorage() })

// Load the uploader
let uploadCardImg = null
try {
  const cardimgUploadPath = path.join(process.env.HOME || '/root', '.openclaw', 'cardimg-upload', 'lib', 'cardimg.js')
  uploadCardImg = require(cardimgUploadPath).uploadCardImg
} catch (e) {
  console.warn('Warning: cardimg-upload not found. Uploads disabled.')
  console.warn('Expected at: ~/.openclaw/cardimg-upload/lib/cardimg.js')
}

// Load the binder
let bindCardImages = null
try {
  const cardimgBindPath = path.join(process.env.HOME || '/root', '.openclaw', 'cardimg-bind', 'lib', 'cardimg-bind.js')
  bindCardImages = require(cardimgBindPath).bindCardImages
} catch (e) {
  console.warn('Warning: cardimg-bind not found. CARDSET binding disabled (single uploads only).')
  console.warn('Expected at: ~/.openclaw/cardimg-bind/lib/cardimg-bind.js')
}

const DEFAULT_WALLET = path.join(process.env.HOME || '/root', '.openclaw', 'cardimg-scanner-wallet.json')
const UPLOAD_QUEUE = path.join(process.env.HOME || '/root', '.openclaw', 'cardimg', 'upload-queue.json')

// Write txids to a queue file for the indexer to pick up
function queueTxids(txids) {
  try {
    let queue = []
    if (fs.existsSync(UPLOAD_QUEUE)) {
      queue = JSON.parse(fs.readFileSync(UPLOAD_QUEUE, 'utf8'))
      if (!Array.isArray(queue)) queue = []
    }
    for (const txid of txids) {
      if (!queue.includes(txid)) queue.push(txid)
    }
    fs.writeFileSync(UPLOAD_QUEUE, JSON.stringify(queue, null, 2))
  } catch (e) {
    console.error('Failed to write upload queue:', e.message)
  }
}
const DEFAULT_PORT = 3020

// In-memory store for processed images between analyze and upload
const processedScans = new Map()
const SCAN_TTL = 10 * 60 * 1000

setInterval(() => {
  const now = Date.now()
  for (const [id, entry] of processedScans) {
    if (now - entry.timestamp > SCAN_TTL) processedScans.delete(id)
  }
}, 60 * 1000)

function createServer(port = DEFAULT_PORT) {
  const app = express()

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') return res.sendStatus(200)
    next()
  })

  // Phase 1: Analyze — validate + process, no upload
  app.post('/analyze', upload.array('images', 50), async (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' })
    }

    const results = []
    for (const file of req.files) {
      try {
        const scanResult = await scanCard(file.buffer)
        const scanId = crypto.randomUUID()
        processedScans.set(scanId, {
          uploadBuffer: scanResult.uploadBuffer,
          originalBuffer: file.buffer,
          scanResult,
          filename: file.originalname,
          timestamp: Date.now()
        })
        results.push({
          scanId,
          filename: file.originalname,
          passed: scanResult.passed,
          hash: scanResult.hash,
          format: scanResult.format,
          width: scanResult.width,
          height: scanResult.height,
          size: scanResult.size,
          originalSize: scanResult.originalSize,
          imageDpi: scanResult.dpi ? scanResult.dpi.effectiveDPI : null,
          cardWidth: scanResult.edges ? scanResult.edges.cardWidth : null,
          cardHeight: scanResult.edges ? scanResult.edges.cardHeight : null,
          warnings: scanResult.warnings,
          failures: scanResult.failures,
          checks: scanResult.checks
        })
      } catch (e) {
        results.push({ filename: file.originalname, passed: false, error: e.message })
      }
    }
    res.json({ results })
  })

  // Phase 2: Upload all — upload each CARDIMG, then create CARDSET if 2+
  app.post('/upload-all', express.json(), async (req, res) => {
    const { scanIds } = req.body
    const walletPath = req.body.wallet || DEFAULT_WALLET

    if (!scanIds || !Array.isArray(scanIds) || scanIds.length === 0) {
      return res.status(400).json({ error: 'No scanIds provided' })
    }

    // Track spent outpoints across all uploads + bind in this batch
    const spentOutpoints = new Set()
    const extraUtxos = []  // unconfirmed change outputs from uploads
    const uploaded = []
    const errors = []

    // Upload each image
    for (const scanId of scanIds) {
      const entry = processedScans.get(scanId)
      if (!entry) {
        errors.push({ scanId, error: 'Scan not found or expired' })
        continue
      }
      if (!entry.scanResult.passed) {
        errors.push({ scanId, error: 'Scan did not pass validation' })
        continue
      }

      try {
        const imageBuf = entry.uploadBuffer || entry.originalBuffer
        const result = await uploadCardImg(imageBuf, walletPath, { spentOutpoints })
        // Defensive: clean txid in case broadcast returns quoted/newlined string
        const cleanTxid = typeof result.txid === 'string' ? result.txid.trim().replace(/^["']+|["']+$/g, '') : result.txid
        uploaded.push({
          scanId,
          filename: entry.filename,
          hash: result.hash,
          txid: cleanTxid,
          fee: result.fee,
          size: entry.scanResult.size
        })

        // Collect change output for the bind step
        if (result.changeUtxo) {
          extraUtxos.push(result.changeUtxo)
        }

        // Log to scan log
        appendLog({
          timestamp: new Date().toISOString(),
          filename: entry.filename,
          passed: true,
          originalHash: entry.scanResult.originalHash,
          uploadedHash: result.hash,
          originalSize: entry.scanResult.originalSize,
          originalFormat: entry.scanResult.format,
          convertedSize: entry.scanResult.size,
          convertedFormat: 'JPEG',
          width: entry.scanResult.width,
          height: entry.scanResult.height,
          cardWidth: entry.scanResult.edges.cardWidth,
          cardHeight: entry.scanResult.edges.cardHeight,
          imageDpi: entry.scanResult.dpi.effectiveDPI,
          dimensions: entry.scanResult.dimensions,
          flushEdges: entry.scanResult.flushEdges,
          warnings: entry.scanResult.warnings,
          cropped: entry.scanResult.crop ? true : false,
          crop: entry.scanResult.crop || null,
          txid: result.txid,
          fee: result.fee
        })

        processedScans.delete(scanId)
      } catch (e) {
        errors.push({ scanId, filename: entry.filename, error: e.message })
      }
    }

    // Create CARDSET if 2+ images uploaded successfully
    let cardset = null
    if (uploaded.length >= 2 && bindCardImages) {
      try {
        const txids = uploaded.map(u => u.txid)
        const bindResult = await bindCardImages(txids, walletPath, { spentOutpoints, extraUtxos })
        cardset = {
          txid: bindResult.txid,
          txidCount: bindResult.txidCount,
          fee: bindResult.fee
        }
      } catch (e) {
        // Images are already on-chain — binding failed but uploads succeeded
        errors.push({ error: 'CARDSET binding failed: ' + e.message + '. Images are uploaded but not linked.' })
      }
    }

    // Queue all txids for indexer backfill
    const allTxids = [...uploaded.map(u => u.txid)]
    if (cardset) allTxids.push(cardset.txid)
    if (allTxids.length > 0) queueTxids(allTxids)

    res.json({ uploaded, errors, cardset })
  })

  // Preview
  app.get('/preview/:scanId', (req, res) => {
    const entry = processedScans.get(req.params.scanId)
    if (!entry) return res.status(404).json({ error: 'Scan not found or expired' })
    const buf = entry.uploadBuffer || entry.originalBuffer
    if (!buf) return res.status(404).json({ error: 'No processed image available' })
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.send(buf)
  })

  // Log failed scans
  app.post('/log-fail', express.json(), (req, res) => {
    const { scanId } = req.body
    const entry = processedScans.get(scanId)
    if (entry) {
      appendLog({
        timestamp: new Date().toISOString(),
        filename: entry.filename,
        passed: false,
        originalHash: entry.scanResult.originalHash || entry.scanResult.hash,
        originalSize: entry.scanResult.originalSize,
        originalFormat: entry.scanResult.format,
        width: entry.scanResult.width,
        height: entry.scanResult.height,
        imageDpi: entry.scanResult.dpi ? entry.scanResult.dpi.effectiveDPI : null,
        cardWidth: entry.scanResult.edges ? entry.scanResult.edges.cardWidth : null,
        cardHeight: entry.scanResult.edges ? entry.scanResult.edges.cardHeight : null,
        dimensions: entry.scanResult.dimensions,
        flushEdges: entry.scanResult.flushEdges,
        warnings: entry.scanResult.warnings,
        failures: entry.scanResult.failures,
        txid: null,
        fee: null
      })
      processedScans.delete(scanId)
    }
    res.json({ success: true })
  })

  app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.send(getHTML())
  })

  app.listen(port, () => {
    console.log('CARDIMG Scanner running at http://localhost:' + port)
    console.log('')
    console.log('Uploader: ' + (uploadCardImg ? '✓ connected' : '✗ not found'))
    console.log('Binder:   ' + (bindCardImages ? '✓ connected' : '✗ not found (single uploads only)'))
    console.log('')
    console.log('Open http://localhost:' + port + ' in your browser')
  })

  return app
}

function getHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CARDIMG Scanner</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f0f0f; color: #eee; min-height: 100vh; padding: 20px; }
    h1 { color: #fff; margin-bottom: 8px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
    .upload-zone { border: 2px dashed #444; border-radius: 12px; padding: 48px 24px; text-align: center; cursor: pointer; transition: border-color 0.2s; }
    .upload-zone:hover { border-color: #6af; background: #1a1a2a; }
    .upload-zone.dragover { border-color: #4a4; background: #1a2a1a; }
    .upload-zone p { color: #888; margin-top: 8px; }
    .upload-zone .icon { font-size: 48px; }
    input[type=file] { display: none; }
    .results { margin-top: 24px; display: flex; flex-direction: column; gap: 12px; }
    .result { background: #1a1a1a; border-radius: 8px; padding: 16px; display: flex; gap: 16px; align-items: flex-start; }
    .result.passed { border-left: 4px solid #4a4; }
    .result.failed { border-left: 4px solid #f44; }
    .result.analyzing { border-left: 4px solid #6af; }
    .result.ready { border-left: 4px solid #6af; }
    .result.uploading { border-left: 4px solid #fa0; }
    .result .preview { flex-shrink: 0; }
    .result .preview img { max-width: 280px; max-height: 400px; border-radius: 4px; background: #333; display: block; }
    .result .preview .label { font-size: 10px; color: #666; text-align: center; margin-top: 4px; }
    .result .info { flex: 1; }
    .result .filename { font-weight: 600; margin-bottom: 4px; word-break: break-all; }
    .result .detail { font-size: 13px; color: #aaa; line-height: 1.6; }
    .result .detail .label { color: #666; }
    .result .status { font-weight: 600; margin-bottom: 4px; }
    .result .status.pass { color: #4a4; }
    .result .status.fail { color: #f44; }
    .result .status.analyzing { color: #6af; }
    .result .status.ready { color: #6af; }
    .result .status.uploading { color: #fa0; }
    .result .txid { font-family: monospace; font-size: 12px; color: #6af; word-break: break-all; }
    .result a { color: #6af; text-decoration: none; }
    .result a:hover { text-decoration: underline; }
    .result .actions { margin-top: 8px; display: flex; gap: 8px; }
    .btn-confirm { background: #4a4; color: #fff; padding: 8px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
    .btn-confirm:hover { background: #5b5; }
    .btn-confirm:disabled { background: #333; color: #666; cursor: not-allowed; }
    .btn-cancel { background: #444; color: #ccc; padding: 8px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
    .btn-cancel:hover { background: #555; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #6af; border-top: 2px solid transparent; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .check-grid { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; font-size: 13px; }
    .check-grid .label { color: #666; }
    .check-grid .value { color: #ccc; }
    .warn { color: #fa0; }
    .fail-text { color: #f66; }
    .pass-text { color: #4a4; }
    .batch-bar { margin-top: 16px; padding: 16px; background: #1a1a2e; border-radius: 8px; border: 1px solid #334; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .batch-bar.hidden { display: none; }
    .batch-info { color: #aac; font-size: 14px; }
    .batch-info strong { color: #fff; }
    .btn-upload-all { background: #4a4; color: #fff; padding: 12px 32px; border: none; border-radius: 6px; cursor: pointer; font-size: 16px; font-weight: 600; }
    .btn-upload-all:hover { background: #5b5; }
    .btn-upload-all:disabled { background: #333; color: #666; cursor: not-allowed; }
    .summary { margin-top: 16px; padding: 16px; background: #1a2a1a; border-radius: 8px; border: 1px solid #3a3; }
    .summary.hidden { display: none; }
    .summary h2 { color: #4a4; margin-bottom: 8px; font-size: 18px; }
    .summary .cardset-txid { font-family: monospace; font-size: 13px; color: #6af; word-break: break-all; }
  </style>
</head>
<body>
  <h1>CARDIMG Scanner</h1>
  <p class="subtitle">Select card scans to validate and upload. Multiple images in one batch are automatically linked via CARDSET.</p>

  <div class="upload-zone" id="dropzone">
    <div class="icon">📷</div>
    <p>Click to select files or drag and drop</p>
    <input type="file" id="fileInput" multiple accept="image/*">
  </div>

  <div class="results" id="results"></div>

  <div class="batch-bar hidden" id="batchBar">
    <div class="batch-info" id="batchInfo"></div>
    <button class="btn-upload-all" id="btnUploadAll" disabled>Upload All to BSV</button>
  </div>

  <div class="summary hidden" id="summary"></div>

  <script>
    const dropzone = document.getElementById('dropzone')
    const fileInput = document.getElementById('fileInput')
    const resultsDiv = document.getElementById('results')
    const batchBar = document.getElementById('batchBar')
    const batchInfo = document.getElementById('batchInfo')
    const btnUploadAll = document.getElementById('btnUploadAll')
    const summaryDiv = document.getElementById('summary')
    const scans = []

    dropzone.addEventListener('click', () => fileInput.click())
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover') })
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'))
    dropzone.addEventListener('drop', (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); handleFiles(e.dataTransfer.files) })
    fileInput.addEventListener('change', (e) => handleFiles(e.target.files))

    async function handleFiles(fileList) {
      const files = Array.from(fileList)
      if (files.length === 0) return

      for (const file of files) {
        const idx = scans.length
        const div = document.createElement('div')
        div.className = 'result analyzing'
        const imgUrl = URL.createObjectURL(file)
        div.innerHTML =
          '<div class="preview"><img src="' + imgUrl + '" alt="original" style="opacity:0.5"></div>' +
          '<div class="info">' +
            '<div class="filename">' + file.name + '</div>' +
            '<div class="status analyzing"><span class="spinner"></span>Analyzing...</div>' +
            '<div class="detail">' + (file.size / 1024 / 1024).toFixed(1) + 'MB</div>' +
          '</div>'
        resultsDiv.appendChild(div)
        scans.push({ file, div, scanId: null, result: null })
        analyzeFile(idx)
      }
    }

    async function analyzeFile(idx) {
      const scan = scans[idx]
      if (!scan) return
      const { file, div } = scan

      const formData = new FormData()
      formData.append('images', file)

      try {
        const res = await fetch('/analyze', { method: 'POST', body: formData })
        const data = await res.json()
        const r = data.results[0]
        if (!r) {
          div.classList.remove('analyzing')
          div.classList.add('failed')
          div.querySelector('.info').innerHTML = '<div class="filename">' + file.name + '</div><div class="status fail">✗ No result returned</div>'
          updateBatchBar()
          return
        }

        scan.scanId = r.scanId
        scan.result = r
        div.classList.remove('analyzing')
        div.classList.add(r.passed ? 'ready' : 'failed')

        if (r.passed) {
          const preview = div.querySelector('.preview')
          if (preview) {
            preview.innerHTML = '<img src="/preview/' + r.scanId + '" alt="processed"><div class="label">Processed</div>'
          }
          let html = '<div class="filename">' + r.filename + '</div>'
          html += '<div class="status ready">✓ Validation passed</div>'
          html += '<div class="detail"><div class="check-grid">'
          html += '<span class="label">Image DPI:</span><span class="value pass-text">' + (r.imageDpi || 'N/A') + ' DPI</span>'
          html += '<span class="label">Card size:</span><span class="value">' + (r.cardWidth || '?') + '×' + (r.cardHeight || '?') + ' px</span>'
          html += '<span class="label">Upload size:</span><span class="value">' + (r.size / 1024).toFixed(1) + 'KB</span>'
          html += '</div></div>'
          if (r.warnings && r.warnings.length > 0) {
            html += '<div class="warn">⚠ ' + r.warnings.join('; ') + '</div>'
          }
          html += '<div class="actions">'
          html += '<button class="btn-cancel" onclick="removeScan(' + idx + ')">Remove</button>'
          html += '</div>'
          div.querySelector('.info').innerHTML = html
        } else {
          if (r.scanId) {
            const preview = div.querySelector('.preview')
            if (preview) {
              preview.innerHTML = '<img src="/preview/' + r.scanId + '" alt="processed"><div class="label">Processed</div>'
            }
          }
          let html = '<div class="filename">' + r.filename + '</div>'
          html += '<div class="status fail">✗ Validation failed</div>'
          html += '<div class="detail"><div class="check-grid">'
          if (r.imageDpi) {
            html += '<span class="label">Image DPI:</span><span class="value fail-text">' + r.imageDpi + ' DPI</span>'
          }
          html += '</div></div>'
          html += '<div class="fail-text">Failures:</div>'
          for (const f of (r.failures || [])) {
            html += '<div class="fail-text">• ' + f + '</div>'
          }
          if (r.warnings && r.warnings.length > 0) {
            html += '<div class="warn">⚠ ' + r.warnings.join('; ') + '</div>'
          }
          html += '<div class="actions">'
          html += '<button class="btn-cancel" onclick="removeScan(' + idx + ')">Dismiss</button>'
          html += '</div>'
          div.querySelector('.info').innerHTML = html
        }
        updateBatchBar()
      } catch (err) {
        div.classList.remove('analyzing')
        div.classList.add('failed')
        div.querySelector('.info').innerHTML = '<div class="filename">' + file.name + '</div><div class="status fail">✗ Error: ' + err.message + '</div>'
        updateBatchBar()
      }
    }

    function removeScan(idx) {
      const scan = scans[idx]
      if (!scan) return
      if (scan.scanId && scan.result && !scan.result.passed) {
        fetch('/log-fail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scanId: scan.scanId })
        })
      }
      scan.div.remove()
      scans[idx] = null
      updateBatchBar()
    }

    function updateBatchBar() {
      const active = scans.filter(s => s !== null)
      const passed = active.filter(s => s.result && s.result.passed)
      const failed = active.filter(s => s.result && !s.result.passed)
      const analyzing = active.filter(s => !s.result)

      if (active.length === 0) {
        batchBar.classList.add('hidden')
        return
      }

      batchBar.classList.remove('hidden')

      let info = ''
      if (analyzing.length > 0) {
        info = 'Analyzing ' + analyzing.length + ' image(s)...'
        btnUploadAll.disabled = true
      } else if (failed.length > 0) {
        info = '<strong>' + passed.length + '</strong> passed, <strong>' + failed.length + '</strong> failed — fix or remove failed images to upload'
        btnUploadAll.disabled = true
      } else if (passed.length > 0) {
        if (passed.length === 1) {
          info = '<strong>1</strong> image ready to upload'
          btnUploadAll.textContent = 'Upload to BSV'
        } else {
          info = '<strong>' + passed.length + '</strong> images ready — will be uploaded and linked via CARDSET'
          btnUploadAll.textContent = 'Upload All to BSV'
        }
        btnUploadAll.disabled = false
      } else {
        info = 'No images ready'
        btnUploadAll.disabled = true
      }
      batchInfo.innerHTML = info
    }

    btnUploadAll.addEventListener('click', async () => {
      const passed = scans.filter(s => s && s.result && s.result.passed && s.scanId)
      if (passed.length === 0) return

      btnUploadAll.disabled = true
      btnUploadAll.textContent = 'Uploading...'

      // Mark all as uploading
      for (const scan of passed) {
        scan.div.classList.remove('ready')
        scan.div.classList.add('uploading')
        scan.div.querySelector('.status').className = 'status uploading'
        scan.div.querySelector('.status').innerHTML = '<span class="spinner"></span>Uploading...'
        const btns = scan.div.querySelectorAll('.btn-cancel')
        btns.forEach(b => b.disabled = true)
      }

      try {
        const res = await fetch('/upload-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scanIds: passed.map(s => s.scanId) })
        })
        const data = await res.json()

        // Update each uploaded scan
        for (const scan of passed) {
          const upload = data.uploaded.find(u => u.scanId === scan.scanId)
          if (upload) {
            scan.div.classList.remove('uploading')
            scan.div.classList.add('passed')
            let html = '<div class="filename">' + upload.filename + '</div>'
            html += '<div class="status pass">✓ Uploaded</div>'
            html += '<div class="detail">'
            html += '<span class="label">TXID:</span> <span class="txid">' + upload.txid + '</span><br>'
            html += '<span class="label">Fee:</span> ' + upload.fee + ' sats<br>'
            html += '<span class="label">Size:</span> ' + (upload.size / 1024).toFixed(1) + 'KB<br>'
            html += '<a href="https://whatsonchain.com/tx/' + upload.txid + '" target="_blank">View on WhatsOnChain →</a>'
            html += '</div>'
            scan.div.querySelector('.info').innerHTML = html
          } else {
            const err = data.errors.find(e => e.scanId === scan.scanId)
            scan.div.classList.remove('uploading')
            scan.div.classList.add('failed')
            scan.div.querySelector('.status').className = 'status fail'
            scan.div.querySelector('.status').textContent = '✗ Upload failed: ' + (err ? err.error : 'unknown')
          }
        }

        // Show summary
        if (data.uploaded.length > 0) {
          let html = '<h2>✓ Batch complete</h2>'
          html += '<div class="detail">'
          html += '<strong>' + data.uploaded.length + '</strong> image(s) uploaded'
          if (data.cardset) {
            html += ' + <strong>CARDSET</strong> created linking ' + data.cardset.hashCount + ' images'
            html += '<br><span class="label">CARDSET TXID:</span> <span class="cardset-txid">' + data.cardset.txid + '</span>'
            html += '<br><span class="label">Bind fee:</span> ' + data.cardset.fee + ' sats'
            html += '<br><a href="https://whatsonchain.com/tx/' + data.cardset.txid + '" target="_blank">View CARDSET on WhatsOnChain →</a>'
          }
          totalFee = data.uploaded.reduce((sum, u) => sum + u.fee, 0)
          if (data.cardset) totalFee += data.cardset.fee
          html += '<br><span class="label">Total fees:</span> ' + totalFee + ' sats'
          html += '</div>'
          summaryDiv.innerHTML = html
          summaryDiv.classList.remove('hidden')
        }

        batchBar.classList.add('hidden')
      } catch (err) {
        for (const scan of passed) {
          scan.div.classList.remove('uploading')
          scan.div.classList.add('failed')
          scan.div.querySelector('.status').className = 'status fail'
          scan.div.querySelector('.status').textContent = '✗ Error: ' + err.message
        }
        batchInfo.innerHTML = '✗ Upload error: ' + err.message
        btnUploadAll.disabled = false
        btnUploadAll.textContent = 'Upload All to BSV'
      }
    })
  </script>
</body>
</html>`
}

module.exports = { createServer }

if (require.main === module) {
  createServer(DEFAULT_PORT)
}
