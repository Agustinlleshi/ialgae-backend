// Server per iAlgae — versione a FILE UNICO, senza dipendenze esterne.
// Usa solo moduli integrati in Node.js (http + fetch), quindi non serve npm install.
//
// Espone cinque endpoint:
//   POST /api/ask       -> risponde alle domande usando l'API di Anthropic (Claude).
//                          Usato dalla chat vera e propria (ia.html). Permette 20
//                          messaggi ogni 4 ore anche senza login (contati per IP);
//                          chi si logga passa al conteggio per account, ed è
//                          l'unico modo per sbloccare il piano Pro (nessun limite).
//   POST /api/overview  -> come /api/ask ma pubblico e SENZA ALCUN LIMITE: usato da
//                          results.html e dalla homepage per il riassunto IA, il
//                          pannello entità e l'AI Mode (conversazione multi-turno).
//                          Il limite di 20 utilizzi ogni 4 ore si applica SOLO a
//                          /api/ask (la chat vera e propria su ia.html).
//   POST /api/vision    -> analizza un'immagine caricata (iAlgae Lens) usando Claude,
//                          che ha capacità di visione (il backend è già collegato a
//                          Claude, quindi riusiamo lo stesso, non usiamo Gemini di Google)
//   GET  /api/suggest   -> restituisce suggerimenti di ricerca reali (proxy verso DuckDuckGo,
//                          necessario perché il browser da solo non può chiamarlo per via del CORS)
//   GET  /api/search    -> restituisce risultati di ricerca web reali (proxy verso Brave Search API),
//                          usati dalla pagina dei risultati (results.html) per mostrare i risultati
//                          dentro iAlgae invece di rimandare a Google
//
// Endpoint di autenticazione: POST /api/auth/google, POST /api/auth/microsoft,
// POST /api/auth/register, POST /api/auth/login, GET /api/auth/me (ripristina
// la sessione da un token esistente, usato da login.html e ia.html al caricamento
// della pagina), POST /api/auth/forgot-password e POST /api/auth/reset-password
// (recupero password via email, per gli account email/password), POST
// /api/auth/verify-email e POST /api/auth/resend-verification (conferma email
// obbligatoria per chi si registra con email/password: non può accedere finché
// non clicca il link ricevuto).
//
// VARIABILI D'AMBIENTE PER ACCOUNT PERMANENTI (database) ED EMAIL:
//   DATABASE_URL      = Connection String di Neon (postgresql://...). Senza,
//                        gli account restano solo in memoria (si perdono ad
//                        ogni riavvio del server), come prima.
//   RESEND_API_KEY     = chiave API di Resend (re_...), per inviare davvero le
//                        email di recupero password. Senza, il link di reset
//                        viene comunque generato ma l'email non parte (lo
//                        segnala nei log — utile in fase di test).
//   RESEND_FROM_EMAIL = indirizzo mittente delle email, es. "iAlgae <noreply@ialgae.com>"
//                        (richiede dominio verificato su Resend). Se non impostata,
//                        usa il dominio di test di Resend (funziona solo per email
//                        verso il tuo stesso account Resend).
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
const jwksClient = require('jwks-rsa');
const { Pool } = require('pg');
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

// ---- LOGIN CON MICROSOFT ----
// Sostituisci con l'"Application (client) ID" che trovi in Microsoft Entra admin
// center dopo aver registrato l'app (vedi commento più sotto in /api/auth/microsoft
// per i dettagli). Finché resta con questo valore segnaposto, il login Microsoft
// è disattivato e mostra "presto disponibile" sul sito.
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || 'b175e7db-c753-4eea-a266-650b0d14012f';
const microsoftLoginEnabled = MICROSOFT_CLIENT_ID.indexOf('INSERISCI_QUI') === -1;
// Le chiavi pubbliche di Microsoft per verificare la firma dei token, prese
// dall'endpoint "common" (funziona sia con account aziendali sia personali,
// tipo Outlook/Hotmail — coerente con come abbiamo registrato l'app).
const microsoftJwksClient = jwksClient({
    jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
    cache: true,
    cacheMaxAge: 12 * 60 * 60 * 1000 // 12 ore
});
function getMicrosoftSigningKey(kid) {
    return new Promise(function (resolve, reject) {
        microsoftJwksClient.getSigningKey(kid, function (err, key) {
            if (err) return reject(err);
            resolve(key.getPublicKey());
        });
    });
}
// Verifica un id_token di Microsoft: firma valida, destinato alla nostra app,
// ed emesso da un tenant Microsoft vero (account aziendale o personale).
async function verifyMicrosoftToken(idToken) {
    const decoded = jwt.decode(idToken, { complete: true });
    if (!decoded || !decoded.header || !decoded.header.kid) {
        throw new Error('Token non valido.');
    }
    const publicKey = await getMicrosoftSigningKey(decoded.header.kid);
    const payload = jwt.verify(idToken, publicKey, { algorithms: ['RS256'] });

    if (payload.aud !== MICROSOFT_CLIENT_ID) {
        throw new Error('Token destinato a un\'altra applicazione.');
    }
    // L'emittente cambia a seconda del tenant dell'utente (aziendale o personale):
    // controlliamo solo che abbia la forma giusta, non un tenant specifico.
    if (!payload.iss || !/^https:\/\/login\.microsoftonline\.com\/[^/]+\/v2\.0$/.test(payload.iss)) {
        throw new Error('Emittente del token non riconosciuto.');
    }
    return payload; // { oid o sub, email o preferred_username, name, ... }
}

