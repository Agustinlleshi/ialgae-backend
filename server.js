// Server per iAlgae — versione a FILE UNICO, senza dipendenze esterne.
// Usa solo moduli integrati in Node.js (http + fetch), quindi non serve npm install.
//
// Espone quattro endpoint:
//   POST /api/ask       -> risponde alle domande usando l'API di Anthropic (Claude)
//   POST /api/vision    -> analizza un'immagine caricata (iAlgae Lens) usando Claude,
//                          che ha capacità di visione (il backend è già collegato a
//                          Claude, quindi riusiamo lo stesso, non usiamo Gemini di Google)
//   GET  /api/suggest   -> restituisce suggerimenti di ricerca reali (proxy verso DuckDuckGo,
//                          necessario perché il browser da solo non può chiamarlo per via del CORS)
//   GET  /api/search    -> restituisce risultati di ricerca web reali (proxy verso Brave Search API),
//                          usati dalla pagina dei risultati (results.html) per mostrare i risultati
//                          dentro iAlgae invece di rimandare a Google
//
// COME PUBBLICARLO SU RENDER.COM:
// 1. Crea un "Web Service" su Render.com e carica solo questo file (server.js).
// 2. Nelle impostazioni del servizio imposta:
//      - Environment: Node
//      - Build Command: (lascialo VUOTO, non serve)
//      - Start Command: node server.js
// 3. In "Environment Variables" aggiungi:
//      - ANTHROPIC_API_KEY = la tua chiave API di Anthropic
//      - BRAVE_API_KEY = la tua chiave gratuita di Brave Search API (vedi nota sotto)
// 4. Fai il deploy. Render ti darà un indirizzo tipo:
//      https://ialgae-ai-backend.onrender.com
//    Gli endpoint da usare nel sito saranno:
//      https://ialgae-ai-backend.onrender.com/api/ask
//      https://ialgae-ai-backend.onrender.com/api/vision
//      https://ialgae-ai-backend.onrender.com/api/suggest
//      https://ialgae-ai-backend.onrender.com/api/search
//
// NOTA SU BRAVE_API_KEY:
// A differenza di Frankfurter/Open-Meteo/DuckDuckGo (usati altrove nel sito),
// non esiste un servizio di ricerca web reale completamente gratuito e senza
// registrazione. Brave Search API offre un piano gratuito (circa 2.000 ricerche
// al mese) pensato apposta per piccoli siti come questo. Per ottenerla:
// 1. Vai su https://api.search.brave.com/register
// 2. Crea un account gratuito e genera una API Key dalla dashboard
// 3. Incollala qui sopra come variabile d'ambiente BRAVE_API_KEY

const http = require('http');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const MAX_QUESTION_LENGTH = 2000;
const MAX_IMAGE_BASE64_LENGTH = 6000000; // ~4.5 MB di immagine decodificata
const RESULTS_PER_PAGE = 10;

function extractHost(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
        return url || '';
    }
}

function sendJSON(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(body);
}

