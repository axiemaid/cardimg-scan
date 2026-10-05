/**
 * CARDIMG Scanner — Web Server
 * 
 * Web UI for scanning and uploading card images.
 * User selects file(s) → preview with confirm button → scan validates → if passed, upload to BSV automatically.
 * 
 * Depends on:
 *   - Trading Card Image Uploader (lib/cardimg.js) — for on-chain upload
 *   - BSV wallet skill — for the wallet
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const express = require('express')
const multer = require('multer')
const { scanCard, appendLog } = require('../lib/scan.js')

const upload = multer({ storage: multer.memoryStorage() })

// Try to load the uploader from cardimg-upload
let uploadCardImg = null
try {
  const cardimgUploadPath = path.join(process.env.HOME || '/root', '.openclaw', 'cardimg-upload', 'lib', 'cardimg.js')
  uploadCardImg = require(cardimgUploadPath).uploadCardImg
} catch (e) {
  console.warn('Warning: Trading Card Image Uploader not found. Uploads will be disabled.')
  console.warn('Install from: https://github.com/axiemaid/cardimg-upload')
  console.warn('Expected at: ~/.openclaw/cardimg-upload/lib/cardimg.js')
}

const DEFAULT_WALLET = path.join(process.env.HOME || '/root', '.openclaw', 'cardimg-scanner-wallet.json')
const DEFAULT_PORT = 3020

function createServer(port = DEFAULT_PORT) {
  const app = express()

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') return res.sendStatus(200)
    next()
  })

  app.post('/scan', upload.array('images', 50), async (req, res) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' })
    }

    const walletPath = req.body.wallet || DEFAULT_WALLET
    const results = []

    for (const file of req.files) {
      try {
        const scanResult = await scanCard(file.buffer)

        if (!scanResult.passed) {
          appendLog({
            timestamp: new Date().toISOString(),
            filename: file.originalname,
            passed: false,
            originalHash: scanResult.originalHash || scanResult.hash,
            originalSize: file.buffer.length,
            originalFormat: scanResult.format,
            width: scanResult.width,
            height: scanResult.height,
            dpi: scanResult.dpi.effectiveDPI,
            failures: scanResult.failures,
            txid: null,
            fee: null
          })
          results.push({
            filename: file.originalname,
            passed: false,
            hash: scanResult.hash,
            failures: scanResult.failures,
            dpi: scanResult.dpi.effectiveDPI,
            size: scanResult.size
          })
          continue
        }

        let uploadResult = null
        if (uploadCardImg && scanResult.uploadBuffer) {
          uploadResult = await uploadCardImg(scanResult.uploadBuffer, walletPath)
        } else if (uploadCardImg) {
          uploadResult = await uploadCardImg(file.buffer, walletPath)
        } else {
          uploadResult = { error: 'Uploader not installed' }
        }

        appendLog({
          timestamp: new Date().toISOString(),
          filename: file.originalname,
          passed: true,
          originalHash: scanResult.originalHash,
          uploadedHash: scanResult.hash,
          originalSize: scanResult.originalSize,
          originalFormat: scanResult.format,
          convertedSize: scanResult.size,
          convertedFormat: 'JPEG',
          width: scanResult.width,
          height: scanResult.height,
          dpi: scanResult.dpi.effectiveDPI,
          txid: uploadResult.txid,
          fee: uploadResult.fee
        })

        results.push({
          filename: file.originalname,
          passed: true,
          hash: scanResult.hash,
          dpi: scanResult.dpi.effectiveDPI,
          size: scanResult.size,
          originalSize: scanResult.originalSize,
          txid: uploadResult.txid,
          fee: uploadResult.fee
        })
      } catch (e) {
        appendLog({
          timestamp: new Date().toISOString(),
          filename: file.originalname,
          passed: false,
          error: e.message
        })
        results.push({
          filename: file.originalname,
          passed: false,
          error: e.message
        })
      }
    }

    res.json({ results })
  })

  app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.send(getHTML())
  })

  app.listen(port, () => {
    console.log('CARDIMG Scanner running at http://localhost:' + port)
    console.log('')
    if (uploadCardImg) {
      console.log('Uploader: ✓ connected')
    } else {
      console.log('Uploader: ✗ not found (install cardimg-upload)')
    }
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
    .upload-zone { border: 2px dashed #444; border-radius: 12px; padding: 48px 24px; text-align: center; cursor: pointer; transition: border-color 0.2s, background: 0.2s; }
    .upload-zone:hover { border-color: #6af; background: #1a1a2a; }
    .upload-zone.dragover { border-color: #4a4; background: #1a2a1a; }
    .upload-zone p { color: #888; margin-top: 8px; }
    .upload-zone .icon { font-size: 48px; }
    input[type=file] { display: none; }
    .results { margin-top: 24px; display: flex; flex-direction: column; gap: 12px; }
    .result { background: #1a1a1a; border-radius: 8px; padding: 16px; display: flex; gap: 16px; align-items: flex-start; }
    .result.passed { border-left: 4px solid #4a4; }
    .result.failed { border-left: 4px solid #f44; }
    .result.processing { border-left: 4px solid #6af; }
    .result.pending { border-left: 4px solid #888; }
    .result img { width: 120px; height: 120px; object-fit: cover; border-radius: 4px; background: #333; flex-shrink: 0; }
    .result .info { flex: 1; }
    .result .filename { font-weight: 600; margin-bottom: 4px; word-break: break-all; }
    .result .detail { font-size: 13px; color: #aaa; line-height: 1.5; }
    .result .status { font-weight: 600; }
    .result .status.pass { color: #4a4; }
    .result .status.fail { color: #f44; }
    .result .status.processing { color: #6af; }
    .result .status.pending { color: #888; }
    .result .txid { font-family: monospace; font-size: 12px; color: #6af; word-break: break-all; }
    .result a { color: #6af; text-decoration: none; }
    .result a:hover { text-decoration: underline; }
    .result .actions { margin-top: 8px; display: flex; gap: 8px; }
    .btn-confirm { background: #4a4; color: #fff; padding: 6px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
    .btn-confirm:hover { background: #5b5; }
    .btn-cancel { background: #444; color: #ccc; padding: 6px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
    .btn-cancel:hover { background: #555; }
    .progress { color: #6af; font-size: 14px; margin-top: 16px; }
    .empty { text-align: center; color: #555; padding: 40px; }
  </style>
</head>
<body>
  <h1>CARDIMG Scanner</h1>
  <p class="subtitle">Select card scans to validate and upload to BSV</p>

  <div class="upload-zone" id="dropzone">
    <div class="icon">📷</div>
    <p>Click to select files or drag and drop</p>
    <input type="file" id="fileInput" multiple accept="image/*">
  </div>

  <div class="results" id="results"></div>

  <script>
    const dropzone = document.getElementById('dropzone')
    const fileInput = document.getElementById('fileInput')
    const resultsDiv = document.getElementById('results')
    let pendingFiles = []

    dropzone.addEventListener('click', () => fileInput.click())

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault()
      dropzone.classList.add('dragover')
    })
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'))
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault()
      dropzone.classList.remove('dragover')
      handleFiles(e.dataTransfer.files)
    })

    fileInput.addEventListener('change', (e) => handleFiles(e.target.files))

    async function handleFiles(fileList) {
      const files = Array.from(fileList)
      if (files.length === 0) return

      resultsDiv.innerHTML = ''
      pendingFiles = files

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const div = document.createElement('div')
        div.className = 'result pending'
        const imgUrl = URL.createObjectURL(file)
        div.innerHTML = '<img src="' + imgUrl + '" alt="' + file.name + '">' +
          '<div class="info">' +
          '<div class="filename">' + file.name + '</div>' +
          '<div class="status pending">Awaiting confirmation</div>' +
          '<div class="detail">' + (file.size / 1024 / 1024).toFixed(1) + 'MB</div>' +
          '<div class="actions">' +
          '<button class="btn-confirm" onclick="confirmFile(' + i + ')">Confirm</button>' +
          '<button class="btn-cancel" onclick="cancelFile(this)">Cancel</button>' +
          '</div>' +
          '</div>'
        resultsDiv.appendChild(div)
      }
    }

    function cancelFile(btn) {
      const div = btn.closest('.result')
      div.remove()
    }

    async function confirmFile(fileIndex) {
      const file = pendingFiles[fileIndex]
      if (!file) return

      const div = resultsDiv.children[fileIndex]
      if (!div) return

      div.classList.remove('pending')
      div.classList.add('processing')
      div.querySelector('.info').innerHTML = '<div class="filename">' + file.name + '</div><div class="status processing">Processing...</div>'

      const formData = new FormData()
      formData.append('images', file)

      try {
        const res = await fetch('/scan', { method: 'POST', body: formData })
        const data = await res.json()
        const r = data.results[0]
        if (!r) return

        div.classList.remove('processing')
        div.classList.add(r.passed ? 'passed' : 'failed')

        if (r.passed) {
          let detail = '<div class="detail">'
          detail += 'DPI: ' + r.dpi + ' | '
          detail += 'Size: ' + (r.size / 1024).toFixed(1) + 'KB'
          if (r.originalSize && r.originalSize !== r.size) {
            detail += ' (from ' + (r.originalSize / 1024 / 1024).toFixed(1) + 'MB) | '
          } else {
            detail += ' | '
          }
          detail += 'Fee: ' + r.fee + ' sats'
          if (r.txid) {
            detail += '<br><span class="txid">TXID: ' + r.txid + '</span>'
            detail += '<br><a href="https://whatsonchain.com/tx/' + r.txid + '" target="_blank">View on WhatsOnChain →</a>'
          }
          detail += '</div>'
          div.querySelector('.info').innerHTML = '<div class="filename">' + r.filename + '</div><div class="status pass">✓ Passed — uploaded to BSV</div>' + detail
        } else {
          const reasons = r.failures ? r.failures.join(', ') : r.error || 'Unknown error'
          div.querySelector('.info').innerHTML = '<div class="filename">' + r.filename + '</div><div class="status fail">✗ Failed — ' + reasons + '</div><div class="detail">DPI: ' + (r.dpi || 'N/A') + ' | Size: ' + (r.size / 1024).toFixed(1) + 'KB</div>'
        }
      } catch (err) {
        div.classList.remove('processing')
        div.classList.add('failed')
        div.querySelector('.info').innerHTML = '<div class="filename">' + file.name + '</div><div class="status fail">✗ Error: ' + err.message + '</div>'
      }
    }
  </script>
</body>
</html>`
}

module.exports = { createServer }

// Run if called directly (not required as a module)
if (require.main === module) {
  createServer(DEFAULT_PORT)
}