const MAX_DAILY_MESSAGES = 20;
const RATE_LIMIT_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 ore (solo per /api/ask, la chat su ia.html)

// Conteggio per indirizzo IP di chi usa /api/ask senza essere loggato (stessa
// regola di MAX_DAILY_MESSAGES/RATE_LIMIT_WINDOW_MS). Chi si logga passa invece
// al conteggio per account (vedi sopra), che è anche l'unico modo per avere il Pro.
const askAnonymousRateLimit = new Map(); // ip -> { count, windowStart }

// ---- DATABASE (Postgres su Neon) ----
// Finché non imposti DATABASE_URL su Render, gli account restano SOLO in
// memoria (si perdono a ogni riavvio, come prima). Appena aggiungi la
// variabile d'ambiente DATABASE_URL con la Connection String di Neon, tutto
// passa automaticamente al database vero, senza altre modifiche al codice.
const DATABASE_URL = process.env.DATABASE_URL || '';
const dbEnabled = !!DATABASE_URL;
const pool = dbEnabled ? new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Neon richiede una connessione SSL
}) : null;

async function initDb() {
    if (!dbEnabled) {
        console.warn('DATABASE_URL non impostata: gli account restano solo in memoria (si perdono ad ogni riavvio).');
        return;
    }
    await pool.query(
        'CREATE TABLE IF NOT EXISTS users (' +
        '  id TEXT PRIMARY KEY,' +
        '  email TEXT UNIQUE NOT NULL,' +
        '  name TEXT,' +
        '  surname TEXT,' +
        '  picture TEXT,' +
        '  is_pro BOOLEAN NOT NULL DEFAULT false,' +
        '  message_count INTEGER NOT NULL DEFAULT 0,' +
        '  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),' +
        '  provider TEXT NOT NULL,' +
        '  password_hash TEXT,' +
        '  reset_token TEXT,' +
        '  reset_token_expires TIMESTAMPTZ,' +
        '  email_verified BOOLEAN NOT NULL DEFAULT false,' +
        '  verify_token TEXT,' +
        '  verify_token_expires TIMESTAMPTZ,' +
        '  created_at TIMESTAMPTZ NOT NULL DEFAULT now()' +
        ')'
    );
    // Se la tabella esisteva già da prima di queste colonne (es. era stata
    // creata con una versione precedente del sito), le aggiungiamo qui: non
    // tocca i dati esistenti, aggiunge solo le colonne mancanti.
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS surname TEXT');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token TEXT');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token_expires TIMESTAMPTZ');
    console.log('Database pronto (tabella users verificata/creata).');
}

// Usato SOLO se DATABASE_URL non è configurata (vedi sopra).
const memoryUsers = new Map();

function rowToUser(row) {
    if (!row) return null;
    return {
        sub: row.id,
        email: row.email,
        name: row.name,
        surname: row.surname,
        picture: row.picture,
        isPro: row.is_pro,
        messageCount: row.message_count,
        windowStart: new Date(row.window_start).getTime(),
        provider: row.provider,
        passwordHash: row.password_hash,
        resetToken: row.reset_token,
        resetTokenExpires: row.reset_token_expires ? new Date(row.reset_token_expires).getTime() : null,
        emailVerified: row.email_verified,
        verifyToken: row.verify_token,
        verifyTokenExpires: row.verify_token_expires ? new Date(row.verify_token_expires).getTime() : null
    };
}

