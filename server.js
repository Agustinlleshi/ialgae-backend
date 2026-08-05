// Server per iAlgae — versione a FILE UNICO, senza dipendenze esterne.
// Usa solo moduli integrati in Node.js (http + fetch), quindi non serve npm install.
//
// Espone cinque endpoint:
//   POST /api/ask       -> risponde alle domande usando l'API di Anthropic (Claude).
//                          Richiede login: usato dalla chat vera e propria (ia.html).
//   POST /api/overview  -> come /api/ask ma pubblico (nessun login richiesto), con
//                          limite per IP invece che per account. Usato da results.html
//                          per il riassunto IA, il pannello entità e l'AI Mode
//                          (conversazione multi-turno), visti anche da chi non ha
//                          fatto login.
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
//
// NOTA SUL LOGIN CON GOOGLE (aggiunto in questa versione):
// Questo file NON è più a "zero dipendenze": servono due pacchetti in più.
// 1. Nella cartella del backend esegui: npm install google-auth-library jsonwebtoken
//    (se non hai ancora un package.json, "npm install" te lo crea da solo)
// 2. Su Render, in "Environment Variables" aggiungi anche:
//      - SESSION_SECRET = una stringa lunga e casuale, inventata da te (es. generata
//        con un password manager) — serve a firmare le sessioni di chi fa login
// 3. Il Client ID di Google è già inserito qui sotto (GOOGLE_CLIENT_ID), preso dal
//    tuo progetto "ialgae ia" su Google Cloud Console.

const http = require('http');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const MAX_QUESTION_LENGTH = 2000;
const MAX_IMAGE_BASE64_LENGTH = 6000000; // ~4.5 MB di immagine decodificata
const RESULTS_PER_PAGE = 10;
const IMAGES_COUNT = 200; // per le immagini vogliamo molti più risultati in un'unica richiesta (200 è il massimo consentito da Brave)

// ---- PAGAMENTI CON STRIPE (carta di credito, abbonamenti Pro / Pro Max) ----
// STRIPE_SECRET_KEY va impostata come variabile d'ambiente su Render (mai scritta
// direttamente nel codice, perché è una chiave privata e questo file finisce su GitHub).
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2026-06-24.dahlia' }) : null;
// STRIPE_WEBHOOK_SECRET si ottiene quando colleghi il webhook nella dashboard di
// Stripe (serve per verificare che le notifiche di pagamento vengano davvero da Stripe).
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
// ID dei due prezzi creati su Stripe (non sono informazioni segrete, possono stare nel codice)
const STRIPE_PRICE_IDS = {
    pro: 'price_1U05UEJtsAYWqDyr0jMLnvw2',
    pro_max: 'price_1U05V5JtsAYWqDyrK02x1n4H'
};
// Dove Stripe rimanda l'utente dopo il pagamento (cambia se il tuo dominio è diverso)
const SITE_BASE_URL = process.env.SITE_BASE_URL || 'https://www.ialgae.com';

// ---- LOGIN CON GOOGLE + LIMITE MESSAGGI GIORNALIERI ----
const GOOGLE_CLIENT_ID = '897588931636-i6f4hn49mbicag9r46u5pmdf4su0dag9.apps.googleusercontent.com';
// SESSION_SECRET va impostata come variabile d'ambiente su Render (stesso posto di
// ANTHROPIC_API_KEY): una stringa lunga e casuale, inventata da te, che non condividi con nessuno.
const SESSION_SECRET = process.env.SESSION_SECRET || 'cambia-questa-stringa-su-render';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const MAX_DAILY_MESSAGES = 10;
const RATE_LIMIT_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 ore

// ---- Limite per IP per l'endpoint pubblico /api/overview (nessun login richiesto) ----
const overviewRateLimit = new Map(); // ip -> { count, windowStart }
const OVERVIEW_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 ora
const OVERVIEW_MAX_REQUESTS_PER_HOUR = 60;

// Archivio utenti "temporaneo": vive solo finché il server resta acceso.
// Ogni riavvio del server (frequente su Render, piano gratuito) lo svuota.
// Quando vorrai account permanenti e chi ha pagato il Pro salvato per sempre,
// va sostituito con un vero database (es. Postgres su Render).
// Chiave: per gli account Google è il "sub" di Google; per gli account email/password
// è "local:" + email in minuscolo. Valore: { sub, email, name, picture, isPro,
// messageCount, windowStart, provider: 'google' | 'local', passwordHash? }
const users = new Map();

function getUserFromRequest(req) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, SESSION_SECRET);
        return users.get(decoded.sub) || null;
    } catch (err) {
        return null;
    }
}

