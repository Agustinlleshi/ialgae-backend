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
// Google Gemini è usato SOLO come riserva quando Anthropic non risponde (es.
// credito esaurito, chiave non configurata, errore del servizio) — vedi
// getAiAnswer() più sotto. Se GEMINI_API_KEY non è impostata su Render, il
// sito continua a funzionare esattamente come prima, usando solo Anthropic.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const GOOGLE_BOOKS_API_KEY = process.env.GOOGLE_BOOKS_API_KEY;
// Chiave di test per la demo di Serper.dev (facoltativa, non usata dal
// resto del sito): serve solo per la pagina test-serper.html, per
// verificare come sarebbero i risultati usando Serper invece di Brave.
const SERPER_API_KEY = process.env.SERPER_API_KEY;
// Chiave segreta per proteggere le statistiche interne (es. iscrizioni
// giornaliere). Impostala su Render come stringa lunga e casuale, inventata
// da te: chi non la conosce non può vedere i dati statistici del sito.
const ADMIN_SECRET = process.env.ADMIN_SECRET;
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

const MAX_DAILY_MESSAGES = 15;
const RATE_LIMIT_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 ore (solo per /api/ask, la chat su ia.html)

// Conteggio per indirizzo IP di chi usa /api/ask senza essere loggato (stessa
// regola di MAX_DAILY_MESSAGES/RATE_LIMIT_WINDOW_MS). Chi si logga passa invece
// al conteggio per account (vedi sopra), che è anche l'unico modo per avere il Pro.
const askAnonymousRateLimit = new Map(); // ip -> { count, windowStart }

// Rate limiting per le richieste di reset password (endpoint
// /api/auth/forgot-password). Senza questo limite, chiunque potrebbe inviare
// richieste illimitate verso la stessa email (spam) o da uno stesso IP verso
// email diverse (abuso), danneggiando la deliverability del dominio email.
const MAX_RESET_REQUESTS = 3;
const RESET_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 ora
const resetRateLimitByEmail = new Map(); // email -> { count, windowStart }
const resetRateLimitByIp = new Map();    // ip -> { count, windowStart }

// Rate limiting per i tentativi di codice 2FA al login (endpoint
// /api/auth/2fa/login-verify). Senza questo limite, un codice a 6 cifre
// (un milione di combinazioni) sarebbe indovinabile a forza bruta in un
// tempo ragionevole automatizzando i tentativi.
const memory2faAttempts = new Map(); // userId -> { count, windowStart }

// Controlla e aggiorna un contatore di rate limit in una Map. Ritorna
// { allowed, windowStart }: allowed è true se la richiesta è consentita (e in
// tal caso incrementa il contatore), false se il limite è già stato
// raggiunto per la finestra corrente. windowStart serve a chi deve
// comunicare "riprova tra X ore".
function checkAndConsumeRateLimitMemory(map, key, maxCount, windowMs) {
    let entry = map.get(key);
    if (!entry || Date.now() - entry.windowStart > windowMs) {
        entry = { count: 0, windowStart: Date.now() };
    }
    if (entry.count >= maxCount) {
        map.set(key, entry);
        return { allowed: false, windowStart: entry.windowStart };
    }
    entry.count += 1;
    map.set(key, entry);
    return { allowed: true, windowStart: entry.windowStart };
}

// Come checkAndConsumeRateLimitMemory, ma con contatore salvato su Postgres
// invece che in una Map in memoria: sopravvive ai riavvii del server
// (frequenti su Render, specie col piano free che va in sleep). "prefix"
// distingue i vari tipi di limite (es. "reset-email" vs "ask-anon") così la
// stessa email/IP non condivide per sbaglio il contatore tra usi diversi.
// "memoryMap" è la Map da usare come ripiego se il database non è
// configurato o se una query fallisce per qualche motivo: un rate limit
// temporaneamente più permissivo è preferibile a un endpoint che smette di
// funzionare.
async function checkAndConsumeRateLimitPersistent(prefix, key, maxCount, windowMs, memoryMap) {
    if (!dbEnabled) {
        return checkAndConsumeRateLimitMemory(memoryMap, key, maxCount, windowMs);
    }
    const limitKey = prefix + ':' + key;
    try {
        const result = await pool.query(
            'SELECT attempt_count, window_start FROM rate_limits WHERE limit_key = $1',
            [limitKey]
        );
        const row = result.rows[0];

        // Nessuna voce ancora, oppure la finestra precedente è scaduta: si
        // riparte da zero (contatore a 1, la richiesta corrente è la prima).
        if (!row || (Date.now() - new Date(row.window_start).getTime()) > windowMs) {
            const insertResult = await pool.query(
                'INSERT INTO rate_limits (limit_key, attempt_count, window_start) VALUES ($1, 1, now()) ' +
                'ON CONFLICT (limit_key) DO UPDATE SET attempt_count = 1, window_start = now() ' +
                'RETURNING window_start',
                [limitKey]
            );
            return { allowed: true, windowStart: new Date(insertResult.rows[0].window_start).getTime() };
        }

        const windowStart = new Date(row.window_start).getTime();
        if (row.attempt_count >= maxCount) {
            return { allowed: false, windowStart: windowStart };
        }

        await pool.query(
            'UPDATE rate_limits SET attempt_count = attempt_count + 1 WHERE limit_key = $1',
            [limitKey]
        );
        return { allowed: true, windowStart: windowStart };

    } catch (err) {
        console.error('Errore rate limit su Postgres, si passa alla memoria come ripiego:', err);
        return checkAndConsumeRateLimitMemory(memoryMap, key, maxCount, windowMs);
    }
}

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
        '  stripe_customer_id TEXT,' +
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
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT false');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT');
    // Elenco delle app che l'utente ha scelto di nascondere dal proprio menu
    // "I tuoi preferiti" (personalizzazione disponibile solo da loggati).
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS hidden_apps TEXT[] NOT NULL DEFAULT \'{}\'');
    // App personalizzate aggiunte liberamente dall'utente (nome + indirizzo),
    // salvate come JSON: [{ "name": "...", "url": "..." }, ...]
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_apps JSONB NOT NULL DEFAULT \'[]\'');

    // 2FA (autenticazione a due fattori, standard TOTP compatibile con Google
    // Authenticator, Authy, ecc.). totp_secret è la chiave segreta attiva
    // (impostata solo dopo che l'utente ha confermato il primo codice);
    // totp_pending_secret è la chiave generata durante la configurazione, non
    // ancora confermata — separarle evita che un utente resti "a metà"
    // configurazione con una chiave attiva che non ha mai verificato di saper
    // usare davvero.
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false');

    // Tracciamento visite (per la dashboard): una riga per ogni pagina
    // caricata, con paese/città dedotti dall'IP del visitatore. Niente dati
    // personali identificabili (no IP salvato, no cookie, no account collegato)
    // — solo la posizione geografica approssimata e la pagina visitata.
    await pool.query(
        'CREATE TABLE IF NOT EXISTS page_views (' +
        '  id SERIAL PRIMARY KEY,' +
        '  page TEXT NOT NULL,' +
        '  country TEXT,' +
        '  country_code TEXT,' +
        '  city TEXT,' +
        '  latitude DOUBLE PRECISION,' +
        '  longitude DOUBLE PRECISION,' +
        '  created_at TIMESTAMPTZ NOT NULL DEFAULT now()' +
        ')'
    );
    // Indice sulla data: quasi tutte le query della dashboard filtrano per
    // "ultimi N giorni", questo le mantiene veloci anche con molte righe.
    await pool.query('CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views (created_at)');
    // ID anonimo generato dal browser (non un account, non un IP): permette
    // di distinguere "5 visite di 5 persone diverse" da "5 visite della
    // stessa persona", senza identificare nessuno.
    await pool.query('ALTER TABLE page_views ADD COLUMN IF NOT EXISTS visitor_id TEXT');

    // Cache dei risultati di ricerca: evita di richiamare Brave/Serper per
    // query già cercate di recente da qualsiasi utente. cache_key combina
    // query normalizzata + tipo + pagina, così "pizza" pagina 1 e pagina 2
    // restano voci separate. expires_at determina quando la voce va
    // considerata "vecchia" e ricalcolata.
    await pool.query(
        'CREATE TABLE IF NOT EXISTS search_cache (' +
        '  cache_key TEXT PRIMARY KEY,' +
        '  results JSONB NOT NULL,' +
        '  source TEXT NOT NULL,' +
        '  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),' +
        '  expires_at TIMESTAMPTZ NOT NULL' +
        ')'
    );
    await pool.query('CREATE INDEX IF NOT EXISTS idx_search_cache_expires ON search_cache (expires_at)');

    // Blog: articoli scritti in markdown, con stato bozza/pubblicato.
    // "slug" è la versione URL-friendly del titolo (es. "la-mia-storia"),
    // usata nell'indirizzo della pagina dell'articolo.
    await pool.query(
        'CREATE TABLE IF NOT EXISTS blog_posts (' +
        '  id SERIAL PRIMARY KEY,' +
        '  slug TEXT UNIQUE NOT NULL,' +
        '  title TEXT NOT NULL,' +
        '  excerpt TEXT,' +
        '  content TEXT NOT NULL,' +
        '  cover_image TEXT,' +
        '  category TEXT,' +
        '  author TEXT,' +
        '  tags TEXT[] NOT NULL DEFAULT \'{}\',' +
        '  read_time_minutes INTEGER NOT NULL DEFAULT 1,' +
        '  card_size TEXT NOT NULL DEFAULT \'medium\',' +
        '  sort_order INTEGER NOT NULL DEFAULT 0,' +
        '  published BOOLEAN NOT NULL DEFAULT false,' +
        '  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),' +
        '  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),' +
        '  published_at TIMESTAMPTZ' +
        ')'
    );
    // Se la tabella blog_posts esisteva già da prima di queste colonne,
    // le aggiungiamo qui senza toccare gli articoli già scritti.
    await pool.query('ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS category TEXT');
    await pool.query('ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS author TEXT');
    await pool.query('ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT \'{}\'');
    await pool.query('ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS read_time_minutes INTEGER NOT NULL DEFAULT 1');
    await pool.query('ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS card_size TEXT NOT NULL DEFAULT \'medium\'');
    await pool.query('ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0');
    // Per gli articoli già esistenti (sort_order tutti a 0 di default),
    // assegniamo un ordine iniziale basato sulla data di creazione, così il
    // trascinamento nel pannello admin parte da un ordine sensato.
    await pool.query(
        'UPDATE blog_posts SET sort_order = sub.rn FROM (' +
        '  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn FROM blog_posts' +
        ') sub WHERE blog_posts.id = sub.id AND blog_posts.sort_order = 0'
    );

    // Rate limiting persistente (es. richieste di reset password). Ogni riga
    // rappresenta una "finestra" di conteggio per una chiave (es. "reset-email:x@y.it"
    // oppure "reset-ip:1.2.3.4"). A differenza di una Map in memoria, questi contatori
    // sopravvivono ai riavvii del server (frequenti su Render) e sono condivisi se in
    // futuro ci fossero più istanze del backend.
    await pool.query(
        'CREATE TABLE IF NOT EXISTS rate_limits (' +
        '  limit_key TEXT PRIMARY KEY,' +
        '  attempt_count INTEGER NOT NULL DEFAULT 1,' +
        '  window_start TIMESTAMPTZ NOT NULL DEFAULT now()' +
        ')'
    );

    console.log('Database pronto (tabella users verificata/creata).');
}

