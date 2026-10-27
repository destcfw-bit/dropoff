import http from 'http';
import {readFile} from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT||3000);

http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url||'/','http://localhost');
    if(url.pathname==='/health'){
      res.writeHead(200,{'content-type':'application/json'});
      return res.end(JSON.stringify({ok:true,service:'Drop Hub Preview'}));
    }
    const file=url.pathname==='/'?path.join(__dirname,'index.html'):path.join(__dirname,url.pathname.replace(/^\//,''));
    const safe=file.startsWith(__dirname)?file:path.join(__dirname,'index.html');
    let body;
    try{body=await readFile(safe)}catch{body=await readFile(path.join(__dirname,'index.html'))}
    const ext=path.extname(safe);
    const type=ext==='.html'?'text/html; charset=utf-8':'application/octet-stream';
    res.writeHead(200,{'content-type':type,'cache-control':'no-store'});
    res.end(body);
  }catch(e){
    res.writeHead(500,{'content-type':'text/plain; charset=utf-8'});
    res.end('Server error');
  }
}).listen(port,'0.0.0.0',()=>console.log('Drop Hub Preview listening on '+port));