const server = http.createServer((req, res) => {
    // Richiesta preliminare CORS del browser
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        return res.end();
    }

    // Pagina di controllo per verificare che il server sia attivo
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Server iAlgae attivo. Endpoint disponibili: POST /api/ask , GET /api/suggest?q=...');
    }

    // Endpoint suggerimenti di ricerca in tempo reale (proxy verso DuckDuckGo)
    if (req.method === 'GET' && req.url.indexOf('/api/suggest') === 0) {
        (async function () {
            try {
                const fullUrl = new URL(req.url, 'http://localhost');
                const q = (fullUrl.searchParams.get('q') || '').trim();

                if (!q) {
                    return sendJSON(res, 200, { suggestions: [] });
                }

                const ddgResponse = await fetch(
                    'https://duckduckgo.com/ac/?q=' + encodeURIComponent(q) + '&type=list',
                    { headers: { 'User-Agent': 'Mozilla/5.0' } }
                );

                if (!ddgResponse.ok) {
                    return sendJSON(res, 200, { suggestions: [] });
                }

                const data = await ddgResponse.json();
                const suggestions = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];

                return sendJSON(res, 200, { suggestions: suggestions });

            } catch (err) {
                console.error('Errore suggerimenti:', err);
                return sendJSON(res, 200, { suggestions: [] });
            }
        })();
        return;
    }

    // Endpoint principale usato dal sito (supporta conversazioni multi-turno)
    if (req.method === 'POST' && req.url === '/api/ask') {
        let body = '';
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', async function () {
            try {
                let payload;
                try {
                    payload = JSON.parse(body || '{}');
                } catch (parseErr) {
                    return sendJSON(res, 400, { error: 'Corpo della richiesta non valido.' });
                }

                const question = payload.question;
                let messages = payload.messages;

                if (!question || typeof question !== 'string' || !question.trim()) {
                    return sendJSON(res, 400, { error: 'Domanda mancante o non valida.' });
                }
                if (question.length > MAX_QUESTION_LENGTH) {
                    return sendJSON(res, 400, { error: 'Domanda troppo lunga.' });
                }
                if (!ANTHROPIC_API_KEY) {
                    return sendJSON(res, 500, { error: 'Chiave API non configurata sul server.' });
                }

                // Se il sito invia l'intera cronologia della conversazione, la usiamo
                // per mantenere il contesto tra più domande; altrimenti si usa solo
                // l'ultima domanda (compatibilità con versioni precedenti del sito).
                let anthropicMessages;
                if (Array.isArray(messages) && messages.length > 0) {
                    const validRoles = ['user', 'assistant'];
                    const cleaned = messages
                        .filter(function (m) {
                            return m && validRoles.indexOf(m.role) !== -1 && typeof m.content === 'string' && m.content.trim();
                        })
                        .slice(-20)
                        .map(function (m) {
                            return { role: m.role, content: m.content.slice(0, MAX_QUESTION_LENGTH) };
                        });

                    if (cleaned.length === 0) {
                        anthropicMessages = [{ role: 'user', content: question.trim() }];
                    } else {
                        anthropicMessages = cleaned;
                    }
                } else {
                    anthropicMessages = [{ role: 'user', content: question.trim() }];
                }

                const response = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': ANTHROPIC_API_KEY,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify({
                        model: ANTHROPIC_MODEL,
                        max_tokens: 1000,
                        messages: anthropicMessages
                    })
                });

                if (!response.ok) {
                    const errText = await response.text();
                    console.error('Errore da Anthropic API:', response.status, errText);
                    return sendJSON(res, 502, { error: 'Errore nel contattare il servizio IA. Riprova più tardi.' });
                }

                const data = await response.json();
                const answer = (data.content || [])
                    .map(function (block) { return block.type === 'text' ? block.text : ''; })
                    .filter(Boolean)
                    .join('\n');

                return sendJSON(res, 200, { answer: answer || 'Nessuna risposta ricevuta.' });

            } catch (err) {
                console.error('Errore interno:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Endpoint iAlgae Lens: analizza un'immagine caricata + una domanda contestuale
    if (req.method === 'POST' && req.url === '/api/vision') {
        let body = '';
        let tooLarge = false;
        req.on('data', function (chunk) {
            body += chunk;
            if (body.length > MAX_IMAGE_BASE64_LENGTH) {
                tooLarge = true;
                req.destroy();
            }
        });
        req.on('end', async function () {
            if (tooLarge) {
                return sendJSON(res, 413, { error: 'Immagine troppo grande.' });
            }
            try {
                let payload;
                try {
                    payload = JSON.parse(body || '{}');
                } catch (parseErr) {
                    return sendJSON(res, 400, { error: 'Corpo della richiesta non valido.' });
                }

                const question = (payload.question || 'Descrivi questa immagine.').toString();
                const imageBase64 = payload.imageBase64;
                const mediaType = payload.mediaType || 'image/jpeg';

                if (!imageBase64 || typeof imageBase64 !== 'string') {
                    return sendJSON(res, 400, { error: 'Immagine mancante.' });
                }
                if (question.length > MAX_QUESTION_LENGTH) {
                    return sendJSON(res, 400, { error: 'Domanda troppo lunga.' });
                }
                const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
                if (allowedTypes.indexOf(mediaType) === -1) {
                    return sendJSON(res, 400, { error: 'Formato immagine non supportato.' });
                }
                if (!ANTHROPIC_API_KEY) {
                    return sendJSON(res, 500, { error: 'Chiave API non configurata sul server.' });
                }

                const response = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': ANTHROPIC_API_KEY,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify({
                        model: ANTHROPIC_MODEL,
                        max_tokens: 1000,
                        messages: [{
                            role: 'user',
                            content: [
                                { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
                                { type: 'text', text: question.trim() }
                            ]
                        }]
                    })
                });

                if (!response.ok) {
                    const errText = await response.text();
                    console.error('Errore da Anthropic API (vision):', response.status, errText);
                    return sendJSON(res, 502, { error: 'Errore nel contattare il servizio IA. Riprova più tardi.' });
                }

                const data = await response.json();
                const answer = (data.content || [])
                    .map(function (block) { return block.type === 'text' ? block.text : ''; })
                    .filter(Boolean)
                    .join('\n');

                return sendJSON(res, 200, { answer: answer || 'Nessuna risposta ricevuta.' });

            } catch (err) {
                console.error('Errore interno (vision):', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Endpoint risultati di ricerca reali (proxy verso Brave Search API)
    if (req.method === 'GET' && req.url.indexOf('/api/search') === 0) {
        (async function () {
            try {
                const fullUrl = new URL(req.url, 'http://localhost');
                const q = (fullUrl.searchParams.get('q') || '').trim();
                let page = parseInt(fullUrl.searchParams.get('page'), 10);
                if (!page || page < 1) page = 1;
                if (page > 10) page = 10; // limitiamo a 10 pagine, come richiesto

                const allowedTypes = ['web', 'images', 'news', 'videos'];
                let type = (fullUrl.searchParams.get('type') || 'web').toLowerCase();
                if (allowedTypes.indexOf(type) === -1) type = 'web';

                if (!q) {
                    return sendJSON(res, 200, { results: [], totalPages: 0, page: page, type: type });
                }

                if (!BRAVE_API_KEY) {
                    return sendJSON(res, 500, { error: 'Chiave Brave Search non configurata sul server (BRAVE_API_KEY).' });
                }

                const offset = (page - 1) * RESULTS_PER_PAGE;
                const endpoints = {
                    web: 'https://api.search.brave.com/res/v1/web/search',
                    images: 'https://api.search.brave.com/res/v1/images/search',
                    news: 'https://api.search.brave.com/res/v1/news/search',
                    videos: 'https://api.search.brave.com/res/v1/videos/search'
                };

                // Le Immagini di Brave non supportano la paginazione con "offset": restituiscono
                // sempre la prima pagina di risultati, quindi la omettiamo per quel tipo.
                let searchUrl = endpoints[type] + '?q=' + encodeURIComponent(q) + '&count=' + RESULTS_PER_PAGE + '&country=it&search_lang=it';
                if (type !== 'images') {
                    searchUrl += '&offset=' + offset;
                }

                const braveResponse = await fetch(searchUrl, {
                    headers: {
                        'Accept': 'application/json',
                        'X-Subscription-Token': BRAVE_API_KEY
                    }
                });

                if (!braveResponse.ok) {
                    const errText = await braveResponse.text();
                    console.error('Errore Brave Search API (' + type + '):', braveResponse.status, errText);
                    return sendJSON(res, 502, { error: 'Servizio di ricerca non raggiungibile al momento.' });
                }

                const data = await braveResponse.json();
                let results = [];

                if (type === 'web') {
                    const webResults = (data.web && Array.isArray(data.web.results)) ? data.web.results : [];
                    results = webResults.map(function (r) {
                        return {
                            title: r.title || '',
                            url: r.url || '',
                            description: (r.description || '').replace(/<\/?[^>]+(>|$)/g, '')
                        };
                    });
                } else if (type === 'images') {
                    const imgResults = Array.isArray(data.results) ? data.results : [];
                    results = imgResults.map(function (r) {
                        return {
                            title: r.title || '',
                            url: r.url || '',
                            imageUrl: (r.thumbnail && r.thumbnail.src) || (r.properties && r.properties.url) || '',
                            source: (r.source || extractHost(r.url))
                        };
                    });
                } else if (type === 'news') {
                    const newsResults = Array.isArray(data.results) ? data.results : [];
                    results = newsResults.map(function (r) {
                        return {
                            title: r.title || '',
                            url: r.url || '',
                            description: (r.description || '').replace(/<\/?[^>]+(>|$)/g, ''),
                            source: (r.meta_url && r.meta_url.hostname) || extractHost(r.url),
                            age: r.age || ''
                        };
                    });
                } else if (type === 'videos') {
                    const videoResults = Array.isArray(data.results) ? data.results : [];
                    results = videoResults.map(function (r) {
                        return {
                            title: r.title || '',
                            url: r.url || '',
                            description: (r.description || '').replace(/<\/?[^>]+(>|$)/g, ''),
                            thumbnail: (r.thumbnail && r.thumbnail.src) || '',
                            duration: (r.video && r.video.duration) || ''
                        };
                    });
                }

                return sendJSON(res, 200, {
                    results: results,
                    page: page,
                    totalPages: (type === 'images') ? 1 : 10, // mostriamo fino a 10 pagine per gli altri tipi
                    type: type,
                    query: q
                });

            } catch (err) {
                console.error('Errore ricerca:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        })();
        return;
    }

    sendJSON(res, 404, { error: 'Percorso non trovato.' });
});

server.listen(PORT, function () {
    console.log('Server in ascolto sulla porta ' + PORT);
});