async function getUserById(id) {
    if (!id) return null;
    if (!dbEnabled) return memoryUsers.get(id) || null;
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rowToUser(result.rows[0]);
}

// Cerca un utente in base all'email (usato dal webhook di Stripe, che ci parla
// solo di email/customer, non conosce il nostro "id" interno; e dal recupero
// password, che parte sempre dall'email digitata).
async function getUserByEmail(email) {
    if (!email) return null;
    const lower = email.toLowerCase();
    if (!dbEnabled) {
        for (const user of memoryUsers.values()) {
            if (user.email && user.email.toLowerCase() === lower) return user;
        }
        return null;
    }
    const result = await pool.query('SELECT * FROM users WHERE lower(email) = $1', [lower]);
    return rowToUser(result.rows[0]);
}

// Cerca un utente in base al token di reset password (usato dalla pagina
// reset-password.html, che riceve solo il token dal link nell'email).
async function getUserByResetToken(token) {
    if (!token) return null;
    if (!dbEnabled) {
        for (const user of memoryUsers.values()) {
            if (user.resetToken && user.resetToken === token) return user;
        }
        return null;
    }
    const result = await pool.query('SELECT * FROM users WHERE reset_token = $1', [token]);
    return rowToUser(result.rows[0]);
}

// Cerca un utente in base al token di verifica email (usato dalla pagina
// verify-email.html, che riceve solo il token dal link nell'email).
async function getUserByVerifyToken(token) {
    if (!token) return null;
    if (!dbEnabled) {
        for (const user of memoryUsers.values()) {
            if (user.verifyToken && user.verifyToken === token) return user;
        }
        return null;
    }
    const result = await pool.query('SELECT * FROM users WHERE verify_token = $1', [token]);
    return rowToUser(result.rows[0]);
}

// Salva (crea o aggiorna) un utente. Va chiamata esplicitamente ogni volta che
// si modifica un campo (es. messageCount, isPro): a differenza della vecchia
// Map, il database non si aggiorna da solo mutando l'oggetto in memoria.
async function saveUser(user) {
    if (!dbEnabled) {
        memoryUsers.set(user.sub, user);
        return user;
    }
    await pool.query(
        'INSERT INTO users (id, email, name, surname, picture, is_pro, message_count, window_start, provider, password_hash, reset_token, reset_token_expires, email_verified, verify_token, verify_token_expires) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ' +
        'ON CONFLICT (id) DO UPDATE SET ' +
        '  email = EXCLUDED.email, name = EXCLUDED.name, surname = EXCLUDED.surname, picture = EXCLUDED.picture, ' +
        '  is_pro = EXCLUDED.is_pro, message_count = EXCLUDED.message_count, window_start = EXCLUDED.window_start, ' +
        '  provider = EXCLUDED.provider, password_hash = EXCLUDED.password_hash, ' +
        '  reset_token = EXCLUDED.reset_token, reset_token_expires = EXCLUDED.reset_token_expires, ' +
        '  email_verified = EXCLUDED.email_verified, verify_token = EXCLUDED.verify_token, ' +
        '  verify_token_expires = EXCLUDED.verify_token_expires',
        [
            user.sub, user.email, user.name || null, user.surname || null, user.picture || null, !!user.isPro,
            user.messageCount || 0, new Date(user.windowStart || Date.now()), user.provider,
            user.passwordHash || null, user.resetToken || null,
            user.resetTokenExpires ? new Date(user.resetTokenExpires) : null,
            !!user.emailVerified, user.verifyToken || null,
            user.verifyTokenExpires ? new Date(user.verifyTokenExpires) : null
        ]
    );
    return user;
}

async function getUserFromRequest(req) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, SESSION_SECRET);
        return await getUserById(decoded.sub);
    } catch (err) {
        return null;
    }
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

// ---- EMAIL (per il recupero password), tramite Resend ----
// RESEND_API_KEY va impostata come variabile d'ambiente su Render (stesso
// posto delle altre chiavi). Finché manca, il recupero password funziona lo
// stesso lato server (genera il link), ma l'email non viene davvero inviata:
// lo segnaliamo nei log invece di far fallire silenziosamente la richiesta.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'iAlgae <onboarding@resend.dev>';