// Usato SOLO se DATABASE_URL non è configurata (vedi sopra).
const memoryUsers = new Map();

// ---- IA: Anthropic (Claude) con Gemini come riserva ----
// Le tre funzioni sotto sono usate da /api/ask, /api/overview e /api/vision.
// getAiAnswer() prova sempre prima Claude; solo se quella chiamata fallisce
// (credito esaurito, chiave mancante, errore del servizio, timeout) passa
// automaticamente a Gemini, senza che l'utente se ne accorga.

// Converte i messaggi in formato Anthropic (role "user"/"assistant", content
// stringa o array di blocchi tipo {type:"text"} / {type:"image"}) nel formato
// richiesto da Gemini (role "user"/"model", parts: [...]).
function toGeminiContents(anthropicMessages) {
    return anthropicMessages.map(function (m) {
        const role = (m.role === 'assistant') ? 'model' : 'user';
        let parts;
        if (typeof m.content === 'string') {
            parts = [{ text: m.content }];
        } else if (Array.isArray(m.content)) {
            parts = m.content.map(function (block) {
                if (block.type === 'image') {
                    return { inline_data: { mime_type: block.source.media_type, data: block.source.data } };
                }
                return { text: block.text || '' };
            });
        } else {
            parts = [{ text: '' }];
        }
        return { role: role, parts: parts };
    });
}

// Chiama Claude (Anthropic). Ritorna il testo della risposta, oppure lancia
// un errore se la chiamata fallisce per qualsiasi motivo — l'errore viene
// intercettato da getAiAnswer() per tentare automaticamente Gemini.
async function callAnthropic(anthropicMessages) {
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY non configurata');

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
        throw new Error('Anthropic ' + response.status + ': ' + errText);
    }

    const data = await response.json();
    return (data.content || [])
        .map(function (block) { return block.type === 'text' ? block.text : ''; })
        .filter(Boolean)
        .join('\n');
}

// Chiama Gemini (Google) con lo stesso formato di messaggi, convertito da
// toGeminiContents(). Usato SOLO come riserva quando Anthropic non risponde.
async function callGemini(anthropicMessages) {
    if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY non configurata');

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_API_KEY;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: toGeminiContents(anthropicMessages),
            generationConfig: { maxOutputTokens: 1000 }
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error('Gemini ' + response.status + ': ' + errText);
    }

    const data = await response.json();
    const candidate = (data.candidates && data.candidates[0]) || null;
    const parts = candidate && candidate.content && candidate.content.parts;
    return Array.isArray(parts) ? parts.map(function (p) { return p.text || ''; }).join('\n') : '';
}

// Punto d'ingresso unico: prova prima Claude, e SOLO se fallisce passa a
// Gemini come riserva. Ritorna { answer, provider } così i log (e volendo
// anche il frontend) sanno sempre quale dei due ha risposto davvero. Se
// falliscono entrambi (o nessuno dei due è configurato), lancia un errore
// che il chiamante trasforma in una risposta 502 per l'utente.
async function getAiAnswer(anthropicMessages) {
    try {
        const answer = await callAnthropic(anthropicMessages);
        return { answer: answer, provider: 'anthropic' };
    } catch (anthropicErr) {
        console.error('Anthropic non disponibile, provo con Gemini come riserva:', anthropicErr.message);
        try {
            const answer = await callGemini(anthropicMessages);
            return { answer: answer, provider: 'gemini' };
        } catch (geminiErr) {
            console.error('Anche Gemini non disponibile:', geminiErr.message);
            throw new Error('Nessun servizio IA disponibile al momento.');
        }
    }
}

// ---- RICH RESULT: calcoli e conversioni di unità ----
// Prima di interrogare Brave/Serper, controlliamo se la query è un calcolo
// matematico semplice (es. "45 * 3.7") o una conversione di unità (es.
// "12 km in miglia"). Se sì, calcoliamo la risposta noi stessi e la
// restituiamo insieme ai risultati di ricerca normali, così l'utente la vede
// subito senza dover cliccare su un link esterno.

// Valuta un'espressione aritmetica in modo sicuro: accetta SOLO cifre,
// operatori (+ - * / ^ %), punto decimale, parentesi e spazi. Qualsiasi altro
// carattere (lettere, punto e virgola, backtick, ecc.) fa fallire il
// riconoscimento, quindi non è mai possibile eseguire codice arbitrario.
function tryEvaluateMathExpression(query) {
    const trimmed = query.trim();

    // Deve contenere almeno un operatore matematico, altrimenti "2024" o
    // "1" verrebbero trattati come calcoli invece che come ricerche normali.
    if (!/[+\-*/^%]/.test(trimmed)) return null;

    // Solo caratteri ammessi per un'espressione aritmetica.
    if (!/^[0-9+\-*/^%().,\s]+$/.test(trimmed)) return null;

    // Deve contenere almeno una cifra (evita che "---" o "()" passino il test).
    if (!/[0-9]/.test(trimmed)) return null;

    const normalized = trimmed
        .replace(/,/g, '.')   // 3,5 -> 3.5 (notazione italiana)
        .replace(/\^/g, '**'); // ^ come elevamento a potenza

    try {
        // new Function invece di eval(): stesso motore di valutazione, ma
        // senza accesso allo scope esterno. Sicuro qui perché l'input è già
        // stato ristretto ai soli caratteri aritmetici sopra.
        const value = new Function('"use strict"; return (' + normalized + ')')();
        if (typeof value !== 'number' || !isFinite(value)) return null;

        const rounded = Math.round(value * 1e10) / 1e10; // ripulisce errori di virgola mobile
        return {
            kind: 'calc',
            label: trimmed,
            value: rounded,
            display: rounded.toLocaleString('it-IT', { maximumFractionDigits: 10 })
        };
    } catch (err) {
        return null;
    }
}

// Tabella di conversioni supportate: ogni voce converte da un'unità "base"
// (in cui sono espressi i fattori) verso tutte le altre nello stesso gruppo.
const UNIT_GROUPS = [
    {
        base: 'm',
        units: {
            km: { factor: 1000, names: ['km', 'chilometri', 'chilometro'] },
            m: { factor: 1, names: ['m', 'metri', 'metro'] },
            cm: { factor: 0.01, names: ['cm', 'centimetri', 'centimetro'] },
            mi: { factor: 1609.344, names: ['mi', 'miglia', 'miglio'] },
            yd: { factor: 0.9144, names: ['yd', 'iarde', 'iarda'] },
            ft: { factor: 0.3048, names: ['ft', 'piedi', 'piede'] }
        }
    },
    {
        base: 'kg',
        units: {
            kg: { factor: 1, names: ['kg', 'chilogrammi', 'chilogrammo', 'chili', 'chilo'] },
            g: { factor: 0.001, names: ['g', 'grammi', 'grammo'] },
            lb: { factor: 0.45359237, names: ['lb', 'libbre', 'libbra', 'lbs'] },
            oz: { factor: 0.028349523125, names: ['oz', 'once', 'oncia'] }
        }
    },
    {
        base: 'l',
        units: {
            l: { factor: 1, names: ['l', 'litri', 'litro'] },
            ml: { factor: 0.001, names: ['ml', 'millilitri', 'millilitro'] },
            gal: { factor: 3.785411784, names: ['gal', 'galloni', 'gallone'] }
        }
    }
];

// Cerca "<numero> <unità> in <unità>" (es. "12 km in miglia", "5 kg a libbre").
function tryEvaluateUnitConversion(query) {
    const match = query.trim().toLowerCase().match(
        /^([\d.,]+)\s*([a-zàèìòù]+)\s+(?:in|a)\s+([a-zàèìòù]+)$/i
    );
    if (!match) return null;

    const amount = parseFloat(match[1].replace(',', '.'));
    if (!isFinite(amount)) return null;

    const fromToken = match[2];
    const toToken = match[3];

    for (const group of UNIT_GROUPS) {
        let fromUnit = null, fromKey = null, toUnit = null, toKey = null;
        for (const key in group.units) {
            if (group.units[key].names.indexOf(fromToken) !== -1) { fromUnit = group.units[key]; fromKey = key; }
            if (group.units[key].names.indexOf(toToken) !== -1) { toUnit = group.units[key]; toKey = key; }
        }
        if (fromUnit && toUnit) {
            const valueInBase = amount * fromUnit.factor;
            const converted = valueInBase / toUnit.factor;
            const rounded = Math.round(converted * 100) / 100;
            return {
                kind: 'conversion',
                fromLabel: amount.toLocaleString('it-IT') + ' ' + fromKey,
                toLabel: rounded.toLocaleString('it-IT', { maximumFractionDigits: 2 }) + ' ' + toKey
            };
        }
    }
    return null;
}

// Punto d'ingresso unico: prova prima la conversione (più specifica), poi il
// calcolo. Ritorna null se la query non corrisponde a nessuno dei due casi,
// nel qual caso si procede con la ricerca web normale.
function computeRichResult(query) {
    if (!query || query.length > 200) return null;
    return tryEvaluateUnitConversion(query) || tryEvaluateMathExpression(query);
}

// Quanto resta valida una voce di cache prima di essere ricalcolata.
const SEARCH_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 ore

// Costruisce una chiave di cache stabile per una combinazione di ricerca.
// Query normalizzata (minuscolo, spazi ripuliti) così "Pizza " e "pizza"
// condividono la stessa voce di cache.
function buildSearchCacheKey(query, type, page) {
    const normalizedQuery = (query || '').trim().toLowerCase().replace(/\s+/g, ' ');
    return type + ':' + page + ':' + normalizedQuery;
}

// Ritorna { results, source } se una voce valida (non scaduta) esiste in
// cache, altrimenti null. Se il database non è configurato, la cache è
// semplicemente disattivata (si torna sempre a chiamare Brave/Serper).
async function getCachedSearch(cacheKey) {
    if (!dbEnabled) return null;
    try {
        const result = await pool.query(
            'SELECT results, source FROM search_cache WHERE cache_key = $1 AND expires_at > now()',
            [cacheKey]
        );
        if (result.rows.length === 0) return null;
        return { results: result.rows[0].results, source: result.rows[0].source };
    } catch (err) {
        // Un problema con la cache non deve mai far fallire una ricerca:
        // logghiamo e trattiamo come "cache assente".
        console.error('Errore lettura search_cache:', err);
        return null;
    }
}

