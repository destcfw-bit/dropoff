import http from 'http'
import { readFile, stat } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const publicDir = path.join(__dirname, 'public')
const port = Number(process.env.PORT || 3000)

const types = {
  '.html':'text/html; charset=utf-8',
  '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.png':'image/png',
  '.svg':'image/svg+xml',
  '.ico':'image/x-icon',
  '.webmanifest':'application/manifest+json; charset=utf-8',
  '.json':'application/json; charset=utf-8'
}

function send(res, code, type, body, cache='no-store'){
  res.writeHead(code, {
    'content-type': type,
    'cache-control': cache,
    'x-content-type-options':'nosniff',
    'referrer-policy':'same-origin'
  })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    const raw = decodeURIComponent(url.pathname)

    if (raw === '/health') {
      return send(res, 200, 'application/json; charset=utf-8',
        JSON.stringify({ok:true, service:'Drop Off', version:'3.0.0'}))
    }

    const isPortal = ['/', '/admin', '/captain', '/store'].some(
      p => raw === p || (p !== '/' && raw.startsWith(p + '/'))
    )

    let relative = isPortal ? 'index.html' : raw.replace(/^\/+/, '')
    let filePath = path.join(publicDir, path.normalize(relative))

    if (!filePath.startsWith(publicDir)) {
      filePath = path.join(publicDir, 'index.html')
    }

    try {
      const s = await stat(filePath)
      if (!s.isFile()) throw new Error('not_file')
    } catch {
      filePath = path.join(publicDir, 'index.html')
    }

    const body = await readFile(filePath)
    const ext = path.extname(filePath)
    const noCache = ['.html', '.js', '.css'].includes(ext)

    return send(
      res, 200, types[ext] || 'application/octet-stream',
      body, noCache ? 'no-store, max-age=0' : 'public, max-age=3600'
    )
  } catch (e) {
    return send(res, 500, 'application/json; charset=utf-8',
      JSON.stringify({ok:false, error:'server_error'}))
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`Drop Off v3 listening on ${port}`)
})