function escapeHtmlServer(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function sendEmail(to, subject, html) {
    if (!RESEND_API_KEY) {
        console.warn('RESEND_API_KEY non configurata: email NON inviata a', to, '- oggetto:', subject);
        return false;
    }
    try {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + RESEND_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: [to], subject: subject, html: html })
        });
        if (!response.ok) {
            const errText = await response.text();
            console.error('Errore invio email Resend:', response.status, errText);
            return false;
        }
        return true;
    } catch (err) {
        console.error('Errore di rete inviando email:', err);
        return false;
    }
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

                let user = await getUserById(googlePayload.sub);
                if (!user) {
                    user = {
                        sub: googlePayload.sub,
                        email: googlePayload.email,
                        name: googlePayload.name,
                        picture: googlePayload.picture,
                        isPro: false,
                        messageCount: 0,
                        windowStart: Date.now(),
                        provider: 'google',
                        emailVerified: true // Google ha già verificato questa email
                    };
                    await saveUser(user);
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

    // Login con Microsoft (account aziendali o personali tipo Outlook/Hotmail).
    // Stesso schema del login Google: il browser fa apparire la finestra di
    // accesso Microsoft (via MSAL.js) e ci manda qui solo l'id_token da
    // verificare, mai una password. Per attivarlo:
    //   1. Registra l'app su https://entra.microsoft.com (gratuito, vedi
    //      istruzioni ricevute separatamente)
    //   2. Imposta la variabile d'ambiente MICROSOFT_CLIENT_ID su Render con
    //      l'Application (client) ID che ottieni dalla registrazione
    if (req.method === 'POST' && req.url === '/api/auth/microsoft') {
        let body = '';
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', async function () {
            try {
                if (!microsoftLoginEnabled) {
                    return sendJSON(res, 501, { error: 'Login Microsoft non ancora configurato sul server.' });
                }

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

                const msPayload = await verifyMicrosoftToken(credential);
                // "oid" identifica l'utente in modo stabile; alcuni account personali
                // (tipo Outlook.com) potrebbero avere solo "sub". Il prefisso "ms:"
                // evita collisioni con gli ID di Google o degli account email/password.
                const msId = 'ms:' + (msPayload.oid || msPayload.sub);
                const msEmail = msPayload.email || msPayload.preferred_username || '';
                const msName = msPayload.name || msEmail.split('@')[0] || 'Utente Microsoft';

                let user = await getUserById(msId);
                if (!user) {
                    user = {
                        sub: msId,
                        email: msEmail,
                        name: msName,
                        picture: null, // Microsoft Graph richiederebbe un permesso extra per la foto profilo
                        isPro: false,
                        messageCount: 0,
                        windowStart: Date.now(),
                        provider: 'microsoft',
                        emailVerified: true // Microsoft ha già verificato questa email
                    };
                    await saveUser(user);
                }

                const sessionToken = jwt.sign({ sub: user.sub }, SESSION_SECRET, { expiresIn: '30d' });
                return sendJSON(res, 200, {
                    sessionToken: sessionToken,
                    user: { email: user.email, name: user.name, picture: user.picture, isPro: user.isPro }
                });

            } catch (err) {
                console.error('Errore verifica login Microsoft:', err);
                return sendJSON(res, 401, { error: 'Token non valido.' });
            }
        });
        return;
    }

    // Restituisce l'utente collegato al token presente (se valido), così le
    // pagine possono ripristinare la sessione al caricamento senza dover
    // rifare il login ogni volta (es. dopo essere passati da login.html a ia.html).
    if (req.method === 'GET' && req.url === '/api/auth/me') {
        (async function () {
            const user = await getUserFromRequest(req);
            if (!user) {
                return sendJSON(res, 401, { error: 'not_logged_in' });
            }
            return sendJSON(res, 200, {
                user: { email: user.email, name: user.name, picture: user.picture || null, isPro: !!user.isPro }
            });
        })();
        return;
    }

    // Registrazione con email e password (alternativa al login Google)
    if (req.method === 'POST' && req.url === '/api/auth/register') {
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

                const email = (payload.email || '').trim().toLowerCase();
                const password = payload.password || '';
                const name = (payload.name || '').trim() || email.split('@')[0];
                const surname = (payload.surname || '').trim(); // facoltativo

                if (!EMAIL_REGEX.test(email)) {
                    return sendJSON(res, 400, { error: 'Email non valida.' });
                }
                if (password.length < MIN_PASSWORD_LENGTH) {
                    return sendJSON(res, 400, { error: 'La password deve avere almeno 8 caratteri.' });
                }

                const id = localAccountId(email);
                const existing = (await getUserById(id)) || (await getUserByEmail(email));
                if (existing) {
                    return sendJSON(res, 409, { error: 'Esiste già un account con questa email.' });
                }

                const verifyToken = crypto.randomBytes(32).toString('hex');
                const user = {
                    sub: id,
                    email: email,
                    name: name,
                    surname: surname || null,
                    picture: null,
                    isPro: false,
                    messageCount: 0,
                    windowStart: Date.now(),
                    provider: 'local',
                    passwordHash: hashPassword(password),
                    emailVerified: false,
                    verifyToken: verifyToken,
                    verifyTokenExpires: Date.now() + 24 * 60 * 60 * 1000 // 24 ore
                };
                await saveUser(user);

                const verifyUrl = SITE_BASE_URL + '/verify-email.html?token=' + verifyToken;
                await sendEmail(
                    user.email,
                    'Conferma la tua email - iAlgae',
                    '<p>Ciao ' + escapeHtmlServer(user.name || '') + ',</p>' +
                    '<p>Grazie per esserti registrato su iAlgae! Conferma il tuo indirizzo email cliccando sul link qui sotto (valido per 24 ore):</p>' +
                    '<p><a href="' + verifyUrl + '">' + verifyUrl + '</a></p>' +
                    '<p>Se non trovi questa email nella posta in arrivo, controlla anche nella cartella <strong>spam/posta indesiderata</strong>.</p>' +
                    '<p>Se non sei stato tu a registrarti, ignora pure questa email.</p>'
                );

                // Niente sessionToken qui: l'account esiste ma non può ancora
                // accedere finché non conferma l'email dal link.
                return sendJSON(res, 200, {
                    requiresVerification: true,
                    message: 'Account creato! Controlla la tua email (anche lo spam) e clicca sul link per confermarla prima di accedere.'
                });

            } catch (err) {
                console.error('Errore registrazione:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Conferma l'email di un account appena registrato: riceve il token dal
    // link nell'email e attiva l'account, poi fa il login automaticamente.
    if (req.method === 'POST' && req.url === '/api/auth/verify-email') {
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

                const token = (payload.token || '').trim();
                if (!token) {
                    return sendJSON(res, 400, { error: 'Link non valido.' });
                }

                const user = await getUserByVerifyToken(token);
                if (!user || !user.verifyTokenExpires || user.verifyTokenExpires < Date.now()) {
                    return sendJSON(res, 400, { error: 'Il link è scaduto o non è più valido. Richiedine uno nuovo.' });
                }

                user.emailVerified = true;
                user.verifyToken = null;
                user.verifyTokenExpires = null;
                await saveUser(user);

                // Una volta confermata l'email, colleghiamo subito l'utente:
                // non deve rifare il login da capo.
                const sessionToken = jwt.sign({ sub: user.sub }, SESSION_SECRET, { expiresIn: '30d' });
                return sendJSON(res, 200, {
                    message: 'Email confermata con successo!',
                    sessionToken: sessionToken,
                    user: { email: user.email, name: user.name, picture: user.picture, isPro: user.isPro }
                });

            } catch (err) {
                console.error('Errore verify-email:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Rimanda l'email di conferma (utile se il link è scaduto o l'email non è
    // arrivata). Risponde sempre allo stesso modo, esista o meno l'account,
    // per non rivelare quali email sono registrate.
    if (req.method === 'POST' && req.url === '/api/auth/resend-verification') {
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

                const email = (payload.email || '').trim().toLowerCase();
                if (!EMAIL_REGEX.test(email)) {
                    return sendJSON(res, 400, { error: 'Email non valida.' });
                }

                const user = await getUserByEmail(email);
                if (user && user.provider === 'local' && !user.emailVerified) {
                    user.verifyToken = crypto.randomBytes(32).toString('hex');
                    user.verifyTokenExpires = Date.now() + 24 * 60 * 60 * 1000;
                    await saveUser(user);

                    const verifyUrl = SITE_BASE_URL + '/verify-email.html?token=' + user.verifyToken;
                    await sendEmail(
                        user.email,
                        'Conferma la tua email - iAlgae',
                        '<p>Ciao ' + escapeHtmlServer(user.name || '') + ',</p>' +
                        '<p>Ecco un nuovo link per confermare la tua email (valido per 24 ore):</p>' +
                        '<p><a href="' + verifyUrl + '">' + verifyUrl + '</a></p>' +
                        '<p>Se non trovi questa email nella posta in arrivo, controlla anche nella cartella <strong>spam/posta indesiderata</strong>.</p>'
                    );
                }

                return sendJSON(res, 200, { message: 'Se l\'indirizzo è registrato e non ancora confermato, riceverai a breve una nuova email.' });

            } catch (err) {
                console.error('Errore resend-verification:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Accesso con email e password (per chi si è registrato con /api/auth/register)
    if (req.method === 'POST' && req.url === '/api/auth/login') {
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

                const email = (payload.email || '').trim().toLowerCase();
                const password = payload.password || '';

                const user = await getUserById(localAccountId(email));
                if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
                    return sendJSON(res, 401, { error: 'Email o password non corrette.' });
                }

                if (!user.emailVerified) {
                    return sendJSON(res, 403, {
                        error: 'email_not_verified',
                        message: 'Devi prima confermare la tua email. Controlla la tua casella (anche lo spam) per il link di conferma.'
                    });
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

    // Richiesta di recupero password: genera un token temporaneo e manda
    // un'email con il link per sceglierne una nuova. Per non rivelare quali
    // email sono registrate sul sito, la risposta è sempre la stessa, sia che
    // l'account esista sia che non esista.
    if (req.method === 'POST' && req.url === '/api/auth/forgot-password') {
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

                const email = (payload.email || '').trim().toLowerCase();
                if (!EMAIL_REGEX.test(email)) {
                    return sendJSON(res, 400, { error: 'Email non valida.' });
                }

                const user = await getUserByEmail(email);
                // Il reset ha senso solo per gli account email/password: chi accede
                // con Google o Microsoft non ha una password nostra da reimpostare.
                if (user && user.provider === 'local') {
                    user.resetToken = crypto.randomBytes(32).toString('hex');
                    user.resetTokenExpires = Date.now() + 60 * 60 * 1000; // 1 ora
                    await saveUser(user);

                    const resetUrl = SITE_BASE_URL + '/reset-password.html?token=' + user.resetToken;
                    await sendEmail(
                        user.email,
                        'Reimposta la tua password iAlgae',
                        '<p>Ciao ' + escapeHtmlServer(user.name || '') + ',</p>' +
                        '<p>Hai richiesto di reimpostare la password del tuo account iAlgae. Clicca sul link qui sotto per sceglierne una nuova (valido per 1 ora):</p>' +
                        '<p><a href="' + resetUrl + '">' + resetUrl + '</a></p>' +
                        '<p>Se non sei stato tu a richiederlo, ignora pure questa email: la tua password resta invariata.</p>'
                    );
                }

                return sendJSON(res, 200, { message: 'Se l\'indirizzo è registrato, riceverai a breve un\'email con le istruzioni.' });

            } catch (err) {
                console.error('Errore forgot-password:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Completamento del recupero password: riceve il token dal link nell'email
    // e la nuova password scelta dall'utente.
    if (req.method === 'POST' && req.url === '/api/auth/reset-password') {
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

                const token = (payload.token || '').trim();
                const newPassword = payload.password || '';

                if (!token) {
                    return sendJSON(res, 400, { error: 'Link non valido.' });
                }
                if (newPassword.length < MIN_PASSWORD_LENGTH) {
                    return sendJSON(res, 400, { error: 'La password deve avere almeno 8 caratteri.' });
                }

                const user = await getUserByResetToken(token);
                if (!user || !user.resetTokenExpires || user.resetTokenExpires < Date.now()) {
                    return sendJSON(res, 400, { error: 'Il link è scaduto o non è più valido. Richiedine uno nuovo.' });
                }

                user.passwordHash = hashPassword(newPassword);
                user.resetToken = null;
                user.resetTokenExpires = null;
                await saveUser(user);

                return sendJSON(res, 200, { message: 'Password aggiornata con successo.' });

            } catch (err) {
                console.error('Errore reset-password:', err);
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

                // Per passare a un piano Pro serve prima un account: lo richiediamo
                // anche qui lato server (non solo nella pagina piani.html), così
                // non si può aggirare il controllo chiamando l'API direttamente.
                const user = await getUserFromRequest(req);
                if (!user) {
                    return sendJSON(res, 401, {
                        error: 'not_logged_in',
                        message: 'Devi prima creare un account per passare a un piano Pro.'
                    });
                }

                const sessionParams = {
                    mode: 'subscription',
                    payment_method_types: ['card'],
                    line_items: [{ price: priceId, quantity: 1 }],
                    success_url: SITE_BASE_URL + '/pagamento-completato.html?session_id={CHECKOUT_SESSION_ID}',
                    cancel_url: SITE_BASE_URL + '/piani.html',
                    customer_email: user.email,
                    client_reference_id: user.sub
                };

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
        req.on('end', async function () {
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
                    user = await getUserById(session.client_reference_id);
                }
                if (!user && session.customer_email) {
                    user = await getUserByEmail(session.customer_email);
                } else if (!user && session.customer_details && session.customer_details.email) {
                    user = await getUserByEmail(session.customer_details.email);
                }
                if (user) {
                    user.isPro = true;
                    await saveUser(user);
                    console.log('Utente passato a Pro:', user.email);
                } else {
                    // L'utente ha pagato senza aver mai fatto login prima: creiamo comunque
                    // una scheda per lui, così quando farà login con la stessa email
                    // Google, ritroverà lo stato Pro già attivo.
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

                // ia.html non richiede più il login fin da subito: chi non è
                // loggato ha comunque diritto a MAX_DAILY_MESSAGES messaggi ogni
                // RATE_LIMIT_WINDOW_MS, contati per indirizzo IP. Chi è loggato usa
                // invece il conteggio del proprio account (ed è l'unico modo per
                // sbloccare il piano Pro, che rimuove del tutto il limite).
                const user = await getUserFromRequest(req);

                if (user) {
                    if (Date.now() - user.windowStart > RATE_LIMIT_WINDOW_MS) {
                        user.messageCount = 0;
                        user.windowStart = Date.now();
                    }
                    if (!user.isPro && user.messageCount >= MAX_DAILY_MESSAGES) {
                        return sendJSON(res, 429, {
                            error: 'limit_reached',
                            message: 'Hai raggiunto il limite di ' + MAX_DAILY_MESSAGES + ' messaggi gratuiti. Passa a un piano Pro per continuare senza limiti, oppure riprova tra qualche ora.',
                            unlockAt: new Date(user.windowStart + RATE_LIMIT_WINDOW_MS).toISOString(),
                            upgradeUrl: SITE_BASE_URL + '/piani.html'
                        });
                    }
                    user.messageCount += 1;
                    await saveUser(user);
                } else {
                    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
                    let entry = askAnonymousRateLimit.get(ip);
                    if (!entry || Date.now() - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
                        entry = { count: 0, windowStart: Date.now() };
                    }
                    if (entry.count >= MAX_DAILY_MESSAGES) {
                        return sendJSON(res, 429, {
                            error: 'limit_reached',
                            message: 'Hai raggiunto il limite di ' + MAX_DAILY_MESSAGES + ' messaggi gratuiti. Passa a un piano Pro per continuare senza limiti, oppure riprova tra qualche ora.',
                            unlockAt: new Date(entry.windowStart + RATE_LIMIT_WINDOW_MS).toISOString(),
                            upgradeUrl: SITE_BASE_URL + '/piani.html'
                        });
                    }
                    entry.count += 1;
                    askAnonymousRateLimit.set(ip, entry);
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

                // Nessun limite qui, di proposito: /api/overview alimenta results.html
                // e la homepage, che devono restare completamente libere, senza login
                // e senza tetto di utilizzi. Il limite (20 ogni 4 ore) si applica SOLO
                // a /api/ask, cioè solo alla chat vera e propria su ia.html.

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

// Prima di aprire le porte al traffico, verifichiamo/creiamo la tabella nel
// database (se DATABASE_URL è configurata). Se qualcosa va storto qui (es.
// stringa di connessione sbagliata), il server parte comunque, usando la
// memoria come ripiego, invece di restare bloccato per sempre.
initDb()
    .then(function () {
        server.listen(PORT, function () {
            console.log('Server in ascolto sulla porta ' + PORT);
        });
    })
    .catch(function (err) {
        console.error('Errore inizializzazione database, si parte comunque con la memoria come ripiego:', err);
        server.listen(PORT, function () {
            console.log('Server in ascolto sulla porta ' + PORT + ' (database non disponibile)');
        });
    });
