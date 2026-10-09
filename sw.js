const CACHE = 'irrigacao-v13';

// Arquivos do próprio app
const ARQUIVOS_APP = [
  './',
  './index.html',
  './supabase-config.js',
  './supabase-api.js',
  './logo.png'
];

// Bibliotecas externas (CDNs). Alguns CDNs não liberam CORS, então são guardadas
// como resposta "opaca" (no-cors) — funcionam normalmente em <script>.
const ARQUIVOS_CDN = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@latest',
  'https://unpkg.com/html-to-image@1.11.11/dist/html-to-image.js'
];

// Guarda cada arquivo separadamente: se um falhar, os outros continuam
async function guardar(cache, url, opcoes) {
  try {
    const resp = await fetch(new Request(url, opcoes));
    if (resp.ok || resp.type === 'opaque') await cache.put(url, resp);
  } catch (e) {
    console.warn('Não foi possível guardar no cache:', url, e);
  }
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all([
      ...ARQUIVOS_APP.map(url => guardar(cache, url, { cache: 'reload' })),
      ...ARQUIVOS_CDN.map(url => guardar(cache, url, { mode: 'no-cors' }))
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Chamadas ao banco (Supabase) sempre vão direto para a rede
  if (url.hostname.endsWith('.supabase.co')) return;

  // Arquivos do app: primeiro a internet (sempre a versão mais nova publicada);
  // sem conexão, usa a cópia guardada
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const resp = await fetch(e.request);
        if (resp.ok) cache.put(e.request, resp.clone());
        return resp;
      } catch (err) {
        const copia = await cache.match(e.request, { ignoreSearch: true });
        if (copia) return copia;
        if (e.request.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
        return Response.error();
      }
    })());
    return;
  }

  // Bibliotecas externas: primeiro a cópia guardada (não mudam de versão)
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const copia = await cache.match(e.request.url);
    if (copia) return copia;
    try {
      const resp = await fetch(e.request);
      if (resp.ok || resp.type === 'opaque') cache.put(e.request.url, resp.clone());
      return resp;
    } catch (err) {
      return Response.error();
    }
  })());
});
