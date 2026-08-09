// Service worker minimale per iAlgae.
//
// Nota: un motore di ricerca non può funzionare offline (serve sempre
// internet per cercare), quindi questo service worker NON implementa
// una vera cache offline. Esiste solo perché Chrome/Android richiedono
// un service worker registrato con un gestore "fetch" per considerare
// il sito "installabile" come app.

self.addEventListener('install', function (event) {
    self.skipWaiting();
});

self.addEventListener('activate', function (event) {
    event.waitUntil(self.clients.claim());
});

// Gestore fetch "passthrough": lascia che ogni richiesta vada normalmente
// in rete, senza intercettarla. È il minimo richiesto per soddisfare i
// criteri di installabilità.
self.addEventListener('fetch', function (event) {
    event.respondWith(fetch(event.request));
});