// Cerca un utente in base all'email (usato dal webhook di Stripe, che ci parla
// solo di email/customer, non conosce il nostro "sub" interno di Google).
function findUserByEmail(email) {
    if (!email) return null;
    const lower = email.toLowerCase();
    for (const user of users.values()) {
        if (user.email && user.email.toLowerCase() === lower) return user;
    }
    return null;
}

// ---- Account con email e password (alternativa al login Google) ----
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function localAccountId(email) {
    return 'local:' + email.toLowerCase().trim();
}

// Password mai salvate in chiaro: si genera un "sale" casuale e si applica
// scrypt (funzione nativa di Node, nessuna libreria esterna necessaria).
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
    return salt + ':' + derivedKey;
}

function verifyPassword(password, storedHash) {
    const parts = (storedHash || '').split(':');
    if (parts.length !== 2) return false;
    const [salt, originalHash] = parts;
    const derivedKey = crypto.scryptSync(password, salt, 64);
    const originalBuffer = Buffer.from(originalHash, 'hex');
    if (derivedKey.length !== originalBuffer.length) return false;
    return crypto.timingSafeEqual(derivedKey, originalBuffer);
}

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
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(body);
}

const server = http.createServer((req, res) => {
    // Richiesta preliminare CORS del browser
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        return res.end();
    }

    // Pagina di controllo per verificare che il server sia attivo
    // (risponde sia a GET, per chi visita col browser, sia a HEAD, usata da
    // servizi di monitoraggio come UptimeRobot per verificare che sia sveglio)
    if (req.url === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(req.method === 'HEAD' ? undefined : 'Server iAlgae attivo. Endpoint disponibili: POST /api/ask , GET /api/suggest?q=...');
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

    // Rotta di login: il sito manda qui il token che riceve da Google
    if (req.method === 'POST' && req.url === '/api/auth/google') {
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

                const credential = payload.credential;
                if (!credential || typeof credential !== 'string') {
                    return sendJSON(res, 400, { error: 'Token mancante.' });
                }

                const ticket = await googleClient.verifyIdToken({
                    idToken: credential,
                    audience: GOOGLE_CLIENT_ID
                });
                const googlePayload = ticket.getPayload(); // { sub, email, name, picture, ... }

                let user = users.get(googlePayload.sub);
                if (!user) {
                    user = {
                        sub: googlePayload.sub,
                        email: googlePayload.email,
                        name: googlePayload.name,
                        picture: googlePayload.picture,
                        isPro: false,
                        messageCount: 0,
                        windowStart: Date.now(),
                        provider: 'google'
                    };
                    users.set(googlePayload.sub, user);
                }

                const sessionToken = jwt.sign(
                    { sub: user.sub },
                    SESSION_SECRET,
                    { expiresIn: '30d' }
                );

                return sendJSON(res, 200, {
                    sessionToken: sessionToken,
                    user: { email: user.email, name: user.name, picture: user.picture, isPro: user.isPro }
                });

            } catch (err) {
                console.error('Errore verifica login Google:', err);
                return sendJSON(res, 401, { error: 'Token non valido.' });
            }
        });
        return;
    }

    // Registrazione con email e password (alternativa al login Google)
    if (req.method === 'POST' && req.url === '/api/auth/register') {
        let body = '';
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', function () {
            try {
                let payload;
                try {
                    payload = JSON.parse(body || '{}');
                } catch (parseErr) {
                    return sendJSON(res, 400, { error: 'Corpo della richiesta non valido.' });
                }

                const email = (payload.email || '').trim().toLowerCase();
                const password = payload.password || '';
                const name = (payload.name || '').trim() || email.split('@')[0];

                if (!EMAIL_REGEX.test(email)) {
                    return sendJSON(res, 400, { error: 'Email non valida.' });
                }
                if (password.length < MIN_PASSWORD_LENGTH) {
                    return sendJSON(res, 400, { error: 'La password deve avere almeno 8 caratteri.' });
                }

                const id = localAccountId(email);
                if (users.has(id) || findUserByEmail(email)) {
                    return sendJSON(res, 409, { error: 'Esiste già un account con questa email.' });
                }

                const user = {
                    sub: id,
                    email: email,
                    name: name,
                    picture: null,
                    isPro: false,
                    messageCount: 0,
                    windowStart: Date.now(),
                    provider: 'local',
                    passwordHash: hashPassword(password)
                };
                users.set(id, user);

                const sessionToken = jwt.sign({ sub: user.sub }, SESSION_SECRET, { expiresIn: '30d' });
                return sendJSON(res, 200, {
                    sessionToken: sessionToken,
                    user: { email: user.email, name: user.name, picture: user.picture, isPro: user.isPro }
                });

            } catch (err) {
                console.error('Errore registrazione:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Accesso con email e password (per chi si è registrato con /api/auth/register)
    if (req.method === 'POST' && req.url === '/api/auth/login') {
        let body = '';
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', function () {
            try {
                let payload;
                try {
                    payload = JSON.parse(body || '{}');
                } catch (parseErr) {
                    return sendJSON(res, 400, { error: 'Corpo della richiesta non valido.' });
                }

                const email = (payload.email || '').trim().toLowerCase();
                const password = payload.password || '';

                const user = users.get(localAccountId(email));
                if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
                    return sendJSON(res, 401, { error: 'Email o password non corrette.' });
                }

                const sessionToken = jwt.sign({ sub: user.sub }, SESSION_SECRET, { expiresIn: '30d' });
                return sendJSON(res, 200, {
                    sessionToken: sessionToken,
                    user: { email: user.email, name: user.name, picture: user.picture, isPro: user.isPro }
                });

            } catch (err) {
                console.error('Errore login email/password:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Crea una sessione di pagamento Stripe (l'utente viene rimandato lì a inserire
    // la carta). Funziona sia se l'utente è già loggato con Google, sia se non lo è
    // ancora: in quel caso sarà Stripe stesso a chiedergli l'email durante il checkout.
    if (req.method === 'POST' && req.url === '/api/create-checkout-session') {
        let body = '';
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', async function () {
            try {
                if (!stripe) {
                    return sendJSON(res, 500, { error: 'Pagamenti non configurati sul server (STRIPE_SECRET_KEY mancante).' });
                }

                let payload;
                try {
                    payload = JSON.parse(body || '{}');
                } catch (parseErr) {
                    return sendJSON(res, 400, { error: 'Corpo della richiesta non valido.' });
                }

                const plan = payload.plan;
                const priceId = STRIPE_PRICE_IDS[plan];
                if (!priceId) {
                    return sendJSON(res, 400, { error: 'Piano non valido. Usa "pro" oppure "pro_max".' });
                }

                // Se l'utente ha già fatto login, precompiliamo la sua email e lo
                // colleghiamo (client_reference_id) al suo account interno, così il
                // webhook più sotto sa a chi assegnare il Pro dopo il pagamento.
                const user = getUserFromRequest(req);

                const sessionParams = {
                    mode: 'subscription',
                    payment_method_types: ['card'],
                    line_items: [{ price: priceId, quantity: 1 }],
                    success_url: SITE_BASE_URL + '/pagamento-completato.html?session_id={CHECKOUT_SESSION_ID}',
                    cancel_url: SITE_BASE_URL + '/piani.html'
                };
                if (user) {
                    sessionParams.customer_email = user.email;
                    sessionParams.client_reference_id = user.sub;
                }

                const session = await stripe.checkout.sessions.create(sessionParams);
                return sendJSON(res, 200, { url: session.url });

            } catch (err) {
                console.error('Errore creazione sessione Stripe:', err);
                return sendJSON(res, 500, { error: 'Impossibile avviare il pagamento in questo momento.' });
            }
        });
        return;
    }

    // Webhook di Stripe: qui arriva la notifica quando un pagamento va davvero a
    // buon fine. È l'UNICO punto in cui l'utente diventa "Pro" per davvero — mai
    // fidarsi di quello che dice il browser, solo di quello che conferma Stripe.
    if (req.method === 'POST' && req.url === '/api/stripe-webhook') {
        let rawBody = '';
        req.on('data', function (chunk) { rawBody += chunk; });
        req.on('end', function () {
            if (!stripe || !STRIPE_WEBHOOK_SECRET) {
                console.error('Webhook Stripe ricevuto ma STRIPE_WEBHOOK_SECRET non configurato.');
                res.writeHead(500);
                return res.end();
            }
            let event;
            try {
                const signature = req.headers['stripe-signature'];
                event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
            } catch (err) {
                console.error('Firma webhook Stripe non valida:', err.message);
                res.writeHead(400);
                return res.end();
            }

            if (event.type === 'checkout.session.completed') {
                const session = event.data.object;
                let user = null;
                if (session.client_reference_id) {
                    user = users.get(session.client_reference_id);
                }
                if (!user && session.customer_email) {
                    user = findUserByEmail(session.customer_email);
                } else if (!user && session.customer_details && session.customer_details.email) {
                    user = findUserByEmail(session.customer_details.email);
                }
                if (user) {
                    user.isPro = true;
                    console.log('Utente passato a Pro:', user.email);
                } else {
                    // L'utente ha pagato senza aver mai fatto login prima: creiamo comunque
                    // una scheda per lui, così quando farà login con la stessa email
                    // Google, ritroverà lo stato Pro già attivo (in memoria, per ora).
                    const email = session.customer_email || (session.customer_details && session.customer_details.email);
                    if (email) {
                        console.log('Pagamento ricevuto da un\'email non ancora collegata a un account:', email);
                    }
                }
            }

            res.writeHead(200);
            res.end();
        });
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

                // Serve essere loggati con Google per usare l'assistente
                const user = getUserFromRequest(req);
                if (!user) {
                    return sendJSON(res, 401, { error: 'not_logged_in', message: 'Accedi con Google per continuare.' });
                }

                // Limite di messaggi giornalieri (salta il controllo per chi ha il Pro)
                if (Date.now() - user.windowStart > RATE_LIMIT_WINDOW_MS) {
                    user.messageCount = 0;
                    user.windowStart = Date.now();
                }
                if (!user.isPro && user.messageCount >= MAX_DAILY_MESSAGES) {
                    return sendJSON(res, 429, {
                        error: 'limit_reached',
                        message: 'Hai raggiunto il numero massimo di messaggi giornalieri.',
                        unlockAt: new Date(user.windowStart + RATE_LIMIT_WINDOW_MS).toISOString()
                    });
                }
                user.messageCount += 1;

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

    // Endpoint pubblico per il riassunto IA, il pannello entità e l'AI Mode di
    // results.html. A differenza di /api/ask, NON richiede login: viene chiamato
    // da chiunque visiti la pagina dei risultati di ricerca, non solo dagli
    // utenti loggati nella chat vera e propria (ia.html). Per evitare abusi ha
    // un limite per indirizzo IP (non per account). Supporta anche "messages"
    // per conversazioni multi-turno (usato dall'AI Mode), non solo "question".
    if (req.method === 'POST' && req.url === '/api/overview') {
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

                // Limite per indirizzo IP invece che per utente (qui non c'è login)
                const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
                let entry = overviewRateLimit.get(ip);
                if (!entry || Date.now() - entry.windowStart > OVERVIEW_RATE_LIMIT_WINDOW_MS) {
                    entry = { count: 0, windowStart: Date.now() };
                }
                if (entry.count >= OVERVIEW_MAX_REQUESTS_PER_HOUR) {
                    return sendJSON(res, 429, { error: 'limit_reached', message: 'Troppe richieste, riprova più tardi.' });
                }
                entry.count += 1;
                overviewRateLimit.set(ip, entry);

                if (!ANTHROPIC_API_KEY) {
                    return sendJSON(res, 500, { error: 'Chiave API non configurata sul server.' });
                }

                // Se arriva anche la cronologia della conversazione (AI Mode), la
                // usiamo per mantenere il contesto; altrimenti si usa solo la
                // domanda singola (riassunto IA e pannello entità).
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
                    anthropicMessages = cleaned.length > 0 ? cleaned : [{ role: 'user', content: question.trim() }];
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
                    console.error('Errore da Anthropic API (overview):', response.status, errText);
                    return sendJSON(res, 502, { error: 'Errore nel contattare il servizio IA. Riprova più tardi.' });
                }

                const data = await response.json();
                const answer = (data.content || [])
                    .map(function (block) { return block.type === 'text' ? block.text : ''; })
                    .filter(Boolean)
                    .join('\n');

                return sendJSON(res, 200, { answer: answer || 'Nessuna risposta ricevuta.' });

            } catch (err) {
                console.error('Errore overview:', err);
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

                // IMPORTANTE: per Brave, "offset" è il numero della pagina stessa (da 0 a 9),
                // non un conteggio di risultati da saltare. Per questo la pagina 1 corrisponde
                // a offset 0, la pagina 2 a offset 1, ecc. (fino a un massimo di offset 9).
                const offset = page - 1;
                const endpoints = {
                    web: 'https://api.search.brave.com/res/v1/web/search',
                    images: 'https://api.search.brave.com/res/v1/images/search',
                    news: 'https://api.search.brave.com/res/v1/news/search',
                    videos: 'https://api.search.brave.com/res/v1/videos/search'
                };

                // Le Immagini di Brave non supportano la paginazione con "offset": restituiscono
                // sempre la prima pagina di risultati, quindi la omettiamo per quel tipo.
                const countForType = (type === 'images') ? IMAGES_COUNT : RESULTS_PER_PAGE;
                let searchUrl = endpoints[type] + '?q=' + encodeURIComponent(q) + '&count=' + countForType + '&country=it&search_lang=it';
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
                            age: r.age || '',
                            thumbnail: (r.thumbnail && r.thumbnail.src) || ''
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
                    query: q,
                    // "Forse cercavi...": Brave a volte corregge da sola un probabile errore
                    // di battitura. Se lo fa, ce lo dice qui — non lo inventiamo noi.
                    alteredQuery: (data.query && data.query.altered) ? data.query.altered : null
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
