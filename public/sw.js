const CACHE='dropoff-v2-shell'
const ASSETS=['/','/admin','/store','/captain','/management','/styles.css','/ops-suite.css','/app.js','/ops-suite.js','/config.js','/manifest.webmanifest','/assets/dropoff-blue.png']
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).catch(()=>{}).then(()=>self.skipWaiting())))
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())))
self.addEventListener('fetch',e=>{
  const req=e.request
  if(req.method!=='GET')return
  const url=new URL(req.url)
  if(url.origin!==location.origin)return
  e.respondWith(fetch(req).then(r=>{
    const clone=r.clone()
    if(r.ok)caches.open(CACHE).then(c=>c.put(req,clone)).catch(()=>{})
    return r
  }).catch(()=>caches.match(req).then(r=>r||caches.match('/'))))
})