// Salva (o sovrascrive) una voce di cache con una nuova scadenza.
async function saveCachedSearch(cacheKey, results, source) {
    if (!dbEnabled) return;
    try {
        const expiresAt = new Date(Date.now() + SEARCH_CACHE_TTL_MS);
        await pool.query(
            'INSERT INTO search_cache (cache_key, results, source, expires_at) VALUES ($1, $2, $3, $4) ' +
            'ON CONFLICT (cache_key) DO UPDATE SET results = EXCLUDED.results, source = EXCLUDED.source, ' +
            '  created_at = now(), expires_at = EXCLUDED.expires_at',
            [cacheKey, JSON.stringify(results), source, expiresAt]
        );
    } catch (err) {
        console.error('Errore scrittura search_cache:', err);
    }
}

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
        verifyTokenExpires: row.verify_token_expires ? new Date(row.verify_token_expires).getTime() : null,
        stripeCustomerId: row.stripe_customer_id,
        suspended: row.suspended,
        suspendedReason: row.suspended_reason,
        totpSecret: row.totp_secret,
        totpPendingSecret: row.totp_pending_secret,
        totpEnabled: row.totp_enabled,
        createdAt: row.created_at
    };
}

async function getUserById(id) {
    if (!id) return null;
    if (!dbEnabled) return memoryUsers.get(id) || null;
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rowToUser(result.rows[0]);
}

// Cerca un utente in base al suo ID cliente Stripe (usato dal webhook quando
// un abbonamento viene annullato dal Customer Portal: Stripe ci parla solo
// del customer id, non del nostro account interno).
async function getUserByStripeCustomerId(customerId) {
    if (!customerId) return null;
    if (!dbEnabled) {
        for (const user of memoryUsers.values()) {
            if (user.stripeCustomerId === customerId) return user;
        }
        return null;
    }
    const result = await pool.query('SELECT * FROM users WHERE stripe_customer_id = $1', [customerId]);
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
        'INSERT INTO users (id, email, name, surname, picture, is_pro, message_count, window_start, provider, password_hash, reset_token, reset_token_expires, email_verified, verify_token, verify_token_expires, stripe_customer_id, suspended, suspended_reason, totp_secret, totp_pending_secret, totp_enabled) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) ' +
        'ON CONFLICT (id) DO UPDATE SET ' +
        '  email = EXCLUDED.email, name = EXCLUDED.name, surname = EXCLUDED.surname, picture = EXCLUDED.picture, ' +
        '  is_pro = EXCLUDED.is_pro, message_count = EXCLUDED.message_count, window_start = EXCLUDED.window_start, ' +
        '  provider = EXCLUDED.provider, password_hash = EXCLUDED.password_hash, ' +
        '  reset_token = EXCLUDED.reset_token, reset_token_expires = EXCLUDED.reset_token_expires, ' +
        '  email_verified = EXCLUDED.email_verified, verify_token = EXCLUDED.verify_token, ' +
        '  verify_token_expires = EXCLUDED.verify_token_expires, stripe_customer_id = EXCLUDED.stripe_customer_id, ' +
        '  suspended = EXCLUDED.suspended, suspended_reason = EXCLUDED.suspended_reason, ' +
        '  totp_secret = EXCLUDED.totp_secret, totp_pending_secret = EXCLUDED.totp_pending_secret, ' +
        '  totp_enabled = EXCLUDED.totp_enabled',
        [
            user.sub, user.email, user.name || null, user.surname || null, user.picture || null, !!user.isPro,
            user.messageCount || 0, new Date(user.windowStart || Date.now()), user.provider,
            user.passwordHash || null, user.resetToken || null,
            user.resetTokenExpires ? new Date(user.resetTokenExpires) : null,
            !!user.emailVerified, user.verifyToken || null,
            user.verifyTokenExpires ? new Date(user.verifyTokenExpires) : null,
            user.stripeCustomerId || null,
            !!user.suspended, user.suspendedReason || null,
            user.totpSecret || null, user.totpPendingSecret || null, !!user.totpEnabled
        ]
    );
    return user;
}

// Cancella definitivamente un account (usata dall'eliminazione self-service
// in profilo.html e dallo strumento gdpr-tool.js). Operazione irreversibile.
async function deleteUser(user) {
    if (!dbEnabled) {
        memoryUsers.delete(user.sub);
        return;
    }
    await pool.query('DELETE FROM users WHERE id = $1', [user.sub]);
}

async function getUserFromRequest(req) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, SESSION_SECRET);
        const user = await getUserById(decoded.sub);
        // Un account sospeso viene trattato come "non loggato" ovunque nel
        // sito, anche se ha ancora un token valido salvato nel browser: la
        // sospensione deve avere effetto immediato, non solo al prossimo login.
        if (user && user.suspended) return null;
        return user;
    } catch (err) {
        return null;
    }
}

// ---- 2FA: TOTP (stesso standard di Google Authenticator, Authy, ecc.) ----
// Implementato con il modulo "crypto" nativo di Node (RFC 4226 / RFC 6238),
// senza librerie esterne — niente da installare in più su Render.

// Le chiavi segrete TOTP si scrivono in Base32 (non Base64): è lo standard
// richiesto dalle app di autenticazione. Queste due funzioni convertono da/a
// Base32 usando solo Buffer nativi.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
    let bits = '';
    for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
    let output = '';
    for (let i = 0; i + 5 <= bits.length; i += 5) {
        output += BASE32_ALPHABET[parseInt(bits.substr(i, 5), 2)];
    }
    const remainder = bits.length % 5;
    if (remainder > 0) {
        const lastChunk = bits.substr(bits.length - remainder).padEnd(5, '0');
        output += BASE32_ALPHABET[parseInt(lastChunk, 2)];
    }
    return output;
}

function base32Decode(base32) {
    const clean = (base32 || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = '';
    for (const char of clean) {
        const val = BASE32_ALPHABET.indexOf(char);
        if (val === -1) continue;
        bits += val.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.substr(i, 8), 2));
    }
    return Buffer.from(bytes);
}

// Genera una nuova chiave segreta casuale (160 bit, la lunghezza standard
// consigliata dalla specifica TOTP) per un utente che sta attivando la 2FA.
function generateTotpSecret() {
    return base32Encode(crypto.randomBytes(20));
}

// Calcola il codice a 6 cifre per un dato "contatore" (finestra di 30 secondi
// dall'epoch Unix) — algoritmo HOTP/TOTP standard, RFC 4226/6238.
function generateTotpCode(secretBase32, counter) {
    const key = base32Decode(secretBase32);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binCode = ((hmac[offset] & 0x7f) << 24) |
                     ((hmac[offset + 1] & 0xff) << 16) |
                     ((hmac[offset + 2] & 0xff) << 8) |
                     (hmac[offset + 3] & 0xff);
    return String(binCode % 1000000).padStart(6, '0');
}

// Verifica il codice a 6 cifre digitato dall'utente. Controlla anche la
// finestra di 30 secondi immediatamente precedente e successiva a quella
// corrente, per tollerare un piccolo sfasamento tra l'orologio del telefono
// e quello del server (capita spesso, non è un bug).
function verifyTotpCode(secretBase32, code) {
    const cleanCode = (code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(cleanCode)) return false;
    const currentCounter = Math.floor(Date.now() / 1000 / 30);
    for (let drift = -1; drift <= 1; drift++) {
        if (generateTotpCode(secretBase32, currentCounter + drift) === cleanCode) return true;
    }
    return false;
}

// Costruisce l'URL "otpauth://" che le app di autenticazione leggono (di
// solito tramite QR code, generato lato frontend a partire da questo testo —
// il server non genera immagini, solo questa stringa).
function buildTotpOtpauthUrl(email, secretBase32) {
    const issuer = 'iAlgae';
    const label = encodeURIComponent(issuer + ':' + email);
    return 'otpauth://totp/' + label +
        '?secret=' + secretBase32 +
        '&issuer=' + encodeURIComponent(issuer) +
        '&algorithm=SHA1&digits=6&period=30';
}

// ---- Tracciamento visite: geolocalizzazione IP ----
// Usa ip-api.com (gratuito, senza chiave API, fino a 45 richieste/minuto —
// più che sufficiente: ogni IP viene comunque richiesto al massimo una volta
// al giorno grazie alla cache qui sotto). Se il servizio non risponde, la
// visita viene comunque registrata ma senza posizione, invece di bloccare
// tutto.
const geoIpCache = new Map(); // ip -> { data, timestamp }
const GEO_IP_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 ore

function isPrivateOrLocalIp(ip) {
    if (!ip) return true;
    return ip === '::1' || ip === '127.0.0.1' ||
        ip.startsWith('10.') || ip.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
}

