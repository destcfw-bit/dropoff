import http from 'http'
import { readFile, stat } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const publicDir = path.join(__dirname, 'public')
const port = Number(process.env.PORT || 3000)
const types = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.webmanifest':'application/manifest+json; charset=utf-8','.json':'application/json; charset=utf-8'}

const server = http.createServer(async (req,res)=>{
  try{
    if(req.url === '/health'){
      res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'})
      return res.end(JSON.stringify({ok:true,service:'Drop Off'}))
    }
    const raw = decodeURIComponent((req.url || '/').split('?')[0])
    const safe = path.normalize(raw).replace(/^\.{2}(\/|\\|$)+/,'')
    let filePath = path.join(publicDir, safe === '/' ? 'index.html' : safe)
    if(!filePath.startsWith(publicDir)) filePath = path.join(publicDir,'index.html')
    try{
      const s=await stat(filePath)
      if(s.isDirectory()) filePath=path.join(filePath,'index.html')
      else if(!s.isFile()) throw new Error('not file')
    }catch{ filePath=path.join(publicDir,'index.html') }
    const body=await readFile(filePath)
    const ext=path.extname(filePath)
    res.writeHead(200,{'content-type':types[ext]||'application/octet-stream','cache-control':ext==='.html'?'no-cache':'public, max-age=3600'})
    res.end(body)
  }catch(e){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:'server_error'}))}
})
server.listen(port,'0.0.0.0',()=>console.log(`Drop Off listening on ${port}`))