async function getGeoForIp(ip) {
    const empty = { country: null, countryCode: null, city: null, lat: null, lon: null };
    if (isPrivateOrLocalIp(ip)) return empty;

    const cached = geoIpCache.get(ip);
    if (cached && (Date.now() - cached.timestamp) < GEO_IP_CACHE_TTL_MS) {
        return cached.data;
    }

    try {
        const response = await fetch(
            'http://ip-api.com/json/' + encodeURIComponent(ip) + '?fields=status,country,countryCode,city,lat,lon'
        );
        const json = await response.json();
        const data = (json.status === 'success')
            ? { country: json.country || null, countryCode: json.countryCode || null, city: json.city || null, lat: json.lat != null ? json.lat : null, lon: json.lon != null ? json.lon : null }
            : empty;
        geoIpCache.set(ip, { data: data, timestamp: Date.now() });
        return data;
    } catch (err) {
        return empty;
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
                    // L'ID di Google è nuovo, ma potrebbe esserci già un account
                    // con questa stessa email (es. registrato prima con email e
                    // password): in quel caso riusiamo quell'account invece di
                    // provare a crearne uno duplicato (l'email deve restare unica).
                    user = await getUserByEmail(googlePayload.email);
                    if (user) {
                        if (!user.picture) user.picture = googlePayload.picture;
                        user.emailVerified = true; // Google ha già verificato questa email
                        await saveUser(user);
                    } else {
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
                }

                if (user.suspended) {
                    return sendJSON(res, 403, {
                        error: 'account_suspended',
                        message: 'Il tuo account è stato sospeso per violazione dei Termini di Servizio. Se ritieni sia un errore, contattaci a info@ialgae.com.'
                    });
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
                    // Come per Google: se esiste già un account con questa email
                    // (es. registrato prima con email e password), lo riusiamo
                    // invece di crearne uno duplicato.
                    user = msEmail ? await getUserByEmail(msEmail) : null;
                    if (user) {
                        user.emailVerified = true; // Microsoft ha già verificato questa email
                        await saveUser(user);
                    } else {
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
                }

                if (user.suspended) {
                    return sendJSON(res, 403, {
                        error: 'account_suspended',
                        message: 'Il tuo account è stato sospeso per violazione dei Termini di Servizio. Se ritieni sia un errore, contattaci a info@ialgae.com.'
                    });
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

    // Aggiorna il nome dell'utente loggato (usato dalla pagina profilo.html).
    // Non permette di cambiare email o piano da qui: l'email è l'identificativo
    // dell'account, e il piano si cambia solo tramite il checkout Stripe.
    if (req.method === 'POST' && req.url === '/api/auth/update-profile') {
        let body = '';
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', async function () {
            try {
                const user = await getUserFromRequest(req);
                if (!user) {
                    return sendJSON(res, 401, { error: 'not_logged_in' });
                }

                let payload;
                try {
                    payload = JSON.parse(body || '{}');
                } catch (parseErr) {
                    return sendJSON(res, 400, { error: 'Corpo della richiesta non valido.' });
                }

                const newName = (payload.name || '').trim();
                if (!newName) {
                    return sendJSON(res, 400, { error: 'Il nome non può essere vuoto.' });
                }
                if (newName.length > 80) {
                    return sendJSON(res, 400, { error: 'Il nome è troppo lungo.' });
                }

                user.name = newName;
                await saveUser(user);

                return sendJSON(res, 200, {
                    user: { email: user.email, name: user.name, picture: user.picture || null, isPro: !!user.isPro }
                });
            } catch (err) {
                console.error('Errore update-profile:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Restituisce l'elenco delle app che l'utente loggato ha scelto di
    // nascondere, più le eventuali app personalizzate che ha aggiunto lui
    // stesso al proprio menu "I tuoi preferiti".
    if (req.method === 'GET' && req.url === '/api/user/hidden-apps') {
        (async function () {
            const user = await getUserFromRequest(req);
            if (!user) return sendJSON(res, 401, { error: 'not_logged_in' });
            try {
                const result = await pool.query('SELECT hidden_apps, custom_apps FROM users WHERE id = $1', [user.sub]);
                const row = result.rows[0] || {};
                return sendJSON(res, 200, {
                    hiddenApps: row.hidden_apps || [],
                    customApps: row.custom_apps || []
                });
            } catch (err) {
                console.error('Errore /api/user/hidden-apps GET:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        })();
        return;
    }

    // Salva la personalizzazione: solo un utente loggato può modificarla.
    // Riceve l'elenco COMPLETO aggiornato (app nascoste + app personalizzate),
    // non una singola modifica, così un doppio salvataggio non crea inconsistenze.
    if (req.method === 'POST' && req.url === '/api/user/hidden-apps') {
        let hiddenAppsBody = '';
        req.on('data', function (chunk) { hiddenAppsBody += chunk; });
        req.on('end', async function () {
            const user = await getUserFromRequest(req);
            if (!user) return sendJSON(res, 401, { error: 'not_logged_in' });
            try {
                let payload;
                try { payload = JSON.parse(hiddenAppsBody || '{}'); }
                catch (e) { return sendJSON(res, 400, { error: 'Corpo della richiesta non valido.' }); }

                const hiddenApps = Array.isArray(payload.hiddenApps)
                    ? payload.hiddenApps.map(function (n) { return String(n).trim(); }).filter(Boolean).slice(0, 200)
                    : [];

                // Ogni app personalizzata deve avere un nome e un indirizzo web
                // validi; scartiamo silenziosamente le voci malformate invece
                // di far fallire l'intero salvataggio.
                const customApps = Array.isArray(payload.customApps)
                    ? payload.customApps
                        .map(function (a) {
                            const name = String((a && a.name) || '').trim().slice(0, 40);
                            let url = String((a && a.url) || '').trim();
                            if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
                            return { name: name, url: url };
                        })
                        .filter(function (a) { return a.name && /^https?:\/\/.+/i.test(a.url); })
                        .slice(0, 30)
                    : [];

                await pool.query(
                    'UPDATE users SET hidden_apps = $1, custom_apps = $2 WHERE id = $3',
                    [hiddenApps, JSON.stringify(customApps), user.sub]
                );
                return sendJSON(res, 200, { message: 'Preferenze salvate.', hiddenApps: hiddenApps, customApps: customApps });
            } catch (err) {
                console.error('Errore /api/user/hidden-apps POST:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/api/auth/delete-account') {
        (async function () {
            try {
                const user = await getUserFromRequest(req);
                if (!user) {
                    return sendJSON(res, 401, { error: 'not_logged_in' });
                }

                if (stripe && user.stripeCustomerId) {
                    try {
                        const subscriptions = await stripe.subscriptions.list({
                            customer: user.stripeCustomerId,
                            status: 'active'
                        });
                        for (const sub of subscriptions.data) {
                            await stripe.subscriptions.cancel(sub.id);
                        }
                    } catch (stripeErr) {
                        // Non blocchiamo la cancellazione dell'account per un
                        // errore lato Stripe: logghiamo e procediamo comunque,
                        // così l'utente non resta bloccato. L'eventuale
                        // abbonamento andrà controllato manualmente.
                        console.error('Errore annullando l\'abbonamento Stripe durante l\'eliminazione account:', stripeErr);
                    }
                }

                await deleteUser(user);
                console.log('Account eliminato su richiesta dell\'utente:', user.email);

                return sendJSON(res, 200, { message: 'Account eliminato con successo.' });
            } catch (err) {
                console.error('Errore delete-account:', err);
                return sendJSON(res, 500, { error: 'Impossibile eliminare l\'account in questo momento.' });
            }
        })();
        return;
    }

    // Tracciamento visite (pubblico, nessun login richiesto): chiamato dal
    // frontend a ogni caricamento pagina (index.html, results.html, blog.html).
    // Non blocca mai la pagina dell'utente: qualsiasi errore qui dentro viene
    // ignorato in silenzio, la visita semplicemente non viene contata.
    if (req.method === 'POST' && req.url === '/api/track') {
        let body = '';
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', async function () {
            try {
                let payload;
                try {
                    payload = JSON.parse(body || '{}');
                } catch (parseErr) {
                    payload = {};
                }
                const page = (payload.page || '/').toString().slice(0, 200);
                const visitorId = (payload.visitorId || '').toString().slice(0, 64) || null;
                const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
                const geo = await getGeoForIp(ip);

                await pool.query(
                    'INSERT INTO page_views (page, country, country_code, city, latitude, longitude, visitor_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                    [page, geo.country, geo.countryCode, geo.city, geo.lat, geo.lon, visitorId]
                );
                return sendJSON(res, 200, { ok: true });
            } catch (err) {
                console.error('Errore tracciamento visita (non bloccante):', err.message);
                return sendJSON(res, 200, { ok: false });
            }
        });
        return;
    }

    // Dati aggregati per la dashboard admin: totale visite, andamento nel
    // tempo, classifica paesi/città, pagine più visitate. Stessa protezione
    // con ADMIN_SECRET degli altri endpoint admin qui sotto.
    if (req.method === 'GET' && req.url.indexOf('/api/admin/pageviews/summary') === 0) {
        (async function () {
            try {
                if (!ADMIN_SECRET) {
                    return sendJSON(res, 500, { error: 'ADMIN_SECRET non configurata sul server.' });
                }
                const parsedUrl = new URL(req.url, 'http://localhost');
                const secret = parsedUrl.searchParams.get('secret') || '';
                if (secret !== ADMIN_SECRET) {
                    return sendJSON(res, 401, { error: 'Password errata.' });
                }

                const days = Math.min(Math.max(parseInt(parsedUrl.searchParams.get('days'), 10) || 30, 1), 90);

                const totalResult = await pool.query(
                    "SELECT COUNT(*)::int AS total, COUNT(DISTINCT visitor_id)::int AS unique_visitors " +
                    "FROM page_views WHERE created_at >= now() - ($1::int * interval '1 day')",
                    [days]
                );

                // Stesso numero di giorni, ma SUBITO PRIMA del periodo corrente:
                // serve solo per calcolare "+18% rispetto al periodo precedente",
                // non compare da nessun'altra parte.
                const previousResult = await pool.query(
                    "SELECT COUNT(*)::int AS total FROM page_views " +
                    "WHERE created_at >= now() - ($1::int * interval '1 day') * 2 " +
                    "  AND created_at < now() - ($1::int * interval '1 day')",
                    [days]
                );

                const byDayResult = await pool.query(
                    "SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count " +
                    "FROM page_views WHERE created_at >= now() - ($1::int * interval '1 day') " +
                    'GROUP BY 1 ORDER BY 1',
                    [days]
                );

                const topCountriesResult = await pool.query(
                    'SELECT country, country_code AS "countryCode", COUNT(*)::int AS count ' +
                    "FROM page_views WHERE created_at >= now() - ($1::int * interval '1 day') AND country IS NOT NULL " +
                    'GROUP BY country, country_code ORDER BY count DESC LIMIT 10',
                    [days]
                );

                const topCitiesResult = await pool.query(
                    'SELECT city, country, country_code AS "countryCode", AVG(latitude) AS lat, AVG(longitude) AS lon, COUNT(*)::int AS count ' +
                    "FROM page_views WHERE created_at >= now() - ($1::int * interval '1 day') AND city IS NOT NULL AND latitude IS NOT NULL " +
                    'GROUP BY city, country, country_code ORDER BY count DESC LIMIT 40',
                    [days]
                );

                const topPagesResult = await pool.query(
                    'SELECT page, COUNT(*)::int AS count ' +
                    "FROM page_views WHERE created_at >= now() - ($1::int * interval '1 day') " +
                    'GROUP BY page ORDER BY count DESC LIMIT 10',
                    [days]
                );

                const total = totalResult.rows[0].total;
                const previousTotal = previousResult.rows[0].total;
                // Variazione percentuale rispetto al periodo precedente. Se prima
                // era zero, evitiamo una divisione per zero (mostriamo null: il
                // frontend lo interpreta come "dato non disponibile", non "0%").
                const percentChange = previousTotal > 0
                    ? Math.round(((total - previousTotal) / previousTotal) * 1000) / 10
                    : null;

                return sendJSON(res, 200, {
                    totalViews: total,
                    uniqueVisitors: totalResult.rows[0].unique_visitors,
                    previousTotalViews: previousTotal,
                    percentChange: percentChange,
                    viewsByDay: byDayResult.rows,
                    topCountries: topCountriesResult.rows,
                    topCities: topCitiesResult.rows.map(function (r) {
                        return { city: r.city, country: r.country, countryCode: r.countryCode, lat: parseFloat(r.lat), lon: parseFloat(r.lon), count: r.count };
                    }),
                    topPages: topPagesResult.rows
                });
            } catch (err) {
                console.error('Errore statistiche pageviews:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        })();
        return;
    }

    // Statistiche interne (iscrizioni giornaliere, totali). Protetto da una
    // chiave segreta passata come query string, dato che non esiste un vero
    // sistema di ruoli admin sul sito: solo chi conosce ADMIN_SECRET può
    // vedere questi dati. Pensato per essere consultato da admin-stats.html.
    if (req.method === 'GET' && req.url.indexOf('/api/admin/signups') === 0) {
        (async function () {
            try {
                if (!ADMIN_SECRET) {
                    return sendJSON(res, 500, { error: 'ADMIN_SECRET non configurata sul server.' });
                }
                const fullUrl = new URL(req.url, 'http://localhost');
                const secret = fullUrl.searchParams.get('secret') || '';
                if (secret !== ADMIN_SECRET) {
                    return sendJSON(res, 401, { error: 'Chiave non valida.' });
                }
                if (!dbEnabled) {
                    return sendJSON(res, 500, { error: 'Database non configurato: nessuna statistica disponibile.' });
                }

                const dailyResult = await pool.query(
                    "SELECT to_char(created_at, 'YYYY-MM-DD') AS day, COUNT(*)::int AS count " +
                    'FROM users WHERE created_at >= now() - interval \'30 days\' ' +
                    'GROUP BY day ORDER BY day'
                );
                const totalsResult = await pool.query(
                    'SELECT COUNT(*)::int AS total, ' +
                    'COUNT(*) FILTER (WHERE is_pro)::int AS pro_count ' +
                    'FROM users'
                );

                return sendJSON(res, 200, {
                    daily: dailyResult.rows,
                    total: totalsResult.rows[0].total,
                    proCount: totalsResult.rows[0].pro_count
                });
            } catch (err) {
                console.error('Errore admin/signups:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        })();
        return;
    }

    // Cerca un utente per email (pannello "Gestione utenti" in admin-stats.html).
    if (req.method === 'GET' && req.url.indexOf('/api/admin/find-user') === 0) {
        (async function () {
            try {
                if (!ADMIN_SECRET) {
                    return sendJSON(res, 500, { error: 'ADMIN_SECRET non configurata sul server.' });
                }
                const fullUrl = new URL(req.url, 'http://localhost');
                const secret = fullUrl.searchParams.get('secret') || '';
                if (secret !== ADMIN_SECRET) {
                    return sendJSON(res, 401, { error: 'Chiave non valida.' });
                }
                const email = (fullUrl.searchParams.get('email') || '').trim().toLowerCase();
                if (!email) {
                    return sendJSON(res, 400, { error: 'Email mancante.' });
                }

                const user = await getUserByEmail(email);
                if (!user) {
                    return sendJSON(res, 404, { error: 'Nessun utente trovato con questa email.' });
                }

                return sendJSON(res, 200, {
                    user: {
                        email: user.email,
                        name: user.name,
                        isPro: !!user.isPro,
                        provider: user.provider,
                        createdAt: user.createdAt,
                        suspended: !!user.suspended,
                        suspendedReason: user.suspendedReason || null
                    }
                });
            } catch (err) {
                console.error('Errore admin/find-user:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        })();
        return;
    }

    // Sospende un account: da questo momento non può più accedere (login
    // bloccato e sessioni già aperte invalidate), ma i dati restano intatti
    // — a differenza della cancellazione, è un'azione reversibile.
    if (req.method === 'POST' && req.url === '/api/admin/suspend-user') {
        let suspendBody = '';
        req.on('data', function (chunk) { suspendBody += chunk; });
        req.on('end', async function () {
            try {
                if (!ADMIN_SECRET) {
                    return sendJSON(res, 500, { error: 'ADMIN_SECRET non configurata sul server.' });
                }
                let payload;
                try {
                    payload = JSON.parse(suspendBody || '{}');
                } catch (parseErr) {
                    return sendJSON(res, 400, { error: 'Corpo della richiesta non valido.' });
                }
                if (payload.secret !== ADMIN_SECRET) {
                    return sendJSON(res, 401, { error: 'Chiave non valida.' });
                }
                const email = (payload.email || '').trim().toLowerCase();
                if (!email) {
                    return sendJSON(res, 400, { error: 'Email mancante.' });
                }

                const user = await getUserByEmail(email);
                if (!user) {
                    return sendJSON(res, 404, { error: 'Nessun utente trovato con questa email.' });
                }

                user.suspended = true;
                user.suspendedReason = (payload.reason || '').trim() || null;
                await saveUser(user);
                console.log('Account sospeso da admin:', user.email, '-', user.suspendedReason || '(nessun motivo indicato)');

                return sendJSON(res, 200, { message: 'Account sospeso.' });
            } catch (err) {
                console.error('Errore admin/suspend-user:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Riattiva un account precedentemente sospeso.
    if (req.method === 'POST' && req.url === '/api/admin/unsuspend-user') {
        let unsuspendBody = '';
        req.on('data', function (chunk) { unsuspendBody += chunk; });
        req.on('end', async function () {
            try {
                if (!ADMIN_SECRET) {
                    return sendJSON(res, 500, { error: 'ADMIN_SECRET non configurata sul server.' });
                }
                let payload;
                try {
                    payload = JSON.parse(unsuspendBody || '{}');
                } catch (parseErr) {
                    return sendJSON(res, 400, { error: 'Corpo della richiesta non valido.' });
                }
                if (payload.secret !== ADMIN_SECRET) {
                    return sendJSON(res, 401, { error: 'Chiave non valida.' });
                }
                const email = (payload.email || '').trim().toLowerCase();
                if (!email) {
                    return sendJSON(res, 400, { error: 'Email mancante.' });
                }

                const user = await getUserByEmail(email);
                if (!user) {
                    return sendJSON(res, 404, { error: 'Nessun utente trovato con questa email.' });
                }

                user.suspended = false;
                user.suspendedReason = null;
                await saveUser(user);
                console.log('Account riattivato da admin:', user.email);

                return sendJSON(res, 200, { message: 'Account riattivato.' });
            } catch (err) {
                console.error('Errore admin/unsuspend-user:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Cancella definitivamente un account (stessa logica dell'eliminazione
    // self-service: annulla anche un eventuale abbonamento Stripe attivo,
    // così non resta un addebito su un account che non esiste più).
    if (req.method === 'POST' && req.url === '/api/admin/delete-user') {
        let deleteBody = '';
        req.on('data', function (chunk) { deleteBody += chunk; });
        req.on('end', async function () {
            try {
                if (!ADMIN_SECRET) {
                    return sendJSON(res, 500, { error: 'ADMIN_SECRET non configurata sul server.' });
                }
                let payload;
                try {
                    payload = JSON.parse(deleteBody || '{}');
                } catch (parseErr) {
                    return sendJSON(res, 400, { error: 'Corpo della richiesta non valido.' });
                }
                if (payload.secret !== ADMIN_SECRET) {
                    return sendJSON(res, 401, { error: 'Chiave non valida.' });
                }
                const email = (payload.email || '').trim().toLowerCase();
                if (!email) {
                    return sendJSON(res, 400, { error: 'Email mancante.' });
                }

                const user = await getUserByEmail(email);
                if (!user) {
                    return sendJSON(res, 404, { error: 'Nessun utente trovato con questa email.' });
                }

                if (stripe && user.stripeCustomerId) {
                    try {
                        const subscriptions = await stripe.subscriptions.list({
                            customer: user.stripeCustomerId,
                            status: 'active'
                        });
                        for (const sub of subscriptions.data) {
                            await stripe.subscriptions.cancel(sub.id);
                        }
                    } catch (stripeErr) {
                        console.error('Errore annullando abbonamento Stripe durante eliminazione admin:', stripeErr);
                    }
                }

                await deleteUser(user);
                console.log('Account eliminato da admin:', email);

                return sendJSON(res, 200, { message: 'Account eliminato.' });
            } catch (err) {
                console.error('Errore admin/delete-user:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
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

                if (user.suspended) {
                    return sendJSON(res, 403, {
                        error: 'account_suspended',
                        message: 'Il tuo account è stato sospeso per violazione dei Termini di Servizio. Se ritieni sia un errore, contattaci a info@ialgae.com.'
                    });
                }

                // Se l'utente ha attivato la 2FA, la password da sola non basta:
                // invece del token di sessione completo, diamo un token
                // "temporaneo" valido solo 5 minuti e solo per completare il
                // secondo passaggio — non permette nessun'altra azione sul sito.
                if (user.totpEnabled) {
                    const twoFactorToken = jwt.sign(
                        { sub: user.sub, purpose: '2fa-pending' },
                        SESSION_SECRET,
                        { expiresIn: '5m' }
                    );
                    return sendJSON(res, 200, {
                        requires2FA: true,
                        twoFactorToken: twoFactorToken
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

    // Secondo passaggio del login quando la 2FA è attiva: riceve il token
    // temporaneo (dato da /api/auth/login) più il codice a 6 cifre digitato
    // dall'utente, e SOLO se corretto restituisce il vero token di sessione.
    if (req.method === 'POST' && req.url === '/api/auth/2fa/login-verify') {
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

                const twoFactorToken = payload.twoFactorToken || '';
                const code = (payload.code || '').toString();

                let decoded;
                try {
                    decoded = jwt.verify(twoFactorToken, SESSION_SECRET);
                } catch (err) {
                    return sendJSON(res, 401, { error: 'Sessione di accesso scaduta. Rifai il login.' });
                }
                if (decoded.purpose !== '2fa-pending') {
                    return sendJSON(res, 401, { error: 'Token non valido.' });
                }

                const user = await getUserById(decoded.sub);
                if (!user || !user.totpEnabled || !user.totpSecret) {
                    return sendJSON(res, 401, { error: 'La 2FA non risulta attiva su questo account.' });
                }

                // Limite di tentativi: un codice a 6 cifre ha "solo" un milione
                // di combinazioni — senza un limite, sarebbe indovinabile a
                // forza bruta in un tempo ragionevole. Max 8 tentativi ogni 10
                // minuti per account, persistente su Postgres (sopravvive ai
                // riavvii del server, come gli altri rate limit del sito).
                const attemptCheck = await checkAndConsumeRateLimitPersistent(
                    '2fa-verify', user.sub, 8, 10 * 60 * 1000, memory2faAttempts
                );
                if (!attemptCheck.allowed) {
                    return sendJSON(res, 429, { error: 'Troppi tentativi. Riprova tra qualche minuto.' });
                }

                if (!verifyTotpCode(user.totpSecret, code)) {
                    return sendJSON(res, 401, { error: 'Codice non valido o scaduto.' });
                }

                const sessionToken = jwt.sign({ sub: user.sub }, SESSION_SECRET, { expiresIn: '30d' });
                return sendJSON(res, 200, {
                    sessionToken: sessionToken,
                    user: { email: user.email, name: user.name, picture: user.picture, isPro: user.isPro }
                });

            } catch (err) {
                console.error('Errore verifica 2FA login:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Avvia la configurazione della 2FA per l'utente loggato: genera una nuova
    // chiave segreta "in sospeso" (non ancora attiva finché non viene
    // confermata con un codice reale, vedi /api/auth/2fa/confirm) e restituisce
    // sia la chiave in chiaro (per l'inserimento manuale) sia l'URL "otpauth://"
    // da cui il frontend genera il QR code da inquadrare con l'app.
    if (req.method === 'POST' && req.url === '/api/auth/2fa/setup') {
        (async function () {
            try {
                const user = await getUserFromRequest(req);
                if (!user) return sendJSON(res, 401, { error: 'Devi essere loggato.' });
                if (user.totpEnabled) {
                    return sendJSON(res, 400, { error: 'La 2FA è già attiva su questo account.' });
                }

                const secret = generateTotpSecret();
                user.totpPendingSecret = secret;
                await saveUser(user);

                return sendJSON(res, 200, {
                    secret: secret,
                    otpauthUrl: buildTotpOtpauthUrl(user.email, secret)
                });
            } catch (err) {
                console.error('Errore setup 2FA:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        })();
        return;
    }

    // Conferma la configurazione: l'utente inserisce il primo codice generato
    // dalla sua app di autenticazione. Se è corretto, la chiave "in sospeso"
    // diventa quella attiva — da questo momento la 2FA è davvero richiesta al
    // login. Se sbagliato, la chiave in sospeso resta tale (nessuna modifica),
    // così l'utente può semplicemente riprovare.
    if (req.method === 'POST' && req.url === '/api/auth/2fa/confirm') {
        let body = '';
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', async function () {
            try {
                const user = await getUserFromRequest(req);
                if (!user) return sendJSON(res, 401, { error: 'Devi essere loggato.' });
                if (!user.totpPendingSecret) {
                    return sendJSON(res, 400, { error: 'Nessuna configurazione 2FA in corso. Ricomincia da /api/auth/2fa/setup.' });
                }

                let payload;
                try {
                    payload = JSON.parse(body || '{}');
                } catch (parseErr) {
                    return sendJSON(res, 400, { error: 'Corpo della richiesta non valido.' });
                }
                const code = (payload.code || '').toString();

                if (!verifyTotpCode(user.totpPendingSecret, code)) {
                    return sendJSON(res, 401, { error: 'Codice non valido. Controlla l\'app e riprova.' });
                }

                user.totpSecret = user.totpPendingSecret;
                user.totpPendingSecret = null;
                user.totpEnabled = true;
                await saveUser(user);

                return sendJSON(res, 200, { success: true, message: '2FA attivata con successo.' });
            } catch (err) {
                console.error('Errore conferma 2FA:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Disattiva la 2FA. Richiede la password attuale come riconferma (non
    // basta essere loggati con un token già in tasca): evita che chi trova un
    // dispositivo sbloccato di qualcun altro possa disattivare la protezione
    // in pochi secondi.
    if (req.method === 'POST' && req.url === '/api/auth/2fa/disable') {
        let body = '';
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', async function () {
            try {
                const user = await getUserFromRequest(req);
                if (!user) return sendJSON(res, 401, { error: 'Devi essere loggato.' });

                let payload;
                try {
                    payload = JSON.parse(body || '{}');
                } catch (parseErr) {
                    return sendJSON(res, 400, { error: 'Corpo della richiesta non valido.' });
                }
                const password = payload.password || '';

                if (!user.passwordHash || !verifyPassword(password, user.passwordHash)) {
                    return sendJSON(res, 401, { error: 'Password non corretta.' });
                }

                user.totpEnabled = false;
                user.totpSecret = null;
                user.totpPendingSecret = null;
                await saveUser(user);

                return sendJSON(res, 200, { success: true, message: '2FA disattivata.' });
            } catch (err) {
                console.error('Errore disattivazione 2FA:', err);
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

                // Limite di frequenza: max MAX_RESET_REQUESTS richieste per
                // ora, sia per email (evita spam ripetuto verso lo stesso
                // utente) sia per IP (evita che una sola sorgente bombardi
                // email diverse). La risposta in caso di blocco resta
                // generica, per non rivelare quali email sono registrate.
                const resetIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
                const emailCheck = await checkAndConsumeRateLimitPersistent('reset-email', email, MAX_RESET_REQUESTS, RESET_RATE_LIMIT_WINDOW_MS, resetRateLimitByEmail);
                const ipCheck = await checkAndConsumeRateLimitPersistent('reset-ip', resetIp, MAX_RESET_REQUESTS, RESET_RATE_LIMIT_WINDOW_MS, resetRateLimitByIp);
                if (!emailCheck.allowed || !ipCheck.allowed) {
                    return sendJSON(res, 429, {
                        error: 'limit_reached',
                        message: 'Hai richiesto troppi reset password di recente. Riprova tra qualche minuto.'
                    });
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

    // Apre il Customer Portal di Stripe: da lì l'utente può vedere fatture,
    // aggiornare il metodo di pagamento, o annullare/declassare da solo il
    // proprio abbonamento, senza bisogno di contattarci.
    if (req.method === 'POST' && req.url === '/api/create-portal-session') {
        (async function () {
            try {
                if (!stripe) {
                    return sendJSON(res, 500, { error: 'Pagamenti non configurati sul server (STRIPE_SECRET_KEY mancante).' });
                }

                const user = await getUserFromRequest(req);
                if (!user) {
                    return sendJSON(res, 401, { error: 'not_logged_in' });
                }

                let customerId = user.stripeCustomerId;

                // Utenti diventati Pro prima che salvassimo lo stripeCustomerId
                // potrebbero non averlo: proviamo a recuperarlo da Stripe tramite
                // l'email, come fallback una tantum.
                if (!customerId) {
                    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
                    if (customers.data.length > 0) {
                        customerId = customers.data[0].id;
                        user.stripeCustomerId = customerId;
                        await saveUser(user);
                    }
                }

                if (!customerId) {
                    return sendJSON(res, 404, {
                        error: 'no_subscription',
                        message: 'Non troviamo un abbonamento attivo collegato al tuo account.'
                    });
                }

                const portalSession = await stripe.billingPortal.sessions.create({
                    customer: customerId,
                    return_url: SITE_BASE_URL + '/profilo.html'
                });

                return sendJSON(res, 200, { url: portalSession.url });

            } catch (err) {
                console.error('Errore creazione sessione Customer Portal:', err);
                return sendJSON(res, 500, { error: 'Impossibile aprire la gestione abbonamento in questo momento.' });
            }
        })();
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
                    if (session.customer) {
                        user.stripeCustomerId = session.customer;
                    }
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

            // L'utente ha annullato l'abbonamento dal Customer Portal (o è scaduto
            // per pagamento non riuscito): lo togliamo da Pro. Questo evento va
            // aggiunto esplicitamente nell'elenco eventi ascoltati dal webhook su
            // dashboard.stripe.com, altrimenti Stripe non lo invia.
            if (event.type === 'customer.subscription.deleted') {
                const subscription = event.data.object;
                const user = await getUserByStripeCustomerId(subscription.customer);
                if (user) {
                    user.isPro = false;
                    await saveUser(user);
                    console.log('Abbonamento annullato, utente non più Pro:', user.email);
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
                    const anonCheck = await checkAndConsumeRateLimitPersistent('ask-anon', ip, MAX_DAILY_MESSAGES, RATE_LIMIT_WINDOW_MS, askAnonymousRateLimit);
                    if (!anonCheck.allowed) {
                        return sendJSON(res, 429, {
                            error: 'limit_reached',
                            message: 'Hai raggiunto il limite di ' + MAX_DAILY_MESSAGES + ' messaggi gratuiti. Passa a un piano Pro per continuare senza limiti, oppure riprova tra qualche ora.',
                            unlockAt: new Date(anonCheck.windowStart + RATE_LIMIT_WINDOW_MS).toISOString(),
                            upgradeUrl: SITE_BASE_URL + '/piani.html'
                        });
                    }
                }

                if (!ANTHROPIC_API_KEY && !GEMINI_API_KEY) {
                    return sendJSON(res, 500, { error: 'Nessuna chiave API configurata sul server.' });
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

                let aiResult;
                try {
                    aiResult = await getAiAnswer(anthropicMessages);
                } catch (aiErr) {
                    console.error('Errore IA (ask):', aiErr.message);
                    return sendJSON(res, 502, { error: 'Errore nel contattare il servizio IA. Riprova più tardi.' });
                }

                return sendJSON(res, 200, { answer: aiResult.answer || 'Nessuna risposta ricevuta.', aiProvider: aiResult.provider });

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

                if (!ANTHROPIC_API_KEY && !GEMINI_API_KEY) {
                    return sendJSON(res, 500, { error: 'Nessuna chiave API configurata sul server.' });
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

                let aiResult;
                try {
                    aiResult = await getAiAnswer(anthropicMessages);
                } catch (aiErr) {
                    console.error('Errore IA (overview):', aiErr.message);
                    return sendJSON(res, 502, { error: 'Errore nel contattare il servizio IA. Riprova più tardi.' });
                }

                return sendJSON(res, 200, { answer: aiResult.answer || 'Nessuna risposta ricevuta.', aiProvider: aiResult.provider });

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
                if (!ANTHROPIC_API_KEY && !GEMINI_API_KEY) {
                    return sendJSON(res, 500, { error: 'Nessuna chiave API configurata sul server.' });
                }

                const anthropicMessages = [{
                    role: 'user',
                    content: [
                        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
                        { type: 'text', text: question.trim() }
                    ]
                }];

                let aiResult;
                try {
                    aiResult = await getAiAnswer(anthropicMessages);
                } catch (aiErr) {
                    console.error('Errore IA (vision):', aiErr.message);
                    return sendJSON(res, 502, { error: 'Errore nel contattare il servizio IA. Riprova più tardi.' });
                }

                return sendJSON(res, 200, { answer: aiResult.answer || 'Nessuna risposta ricevuta.', aiProvider: aiResult.provider });

            } catch (err) {
                console.error('Errore interno (vision):', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Endpoint risultati di ricerca reali (proxy verso Brave Search API)
    // Endpoint di TEST per la demo di Serper.dev: isolato dal resto del sito,
    // usato solo da test-serper.html per una prova reale. Non tocca in alcun
    // modo /api/search (quello vero, con Brave) usato da results.html.
    if (req.method === 'GET' && req.url.indexOf('/api/search-serper-test') === 0) {
        (async function () {
            try {
                const fullUrl = new URL(req.url, 'http://localhost');
                const q = (fullUrl.searchParams.get('q') || '').trim();

                if (!q) {
                    return sendJSON(res, 200, { results: [] });
                }
                if (!SERPER_API_KEY) {
                    return sendJSON(res, 500, { error: 'Chiave Serper non configurata sul server (SERPER_API_KEY).' });
                }

                const serperResponse = await fetch('https://google.serper.dev/search', {
                    method: 'POST',
                    headers: {
                        'X-API-KEY': SERPER_API_KEY,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ q: q, gl: 'it', hl: 'it' })
                });

                if (!serperResponse.ok) {
                    const errText = await serperResponse.text();
                    console.error('Errore Serper API:', serperResponse.status, errText);
                    return sendJSON(res, 502, { error: 'Servizio di ricerca (Serper) non raggiungibile al momento.' });
                }

                const data = await serperResponse.json();
                const organic = Array.isArray(data.organic) ? data.organic : [];
                const results = organic.map(function (r) {
                    return {
                        title: r.title || '',
                        url: r.link || '',
                        description: r.snippet || ''
                    };
                });

                return sendJSON(res, 200, { results: results });
            } catch (err) {
                console.error('Errore search-serper-test:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        })();
        return;
    }

    // Scheda "Libri": facciamo da tramite verso Google Books, così la chiave
    // API resta solo sul server e non è mai visibile a chi guarda il
    // codice sorgente della pagina.
    if (req.method === 'GET' && req.url.indexOf('/api/books') === 0) {
        (async function () {
            try {
                const fullUrl = new URL(req.url, 'http://localhost');
                const q = (fullUrl.searchParams.get('q') || '').trim();

                if (!q) {
                    return sendJSON(res, 200, { items: [] });
                }

                if (!GOOGLE_BOOKS_API_KEY) {
                    return sendJSON(res, 500, { error: 'Chiave Google Books non configurata sul server (GOOGLE_BOOKS_API_KEY).' });
                }

                const booksUrl = 'https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(q) + '&maxResults=20&key=' + GOOGLE_BOOKS_API_KEY;
                const booksResponse = await fetch(booksUrl);
                const data = await booksResponse.json();

                if (!booksResponse.ok || data.error) {
                    console.error('Errore Google Books API:', booksResponse.status, data.error || data);
                    return sendJSON(res, 502, { error: 'Servizio libri non raggiungibile al momento.' });
                }

                return sendJSON(res, 200, { items: data.items || [] });
            } catch (err) {
                console.error('Errore endpoint /api/books:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        })();
        return;
    }

    // ===== BLOG =====

    // Stima il tempo di lettura: circa 200 parole al minuto, arrotondato
    // per eccesso e mai sotto 1 minuto.
    function estimateReadTime(content) {
        const wordCount = String(content).trim().split(/\s+/).filter(Boolean).length;
        return Math.max(1, Math.ceil(wordCount / 200));
    }

    // Genera uno "slug" leggibile e unico a partire dal titolo (es. "La mia
    // storia!" -> "la-mia-storia"). Se lo slug esiste già, aggiunge un
    // numero in fondo (la-mia-storia-2) per non avere collisioni.
    function slugify(title) {
        return String(title)
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // accenti -> lettere semplici
            .replace(/[^a-z0-9\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .slice(0, 80) || 'articolo';
    }
    async function generateUniqueSlug(title, excludeId) {
        const base = slugify(title);
        let slug = base;
        let counter = 2;
        while (true) {
            const existing = await pool.query(
                'SELECT id FROM blog_posts WHERE slug = $1' + (excludeId ? ' AND id != $2' : ''),
                excludeId ? [slug, excludeId] : [slug]
            );
            if (existing.rows.length === 0) return slug;
            slug = base + '-' + counter;
            counter++;
        }
    }

    // Elenco pubblico degli articoli PUBBLICATI (per la pagina blog.html).
    if (req.method === 'GET' && req.url.indexOf('/api/blog/posts') === 0 && req.url.indexOf('/api/blog/admin') !== 0) {
        (async function () {
            try {
                if (!dbEnabled) return sendJSON(res, 200, { posts: [] });
                const result = await pool.query(
                    'SELECT slug, title, excerpt, cover_image, category, author, tags, read_time_minutes, card_size, published_at FROM blog_posts ' +
                    'WHERE published = true ORDER BY sort_order ASC, published_at DESC'
                );
                return sendJSON(res, 200, { posts: result.rows });
            } catch (err) {
                console.error('Errore /api/blog/posts:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        })();
        return;
    }

    // Singolo articolo pubblicato, per slug (per blog-post.html).
    if (req.method === 'GET' && req.url.indexOf('/api/blog/post/') === 0) {
        (async function () {
            try {
                const slug = decodeURIComponent(req.url.split('/api/blog/post/')[1].split('?')[0]);
                if (!dbEnabled || !slug) return sendJSON(res, 404, { error: 'Articolo non trovato.' });
                const result = await pool.query(
                    'SELECT slug, title, content, cover_image, category, author, tags, read_time_minutes, card_size, published_at FROM blog_posts ' +
                    'WHERE slug = $1 AND published = true',
                    [slug]
                );
                if (result.rows.length === 0) return sendJSON(res, 404, { error: 'Articolo non trovato.' });
                return sendJSON(res, 200, { post: result.rows[0] });
            } catch (err) {
                console.error('Errore /api/blog/post/:slug:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        })();
        return;
    }

    // Admin: elenco DI TUTTI gli articoli (bozze incluse), protetto da ADMIN_SECRET.
    if (req.method === 'GET' && req.url.indexOf('/api/blog/admin/posts') === 0) {
        (async function () {
            try {
                if (!ADMIN_SECRET) return sendJSON(res, 500, { error: 'ADMIN_SECRET non configurata sul server.' });
                const fullUrl = new URL(req.url, 'http://localhost');
                if (fullUrl.searchParams.get('secret') !== ADMIN_SECRET) {
                    return sendJSON(res, 401, { error: 'Chiave non valida.' });
                }
                if (!dbEnabled) return sendJSON(res, 200, { posts: [] });
                const result = await pool.query(
                    'SELECT id, slug, title, excerpt, category, card_size, sort_order, published, created_at, updated_at, published_at ' +
                    'FROM blog_posts ORDER BY sort_order ASC, created_at DESC'
                );
                return sendJSON(res, 200, { posts: result.rows });
            } catch (err) {
                console.error('Errore /api/blog/admin/posts:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        })();
        return;
    }

    // Admin: dettaglio completo di un articolo (per caricarlo nel form di modifica).
    if (req.method === 'GET' && req.url.indexOf('/api/blog/admin/post/') === 0) {
        (async function () {
            try {
                if (!ADMIN_SECRET) return sendJSON(res, 500, { error: 'ADMIN_SECRET non configurata sul server.' });
                const fullUrl = new URL(req.url, 'http://localhost');
                if (fullUrl.searchParams.get('secret') !== ADMIN_SECRET) {
                    return sendJSON(res, 401, { error: 'Chiave non valida.' });
                }
                const id = req.url.split('/api/blog/admin/post/')[1].split('?')[0];
                const result = await pool.query('SELECT * FROM blog_posts WHERE id = $1', [id]);
                if (result.rows.length === 0) return sendJSON(res, 404, { error: 'Articolo non trovato.' });
                return sendJSON(res, 200, { post: result.rows[0] });
            } catch (err) {
                console.error('Errore /api/blog/admin/post/:id:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        })();
        return;
    }

    // Admin: crea un nuovo articolo (bozza o pubblicato direttamente).
    if (req.method === 'POST' && req.url === '/api/blog/admin/create') {
        let createBody = '';
        let createTooLarge = false;
        req.on('data', function (chunk) {
            createBody += chunk;
            if (createBody.length > MAX_IMAGE_BASE64_LENGTH) {
                createTooLarge = true;
                req.destroy();
            }
        });
        req.on('end', async function () {
            if (createTooLarge) {
                return sendJSON(res, 413, { error: 'Immagine troppo grande (massimo circa 4,5 MB). Prova a caricarne una più leggera.' });
            }
            try {
                if (!ADMIN_SECRET) return sendJSON(res, 500, { error: 'ADMIN_SECRET non configurata sul server.' });
                let payload;
                try { payload = JSON.parse(createBody || '{}'); }
                catch (e) { return sendJSON(res, 400, { error: 'Corpo della richiesta non valido.' }); }
                if (payload.secret !== ADMIN_SECRET) return sendJSON(res, 401, { error: 'Chiave non valida.' });

                const title = (payload.title || '').trim();
                const content = (payload.content || '').trim();
                if (!title || !content) return sendJSON(res, 400, { error: 'Titolo e contenuto sono obbligatori.' });

                const excerpt = (payload.excerpt || '').trim() || content.slice(0, 160).trim() + '…';
                const coverImage = (payload.coverImage || '').trim() || null;
                const category = (payload.category || '').trim() || null;
                const author = (payload.author || '').trim() || 'Team iAlgae';
                const cardSize = ['small', 'medium', 'large'].indexOf(payload.cardSize) !== -1 ? payload.cardSize : 'medium';
                const tags = Array.isArray(payload.tags)
                    ? payload.tags.map(function (t) { return String(t).trim(); }).filter(Boolean)
                    : String(payload.tags || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
                const readTime = estimateReadTime(content);
                const published = !!payload.published;
                const slug = await generateUniqueSlug(title);

                // I nuovi articoli vanno sempre in cima all'elenco per default
                // (l'ordine si può poi cambiare trascinando nel pannello admin).
                const minOrderResult = await pool.query('SELECT COALESCE(MIN(sort_order), 0) - 1 AS next_order FROM blog_posts');
                const sortOrder = minOrderResult.rows[0].next_order;

                const result = await pool.query(
                    'INSERT INTO blog_posts (slug, title, excerpt, content, cover_image, category, author, tags, read_time_minutes, card_size, sort_order, published, published_at) ' +
                    'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ' + (published ? 'now()' : 'NULL') + ') RETURNING id, slug',
                    [slug, title, excerpt, content, coverImage, category, author, tags, readTime, cardSize, sortOrder, published]
                );
                return sendJSON(res, 200, { id: result.rows[0].id, slug: result.rows[0].slug });
            } catch (err) {
                console.error('Errore /api/blog/admin/create:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Admin: aggiorna un articolo esistente (modifica, pubblica/spubblica).
    if (req.method === 'POST' && req.url === '/api/blog/admin/update') {
        let updateBody = '';
        let updateTooLarge = false;
        req.on('data', function (chunk) {
            updateBody += chunk;
            if (updateBody.length > MAX_IMAGE_BASE64_LENGTH) {
                updateTooLarge = true;
                req.destroy();
            }
        });
        req.on('end', async function () {
            if (updateTooLarge) {
                return sendJSON(res, 413, { error: 'Immagine troppo grande (massimo circa 4,5 MB). Prova a caricarne una più leggera.' });
            }
            try {
                if (!ADMIN_SECRET) return sendJSON(res, 500, { error: 'ADMIN_SECRET non configurata sul server.' });
                let payload;
                try { payload = JSON.parse(updateBody || '{}'); }
                catch (e) { return sendJSON(res, 400, { error: 'Corpo della richiesta non valido.' }); }
                if (payload.secret !== ADMIN_SECRET) return sendJSON(res, 401, { error: 'Chiave non valida.' });

                const id = payload.id;
                if (!id) return sendJSON(res, 400, { error: 'ID articolo mancante.' });

                const existing = await pool.query('SELECT * FROM blog_posts WHERE id = $1', [id]);
                if (existing.rows.length === 0) return sendJSON(res, 404, { error: 'Articolo non trovato.' });
                const current = existing.rows[0];

                const title = (payload.title || current.title).trim();
                const content = (payload.content || current.content).trim();
                const excerpt = (payload.excerpt || '').trim() || content.slice(0, 160).trim() + '…';
                const coverImage = payload.coverImage !== undefined ? (payload.coverImage || null) : current.cover_image;
                const category = payload.category !== undefined ? ((payload.category || '').trim() || null) : current.category;
                const author = payload.author !== undefined ? ((payload.author || '').trim() || 'Team iAlgae') : current.author;
                const cardSize = payload.cardSize !== undefined
                    ? (['small', 'medium', 'large'].indexOf(payload.cardSize) !== -1 ? payload.cardSize : 'medium')
                    : current.card_size;
                const tags = payload.tags !== undefined
                    ? (Array.isArray(payload.tags)
                        ? payload.tags.map(function (t) { return String(t).trim(); }).filter(Boolean)
                        : String(payload.tags || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean))
                    : current.tags;
                const readTime = estimateReadTime(content);
                const published = payload.published !== undefined ? !!payload.published : current.published;
                const slug = title !== current.title ? await generateUniqueSlug(title, id) : current.slug;
                const wasPublished = current.published;

                await pool.query(
                    'UPDATE blog_posts SET slug = $1, title = $2, excerpt = $3, content = $4, cover_image = $5, ' +
                    'category = $6, author = $7, tags = $8, read_time_minutes = $9, card_size = $10, published = $11, updated_at = now()' +
                    (published && !wasPublished ? ', published_at = now()' : '') +
                    ' WHERE id = $12',
                    [slug, title, excerpt, content, coverImage, category, author, tags, readTime, cardSize, published, id]
                );
                return sendJSON(res, 200, { message: 'Articolo aggiornato.', slug: slug });
            } catch (err) {
                console.error('Errore /api/blog/admin/update:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Admin: salva il nuovo ordine degli articoli dopo il trascinamento nel
    // pannello. Riceve un elenco di {id, sortOrder} e li aggiorna tutti insieme.
    if (req.method === 'POST' && req.url === '/api/blog/admin/reorder') {
        let reorderBody = '';
        req.on('data', function (chunk) { reorderBody += chunk; });
        req.on('end', async function () {
            try {
                if (!ADMIN_SECRET) return sendJSON(res, 500, { error: 'ADMIN_SECRET non configurata sul server.' });
                let payload;
                try { payload = JSON.parse(reorderBody || '{}'); }
                catch (e) { return sendJSON(res, 400, { error: 'Corpo della richiesta non valido.' }); }
                if (payload.secret !== ADMIN_SECRET) return sendJSON(res, 401, { error: 'Chiave non valida.' });

                const order = Array.isArray(payload.order) ? payload.order : [];
                if (order.length === 0) return sendJSON(res, 400, { error: 'Elenco ordine mancante.' });

                for (const item of order) {
                    if (!item.id || typeof item.sortOrder !== 'number') continue;
                    await pool.query('UPDATE blog_posts SET sort_order = $1 WHERE id = $2', [item.sortOrder, item.id]);
                }
                return sendJSON(res, 200, { message: 'Ordine aggiornato.' });
            } catch (err) {
                console.error('Errore /api/blog/admin/reorder:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // Admin: elimina un articolo definitivamente.
    if (req.method === 'POST' && req.url === '/api/blog/admin/delete') {
        let deleteBody = '';
        req.on('data', function (chunk) { deleteBody += chunk; });
        req.on('end', async function () {
            try {
                if (!ADMIN_SECRET) return sendJSON(res, 500, { error: 'ADMIN_SECRET non configurata sul server.' });
                let payload;
                try { payload = JSON.parse(deleteBody || '{}'); }
                catch (e) { return sendJSON(res, 400, { error: 'Corpo della richiesta non valido.' }); }
                if (payload.secret !== ADMIN_SECRET) return sendJSON(res, 401, { error: 'Chiave non valida.' });
                if (!payload.id) return sendJSON(res, 400, { error: 'ID articolo mancante.' });

                await pool.query('DELETE FROM blog_posts WHERE id = $1', [payload.id]);
                return sendJSON(res, 200, { message: 'Articolo eliminato.' });
            } catch (err) {
                console.error('Errore /api/blog/admin/delete:', err);
                return sendJSON(res, 500, { error: 'Errore interno del server.' });
            }
        });
        return;
    }

    // ===== FINE BLOG =====

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

                // Il box "rich result" (calcolo o conversione) ha senso solo sulla
                // prima pagina della ricerca web: per immagini/news/video, o per
                // pagine successive, saltiamo direttamente alla ricerca normale.
                const richResult = (type === 'web' && page === 1) ? computeRichResult(q) : null;

                // Prima di chiamare Brave/Serper, controlliamo se qualcuno ha già
                // cercato la stessa cosa di recente: se sì, rispondiamo subito da
                // cache senza consumare quota delle API esterne.
                const cacheKey = buildSearchCacheKey(q, type, page);
                const cached = await getCachedSearch(cacheKey);
                if (cached) {
                    return sendJSON(res, 200, {
                        results: cached.results,
                        page: page,
                        totalPages: (type === 'images') ? 1 : 10,
                        type: type,
                        query: q,
                        alteredQuery: null,
                        source: cached.source,
                        fromCache: true,
                        richResult: richResult
                    });
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

                // A differenza di prima, un errore di Brave (es. quota mensile
                // esaurita, errore 429/402) NON interrompe subito la richiesta:
                // per le ricerche web proviamo comunque la riserva Serper qui
                // sotto, esattamente come già facevamo per "zero risultati".
                let braveFailed = false;
                let data = null;
                if (!braveResponse.ok) {
                    const errText = await braveResponse.text();
                    console.error('Errore Brave Search API (' + type + '):', braveResponse.status, errText);
                    braveFailed = true;
                } else {
                    data = await braveResponse.json();
                }

                let results = [];

                if (!braveFailed) {
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
                }

                // Riserva Serper: scatta in DUE casi ora, non solo uno —
                // 1) Brave ha risposto ma con zero risultati (query rare/locali)
                // 2) Brave è fallito del tutto (quota mensile esaurita, errore
                //    del servizio, ecc.) — questo è il caso NUOVO che prima
                //    interrompeva subito la richiesta senza tentare la riserva.
                // Solo sulla prima pagina della ricerca web, per non moltiplicare
                // le chiamate a Serper (anche la sua quota gratuita è limitata).
                let usedFallback = false;
                if (type === 'web' && (braveFailed || results.length === 0) && page === 1 && SERPER_API_KEY) {
                    try {
                        const serperResponse = await fetch('https://google.serper.dev/search', {
                            method: 'POST',
                            headers: {
                                'X-API-KEY': SERPER_API_KEY,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({ q: q, gl: 'it', hl: 'it' })
                        });
                        if (serperResponse.ok) {
                            const serperData = await serperResponse.json();
                            const organic = Array.isArray(serperData.organic) ? serperData.organic : [];
                            if (organic.length > 0) {
                                results = organic.map(function (r) {
                                    return {
                                        title: r.title || '',
                                        url: r.link || '',
                                        description: r.snippet || ''
                                    };
                                });
                                usedFallback = true;
                            }
                        } else {
                            console.error('Riserva Serper non riuscita:', serperResponse.status);
                        }
                    } catch (fallbackErr) {
                        // Se anche la riserva fallisce, va bene: rispondiamo comunque
                        // con l'elenco vuoto di Brave, invece di far fallire tutto.
                        console.error('Errore nella riserva Serper:', fallbackErr);
                    }
                }

                // Se Brave è fallito del tutto E la riserva Serper non ha
                // funzionato (chiave mancante, anche lei in errore, o non è
                // una ricerca web/prima pagina), a questo punto sì restituiamo
                // l'errore: non abbiamo nessun risultato reale da mostrare.
                if (braveFailed && !usedFallback) {
                    return sendJSON(res, 502, { error: 'Servizio di ricerca non raggiungibile al momento.' });
                }

                // Salviamo il risultato in cache (solo se abbiamo trovato qualcosa:
                // non ha senso cachare una lista vuota, potrebbe essere un problema
                // temporaneo del provider più che una vera assenza di risultati).
                if (results.length > 0) {
                    await saveCachedSearch(cacheKey, results, usedFallback ? 'serper' : 'brave');
                }

                return sendJSON(res, 200, {
                    results: results,
                    page: page,
                    totalPages: (type === 'images') ? 1 : 10, // mostriamo fino a 10 pagine per gli altri tipi
                    type: type,
                    query: q,
                    // "Forse cercavi...": Brave a volte corregge da sola un probabile errore
                    // di battitura. Se lo fa, ce lo dice qui — non lo inventiamo noi. Non
                    // disponibile quando la riserva Serper ha risposto al posto di Brave.
                    alteredQuery: (data && data.query && data.query.altered) ? data.query.altered : null,
                    source: usedFallback ? 'serper' : 'brave',
                    richResult: richResult
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

// Pulizia periodica delle voci di cache scadute, così la tabella non cresce
// all'infinito nel tempo. Non è indispensabile per il funzionamento (le voci
// scadute vengono comunque ignorate dalle query grazie a "expires_at > now()"),
// ma tiene il database più leggero. Gira ogni ora.
if (dbEnabled) {
    setInterval(function () {
        pool.query('DELETE FROM search_cache WHERE expires_at <= now()')
            .catch(function (err) {
                console.error('Errore pulizia search_cache:', err);
            });
    }, 60 * 60 * 1000);

    // Le voci di rate_limits più vecchie della finestra usata (1 ora per il
    // reset password) non servono più: le finestre scadute vengono comunque
    // ignorate dalla logica sopra, ma questa pulizia tiene la tabella snella.
    // Usiamo un margine di sicurezza di 24 ore invece dell'ora esatta, così
    // funziona anche se in futuro si aggiungono limiti con finestre più lunghe.
    setInterval(function () {
        pool.query("DELETE FROM rate_limits WHERE window_start <= now() - interval '24 hours'")
            .catch(function (err) {
                console.error('Errore pulizia rate_limits:', err);
            });
    }, 60 * 60 * 1000);
}
