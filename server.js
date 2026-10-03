require('dotenv').config();
require('./config/timezone');
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const bcrypt = require('bcrypt');
const dayjs = require('dayjs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const multer = require('multer');
const db = require('./config/database');
const { ensureSchema } = require('./config/ensureSchema');
const { attachChatbot } = require('./chatbot-handler');
const { entregarMensagem } = require('./modules/whatsapp-entrega');
const { BaileysClient } = require('./modules/baileys-client');
const instanceManager = require('./modules/instance-manager');
const mediaManager = require('./modules/media-manager');
const { normalizarFluxoSesau } = require('./modules/flow-normalizer');

const uploadChatMedia = multer({
    storage: multer.diskStorage({
        destination: path.join(__dirname, 'public', 'uploads', 'chat-media'),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            cb(null, `chamado-${req.params.id}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        }
    }),
    limits: { fileSize: 20 * 1024 * 1024 }
});

const app = express();
const PORT = process.env.PORT || 3000;
const execFileAsync = promisify(execFile);
const CHATBOT_FILE_PATH = path.join(__dirname, 'chatbot.js');
const transferenciasEmAndamento = new Map();

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'change-this-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Recarrega unidade/local do banco a cada request (evita sessão desatualizada após editar usuário)
// Administrador: sempre vê todas as unidades/instâncias (unidadeIds = null).
// Demais perfis: respeitam admin_unidades / admin_locais.
// Filtro opcional por unidade nas telas usa ?unidade_id= (seletor), sem restringir o escopo base do admin.
async function refreshUserScope(req) {
    if (!req.session?.userId) return;

    if (req.session.nivelAcesso === 'administrador') {
        req.session.unidadeIds = null; // null = todas
        req.session.localIds = null;
        return;
    }

    try {
        const [unids] = await db.query(
            'SELECT unidade_id FROM admin_unidades WHERE admin_id = ?',
            [req.session.userId]
        );
        req.session.unidadeIds = unids.map(u => u.unidade_id);
    } catch (e) {
        console.error('Erro ao carregar unidades do usuário:', e.message);
        req.session.unidadeIds = [];
    }

    try {
        const [locs] = await db.query(
            'SELECT local_id FROM admin_locais WHERE admin_id = ?',
            [req.session.userId]
        );
        // Sem locais vinculados = vê todos os chamados da unidade
        req.session.localIds = locs.length > 0 ? locs.map(l => l.local_id) : null;
    } catch (e) {
        req.session.localIds = null;
    }
}

// Filtro de chamados por unidade/local do usuário logado
// options.unidadeId: filtro extra do seletor (já validado contra o escopo)
function buildChamadosListWhere(req, options = {}) {
    let sql = 'WHERE 1=1';
    const params = [];

    if (options.statuses?.length) {
        sql += ` AND status IN (${options.statuses.map(() => '?').join(',')})`;
        params.push(...options.statuses);
    }

    const ids = req?.session?.unidadeIds;
    const unidadeIdFiltro = options.unidadeId != null ? Number(options.unidadeId) : null;

    if (unidadeIdFiltro && !Number.isNaN(unidadeIdFiltro)) {
        // Seletor explícito: restringe a uma unidade (já validada)
        sql += ' AND unidade_id = ?';
        params.push(unidadeIdFiltro);
    } else if (!Array.isArray(ids)) {
        // null = admin sem vínculos: sem filtro
    } else if (ids.length === 0) {
        sql += ' AND unidade_id IS NULL';
    } else {
        const placeholders = ids.map(() => '?').join(',');
        sql += ` AND (unidade_id IS NULL OR unidade_id IN (${placeholders}))`;
        params.push(...ids);
    }

    const localIds = req?.session?.localIds;
    if (Array.isArray(localIds) && localIds.length > 0) {
        const localPh = localIds.map(() => '?').join(',');
        sql += ` AND (local_id IS NULL OR local_id IN (${localPh}))`;
        params.push(...localIds);
    }

    return { sql, params };
}

// Valida unidade_id da query contra o escopo do usuário. Retorna Number ou null.
function resolveUnidadeFiltro(req) {
    const raw = req.query?.unidade_id;
    if (raw === undefined || raw === null || raw === '' || raw === 'todas' || raw === 'all') {
        return null;
    }
    const id = Number(raw);
    if (!id || Number.isNaN(id)) return null;

    const ids = req.session?.unidadeIds;
    if (!Array.isArray(ids)) {
        // Admin full: qualquer unidade ativa é válida
        return id;
    }
    if (ids.map(Number).includes(id)) return id;
    return null; // fora do escopo → ignora
}

function limparTransferenciasExpiradas() {
    const agora = Date.now();
    for (const [chave, expiraEm] of transferenciasEmAndamento.entries()) {
        if (expiraEm <= agora) transferenciasEmAndamento.delete(chave);
    }
}

function criarChaveTransferencia(chamadoId, usuarioId, novoAtendenteId, observacao) {
    return [
        chamadoId,
        usuarioId || '',
        novoAtendenteId,
        String(observacao || '').trim().replace(/\s+/g, ' ').toUpperCase()
    ].join('|');
}

async function listarUnidadesDoEscopo(req) {
    const ids = req.session?.unidadeIds;
    if (!Array.isArray(ids)) {
        const [rows] = await db.query(
            'SELECT id, nome, codigo FROM unidades WHERE ativo = TRUE ORDER BY nome'
        );
        return { todas: true, unidades: rows };
    }
    if (ids.length === 0) {
        return { todas: false, unidades: [] };
    }
    const ph = ids.map(() => '?').join(',');
    const [rows] = await db.query(
        `SELECT id, nome, codigo FROM unidades WHERE ativo = TRUE AND id IN (${ph}) ORDER BY nome`,
        ids
    );
    return { todas: false, unidades: rows };
}

app.use(async (req, res, next) => {
    res.locals.pendingChamadosCount = 0;

    if (!req.session?.userId) {
        return next();
    }

    // Disponibilizar nivelAcesso em todas as views
    res.locals.nivelAcesso = req.session.nivelAcesso || 'administrador';

    await refreshUserScope(req);

    try {
        const { sql, params } = buildChamadosListWhere(req, {
            statuses: ['pendente', 'aberto']
        });
        const [rows] = await db.query(
            `SELECT COUNT(*) AS total FROM chamados ${sql}`,
            params
        );
        res.locals.pendingChamadosCount = Number(rows[0]?.total || 0);
    } catch (error) {
        console.error('Erro ao carregar contagem pendente para o menu:', error);
    }

    next();
});

// WhatsApp client
let whatsappClient = null;
let whatsappChatbotController = null;
let currentQR = null;
let whatsappState = 'disconnected';
let whatsappLastError = null;
let hgpReconnectTimer = null;
let hgpReconnectAttempts = 0;
let hgpConnectingSince = 0;
let hgpAttemptsResetAt = Date.now();
let hgpForcando = false;
let hgpClientReady = false;
let hgpUnreadProbeRunning = false;
let hgpUnreadProbeFailures = 0;
const hgpRecentMessageIds = new Map();
const HGP_RECONNECT_MAX = 40;
const HGP_ATTEMPTS_RESET_MS = 10 * 60 * 1000;
const HGP_MESSAGE_DEDUP_MS = 10 * 60 * 1000;
const HGP_UNREAD_MAX_AGE_MS = 5 * 60 * 1000;
const HGP_WHATSAPP_PROVIDER = String(process.env.HGP_WHATSAPP_PROVIDER || 'baileys').toLowerCase();
const HGP_USES_BAILEYS = HGP_WHATSAPP_PROVIDER !== 'wwebjs';

const candidateBrowserPaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
].filter(Boolean);

const resolveBrowserExecutablePath = () => {
    for (const browserPath of candidateBrowserPaths) {
        if (fsSync.existsSync(browserPath)) {
            return browserPath;
        }
    }

    return undefined;
};

const buildPuppeteerConfig = () => {
    const executablePath = resolveBrowserExecutablePath();
    const config = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--no-first-run',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-software-rasterizer',
            '--mute-audio',
            '--renderer-process-limit=1',
            '--disable-component-extensions-with-background-pages',
            '--js-flags=--max-old-space-size=192'
        ],
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false
    };

    if (executablePath) {
        config.executablePath = executablePath;
    }

    return config;
};

const HGP_AUTH_DIR = path.join(__dirname, '.wwebjs_auth');
const HGP_BAILEYS_AUTH_DIR = path.join(__dirname, '.baileys_auth');
const hgpWwebjsSessionPath = () => path.join(HGP_AUTH_DIR, 'session-admin-session');
const hgpSessionPath = () => HGP_USES_BAILEYS
    ? path.join(HGP_BAILEYS_AUTH_DIR, 'admin-session')
    : hgpWwebjsSessionPath();

const hgpTemSessaoSalva = () => {
    try {
        if (HGP_USES_BAILEYS) {
            // A pasta é criada já no primeiro QR; só conta como sessão salva
            // depois do pareamento (creds.me). Senão o watchdog fica reabrindo
            // conexão e gerando QR sem ninguém para ler.
            const credsPath = path.join(hgpSessionPath(), 'creds.json');
            if (!fsSync.existsSync(credsPath)) return false;
            const creds = JSON.parse(fsSync.readFileSync(credsPath, 'utf8'));
            return !!creds?.me?.id;
        }
        return fsSync.existsSync(hgpSessionPath());
    } catch (e) {
        return false;
    }
};

const cancelarReconexaoHgp = () => {
    if (hgpReconnectTimer) {
        clearTimeout(hgpReconnectTimer);
        hgpReconnectTimer = null;
    }
};

const motivoHgpSemReconexao = (reason) => {
    const r = String(reason || '');
    return /LOGOUT|UNPAIRED|logged out|ban|banned/i.test(r);
};

const resetarContadorReconexaoSeExpirou = () => {
    if (Date.now() - hgpAttemptsResetAt > HGP_ATTEMPTS_RESET_MS) {
        if (hgpReconnectAttempts > 0) {
            console.log('[HGP] Contador de reconexões resetado após 10 min');
        }
        hgpReconnectAttempts = 0;
        hgpAttemptsResetAt = Date.now();
    }
};

const agendarReconexaoHgp = (reason = '') => {
    if (motivoHgpSemReconexao(reason)) {
        console.log(`[HGP] Sem auto-reconexão (${reason}). É preciso ler o QR de novo em /instancias.`);
        cancelarReconexaoHgp();
        hgpReconnectAttempts = 0;
        return;
    }
    if (!hgpTemSessaoSalva()) {
        console.log('[HGP] Sem pasta de sessão salva — aguardando pareamento via QR.');
        return;
    }
    if (whatsappState === 'connected' || whatsappState === 'connecting') return;

    resetarContadorReconexaoSeExpirou();

    if (hgpReconnectAttempts >= HGP_RECONNECT_MAX) {
        console.error(`[HGP] Limite de ${HGP_RECONNECT_MAX} reconexões na janela atual. Nova tentativa em 10 min.`);
        cancelarReconexaoHgp();
        hgpReconnectTimer = setTimeout(() => {
            hgpReconnectTimer = null;
            hgpReconnectAttempts = 0;
            hgpAttemptsResetAt = Date.now();
            agendarReconexaoHgp('retry-apos-limite');
        }, HGP_ATTEMPTS_RESET_MS);
        return;
    }

    if (hgpReconnectTimer) return;

    hgpReconnectAttempts += 1;
    const delay = Math.min(60000, 3000 * hgpReconnectAttempts);
    console.log(`[HGP] Reconectando em ${Math.round(delay / 1000)}s (tentativa ${hgpReconnectAttempts}/${HGP_RECONNECT_MAX}) — motivo: ${reason || 'desconhecido'}`);
    hgpReconnectTimer = setTimeout(() => {
        hgpReconnectTimer = null;
        if (whatsappState === 'connected' || whatsappState === 'connecting') return;
        iniciarWhatsAppLegacy().catch((err) => {
            console.error('[HGP] Falha na auto-reconexão:', err.message);
            agendarReconexaoHgp(err.message);
        });
    }, delay);
};

const forcarReconexaoHgp = async (reason = '') => {
    if (hgpForcando) return;
    if (motivoHgpSemReconexao(reason)) {
        agendarReconexaoHgp(reason);
        return;
    }
    if (whatsappState === 'connecting' && currentQR) {
        return;
    }
    hgpForcando = true;
    console.log(`[HGP] Forçando reconexão (${reason})`);
    cancelarReconexaoHgp();
    try {
        if (whatsappClient) {
            try { await whatsappClient.destroy(); } catch (e) {}
        }
        await resetWhatsAppRuntime();
        agendarReconexaoHgp(reason);
    } finally {
        setTimeout(() => { hgpForcando = false; }, 4000);
    }
};

const anexarWatchdogChrome = (client) => {
    try {
        if (client.pupPage) {
            client.pupPage.on('close', () => {
                console.error('[HGP] Página do Chrome fechou');
                if (whatsappState === 'connected' || whatsappState === 'connecting') {
                    forcarReconexaoHgp('puppeteer_page_closed').catch(() => {});
                }
            });
        }
        if (client.pupBrowser) {
            client.pupBrowser.on('disconnected', () => {
                console.error('[HGP] Chrome desconectou');
                if (whatsappState === 'connected' || whatsappState === 'connecting') {
                    forcarReconexaoHgp('puppeteer_browser_disconnected').catch(() => {});
                }
            });
        }
    } catch (e) {
        console.warn('[HGP] Não foi possível anexar watchdog do Chrome:', e.message);
    }
};

const verificarSaudeHgp = async () => {
    try {
        resetarContadorReconexaoSeExpirou();
        if (!hgpTemSessaoSalva()) return;

        if (whatsappState === 'connecting') {
            if (currentQR) return;
            if (hgpConnectingSince && Date.now() - hgpConnectingSince > 120000) {
                await forcarReconexaoHgp('connecting_travado');
            }
            return;
        }

        if (!whatsappClient || whatsappState === 'disconnected' || whatsappState === 'error') {
            if (!hgpReconnectTimer) agendarReconexaoHgp('watchdog-desconectado');
            return;
        }

        if (whatsappState !== 'connected') return;

        if (HGP_USES_BAILEYS) {
            // O BaileysClient já se reconecta sozinho (1,5s a 30s). Só força a
            // recriação se ficar fora por mais de 2 min — recriar à toa derruba
            // conversas em andamento e pode brigar com a reconexão interna.
            if (!whatsappClient?.isConnected) {
                const caiuEm = Number(whatsappClient?._disconnectedAt || 0);
                if (!caiuEm || Date.now() - caiuEm > 120000) {
                    await forcarReconexaoHgp('baileys sem conexão ativa');
                }
            }
            return;
        }

        let state = null;
        try {
            state = await Promise.race([
                whatsappClient.getState(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('getState timeout')), 12000))
            ]);
        } catch (e) {
            await forcarReconexaoHgp(`getState: ${e.message}`);
            return;
        }

        if (state && state !== 'CONNECTED') {
            await forcarReconexaoHgp(`estado=${state}`);
        }
    } catch (e) {
        console.error('[HGP] Watchdog erro:', e.message);
    }
};

const obterIdMensagemHgp = (message) => String(
    message?.id?._serialized ||
    `${message?.from || ''}:${message?.timestamp || ''}:${message?.type || ''}:${message?.body || ''}`
);

const registrarIdMensagemHgp = (message) => {
    const agora = Date.now();
    for (const [id, expiraEm] of hgpRecentMessageIds) {
        if (expiraEm <= agora) hgpRecentMessageIds.delete(id);
    }

    const id = obterIdMensagemHgp(message);
    if (!id || hgpRecentMessageIds.has(id)) return false;
    hgpRecentMessageIds.set(id, agora + HGP_MESSAGE_DEDUP_MS);
    return true;
};

const mensagemHgpJaVista = (message) => hgpRecentMessageIds.has(obterIdMensagemHgp(message));

// O whatsapp-web.js pode continuar reportando CONNECTED mesmo quando a ponte de
// eventos da pagina deixa de emitir "message". Recupera somente mensagens nao
// lidas e recentes; o mesmo ID nunca e encaminhado duas vezes.
const recuperarMensagensNaoLidasHgp = async () => {
    if (
        HGP_USES_BAILEYS ||
        hgpUnreadProbeRunning ||
        whatsappState !== 'connected' ||
        !hgpClientReady ||
        !whatsappClient?.pupPage
    ) return;
    hgpUnreadProbeRunning = true;

    try {
        const chats = await Promise.race([
            whatsappClient.getChats(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('getChats timeout')), 12000))
        ]);
        hgpUnreadProbeFailures = 0;
        const limiteTimestamp = Date.now() - HGP_UNREAD_MAX_AGE_MS;

        for (const chat of chats || []) {
            const unread = Math.min(20, Math.max(0, Number(chat?.unreadCount) || 0));
            if (!unread || chat?.isGroup) continue;

            let messages = [];
            try {
                messages = await chat.fetchMessages({ limit: unread });
            } catch (error) {
                console.warn('[HGP] Falha ao buscar mensagens não lidas:', error.message);
                continue;
            }

            for (const message of messages || []) {
                const timestampMs = Number(message?.timestamp || 0) * 1000;
                if (message?.fromMe || !timestampMs || timestampMs < limiteTimestamp) continue;
                if (mensagemHgpJaVista(message)) continue;

                console.warn(
                    `[HGP] Mensagem recuperada pelo fallback de não lidas: ${message.from} id=${obterIdMensagemHgp(message)}`
                );
                message._hgpRecoverySource = 'unread-fallback';
                whatsappClient.emit('message', message);
            }
        }
    } catch (error) {
        hgpUnreadProbeFailures += 1;
        console.warn('[HGP] Verificação de mensagens não lidas falhou:', error.message);
        if (hgpUnreadProbeFailures >= 3) {
            hgpUnreadProbeFailures = 0;
            await forcarReconexaoHgp(`fallback não lidas: ${error.message}`);
        }
    } finally {
        hgpUnreadProbeRunning = false;
    }
};

const formatWhatsAppError = (error) => {
    const rawMessage = error?.message || String(error || 'Erro desconhecido ao iniciar o WhatsApp');

    if (/executable|chrome|chromium|browser/i.test(rawMessage)) {
        return `Falha ao iniciar o navegador do WhatsApp. Configure CHROME_BIN ou PUPPETEER_EXECUTABLE_PATH no servidor. Detalhe: ${rawMessage}`;
    }

    return rawMessage;
};

const isIgnorableWhatsAppRuntimeError = (error) => {
    const rawMessage = error?.message || String(error || '');

    return /Execution context was destroyed|Cannot find context with specified id|Target closed|Session closed|Most likely the page has been closed/i.test(rawMessage);
};

const logRuntimeError = (label, error) => {
    console.error(`${label}:`, error);
};

const isApiRequest = (req) => req.path.startsWith('/api/') || req.path.startsWith('/whatsapp/');

const syncDisconnectedSession = async () => {
    try {
        await db.query(
            'UPDATE whatsapp_sessions SET is_connected = ?, qr_code = NULL WHERE session_name = ?',
            [false, 'admin-session']
        );
        // Espelhar status na tabela instancias (legacy)
        await db.query(
            `UPDATE instancias SET status = 'disconnected', qr_code = NULL WHERE session_name = 'admin-session'`
        );
    } catch (error) {
        console.error('Erro ao sincronizar sessão desconectada:', error);
    }
};

const syncLegacyInstanciaStatus = async (status, qrCode = null) => {
    try {
        const dados = { status, qr_code: qrCode };
        if (status === 'connected') dados.last_connected = new Date();
        const fields = Object.keys(dados).map(k => `${k} = ?`).join(', ');
        const values = Object.values(dados);
        values.push('admin-session');
        await db.query(`UPDATE instancias SET ${fields} WHERE session_name = ?`, values);
    } catch (e) {
        console.error('Erro syncLegacyInstanciaStatus:', e.message);
    }
};

const confirmarLegacyConectado = async () => {
    whatsappState = 'connected';
    hgpConnectingSince = 0;
    whatsappLastError = null;
    currentQR = null;
    hgpReconnectAttempts = 0;
    hgpAttemptsResetAt = Date.now();
    cancelarReconexaoHgp();

    await db.query(
        'UPDATE whatsapp_sessions SET is_connected = ?, last_connected = NOW(), qr_code = NULL WHERE session_name = ?',
        [true, 'admin-session']
    );
    await syncLegacyInstanciaStatus('connected', null);
};

const resetWhatsAppRuntime = async () => {
    currentQR = null;
    whatsappClient = null;
    whatsappChatbotController = null;
    whatsappState = 'disconnected';
    hgpClientReady = false;
    await syncDisconnectedSession();
    await syncLegacyInstanciaStatus('disconnected', null);
};

async function obterRuntimeLegacyStatus({ probe = false } = {}) {
    let status = whatsappState || 'disconnected';

    if (status === 'connected') {
        return { status: 'connected', qr: null, lastError: whatsappLastError };
    }

    if (probe && whatsappClient && status === 'connecting') {
        if (HGP_USES_BAILEYS) {
            if (whatsappClient.isConnected && hgpClientReady) {
                await confirmarLegacyConectado();
                return { status: 'connected', qr: null, lastError: null };
            }
            return { status: currentQR ? 'qr_ready' : 'connecting', qr: currentQR, lastError: whatsappLastError };
        }

        try {
            const state = await Promise.race([
                whatsappClient.getState(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('getState timeout')), 4000))
            ]);
            if (state === 'CONNECTED') {
                // getState pode virar CONNECTED antes de o whatsapp-web.js concluir
                // a injecao dos helpers (ready). Nao publique um falso conectado.
                if (hgpClientReady) {
                    await confirmarLegacyConectado();
                    return { status: 'connected', qr: null, lastError: null };
                }
                return { status: 'connecting', qr: null, lastError: null };
            }
        } catch (e) {
            // segue exibindo o estado conhecido abaixo
        }
    }

    if (currentQR) {
        return { status: 'qr_ready', qr: currentQR, lastError: whatsappLastError };
    }

    if (status === 'connecting') {
        return { status: 'connecting', qr: null, lastError: whatsappLastError };
    }

    if (!hgpTemSessaoSalva()) {
        status = 'disconnected';
    }

    return { status, qr: null, lastError: whatsappLastError };
}

const readChatbotFile = async () => fs.readFile(CHATBOT_FILE_PATH, 'utf8');

const validateChatbotSource = async (source) => {
    const tempFile = path.join(
        os.tmpdir(),
        `chatbot-${Date.now()}-${Math.random().toString(36).slice(2)}.js`
    );

    await fs.writeFile(tempFile, source, 'utf8');

    try {
        await execFileAsync(process.execPath, ['--check', tempFile]);
        return null;
    } catch (error) {
        return (error.stderr || error.stdout || error.message || 'Erro de sintaxe desconhecido').trim();
    } finally {
        await fs.unlink(tempFile).catch(() => null);
    }
};

const isValidIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

const buildWhatsAppNumberVariations = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    if (!digits) {
        return [];
    }

    const normalized = digits.startsWith('55') ? digits : `55${digits}`;
    const variations = new Set([digits, normalized]);

    if (normalized.length === 13) {
        variations.add(normalized.slice(0, 4) + normalized.slice(5));
    }

    if (normalized.length === 12) {
        variations.add(normalized.slice(0, 4) + '9' + normalized.slice(4));
    }

    return Array.from(variations).filter(Boolean);
};

const resolveWhatsAppDestination = async (...candidates) => {
    return resolveWhatsAppDestinationWith(whatsappClient, whatsappState === 'connected', ...candidates);
};

const resolveWhatsAppDestinationWith = async (clientArg, isConnected, ...candidates) => {
    if (!clientArg || !isConnected) {
        return null;
    }

    for (const candidate of candidates) {
        const rawValue = String(candidate || '').trim();
        if (!rawValue) {
            continue;
        }

        if (rawValue.endsWith('@c.us') || rawValue.endsWith('@g.us') || rawValue.endsWith('@lid')) {
            return rawValue;
        }

        for (const number of buildWhatsAppNumberVariations(rawValue)) {
            try {
                const numberId = await clientArg.getNumberId(number);
                if (numberId?._serialized) {
                    return numberId._serialized;
                }
            } catch (error) {
                console.log(`Nao foi possivel resolver o destino ${number} no WhatsApp:`, error.message || error);
            }
        }
    }

    return null;
};

const listEscalaUsers = async (req = null) => {
    // Filtro por unidades (admin = null = todos)
    const ids = req?.session?.unidadeIds;
    let extraSql = '';
    const extraParams = [];
    if (Array.isArray(ids)) {
        if (ids.length === 0) {
            extraSql = ' AND a.id = ?';
            extraParams.push(req.session.userId);
        } else {
            const ph = ids.map(() => '?').join(',');
            extraSql = ` AND a.id IN (SELECT au.admin_id FROM admin_unidades au WHERE au.unidade_id IN (${ph}))`;
            extraParams.push(...ids);
        }
    }

    const [users] = await db.query(`
        SELECT
            a.id,
            a.username,
            COALESCE(NULLIF(a.nome_completo, ''), a.username) AS nome_exibicao,
            a.telefone,
            a.nivel_acesso
        FROM admins a
        WHERE a.ativo = TRUE
          AND a.telefone IS NOT NULL
          AND a.telefone <> ''
          ${extraSql}
        ORDER BY nome_exibicao ASC
    `, extraParams);

    return users;
};

const listEscalas = async (req = null) => {
    const ids = req?.session?.unidadeIds;
    let extraSql = '';
    const extraParams = [];
    if (Array.isArray(ids)) {
        if (ids.length === 0) {
            extraSql = ' AND a.id = ?';
            extraParams.push(req.session.userId);
        } else {
            const ph = ids.map(() => '?').join(',');
            extraSql = ` AND a.id IN (SELECT au.admin_id FROM admin_unidades au WHERE au.unidade_id IN (${ph}))`;
            extraParams.push(...ids);
        }
    }

    const [rows] = await db.query(`
        SELECT
            e.id,
            DATE_FORMAT(e.data_escala, '%Y-%m-%d') AS data_escala,
            e.admin_id,
            a.username,
            COALESCE(NULLIF(a.nome_completo, ''), a.username) AS tecnico_nome,
            a.telefone,
            a.nivel_acesso,
            e.created_at,
            e.updated_at
        FROM escalas e
        INNER JOIN admins a ON a.id = e.admin_id
        WHERE 1=1 ${extraSql}
        ORDER BY e.data_escala DESC, tecnico_nome ASC
    `, extraParams);

    return rows;
};

const buildEscalaStats = (escalas) => {
    const hoje = dayjs().format('YYYY-MM-DD');

    return {
        total: escalas.length,
        hoje: escalas.filter((item) => item.data_escala === hoje).length,
        futuras: escalas.filter((item) => item.data_escala >= hoje).length,
        tecnicos: new Set(escalas.map((item) => item.admin_id)).size
    };
};

const buildSlug = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);

const listChatbotFlows = async () => {
    const [rows] = await db.query(`
        SELECT
            f.id,
            f.name,
            f.slug,
            f.description,
            f.is_default,
            f.is_active,
            f.source_file,
            f.created_at,
            f.updated_at,
            COUNT(s.id) AS total_steps
        FROM chatbot_flows f
        LEFT JOIN chatbot_flow_steps s ON s.flow_id = f.id
        GROUP BY f.id, f.name, f.slug, f.description, f.is_default, f.is_active, f.source_file, f.created_at, f.updated_at
        ORDER BY f.is_default DESC, f.updated_at DESC, f.name ASC
    `);

    return rows;
};

const getChatbotFlowById = async (flowId) => {
    const [flows] = await db.query(
        `SELECT id, name, slug, description, is_default, is_active, source_file, created_at, updated_at
         FROM chatbot_flows
         WHERE id = ?`,
        [flowId]
    );

    if (flows.length === 0) {
        return null;
    }

    const [steps] = await db.query(
        `SELECT
            id,
            flow_id,
            step_key,
            title,
            prompt_text,
            field_key,
            validation_type,
            next_step,
            error_message,
            conditions_text,
            action_summary,
            sort_order,
            is_terminal,
            created_at,
            updated_at
         FROM chatbot_flow_steps
         WHERE flow_id = ?
         ORDER BY sort_order ASC, step_key ASC`,
        [flowId]
    );

    return {
        flow: flows[0],
        steps
    };
};

const buildFluxoStats = (flows, selectedFlowData) => ({
    totalFlows: flows.length,
    ativos: flows.filter((flow) => flow.is_active).length,
    padroes: flows.filter((flow) => flow.is_default).length,
    etapas: selectedFlowData?.steps?.length || 0
});

// ─── Helpers para filtrar por unidades do usuário ──────────────────
// Retorna { sql, params } para usar como cláusula adicional em queries
// Exemplo: WHERE 1=1 ${unidadeWhere.sql}  → adiciona AND ...
function buildUnidadeWhere(req, alias = '', columnName = 'unidade_id') {
    const ids = req?.session?.unidadeIds;
    // null = administrador, vê tudo
    if (!Array.isArray(ids)) {
        return { sql: '', params: [] };
    }
    const col = alias ? `${alias}.${columnName}` : columnName;
    if (ids.length === 0) {
        // Sem unidade vinculada: ver só registros sem unidade (legado)
        return { sql: ` AND ${col} IS NULL`, params: [] };
    }
    const placeholders = ids.map(() => '?').join(',');

    // Filtro adicional por local (sub-unidade)
    const localIds = req?.session?.localIds;
    const localCol = alias ? `${alias}.local_id` : 'local_id';
    let localSql = '';
    const localParams = [];

    if (Array.isArray(localIds) && localIds.length > 0) {
        // Usuário tem locais vinculados: ver chamados daqueles locais + chamados sem local definido (legado)
        const localPh = localIds.map(() => '?').join(',');
        localSql = ` AND (${localCol} IS NULL OR ${localCol} IN (${localPh}))`;
        localParams.push(...localIds);
    }
    // Se localIds é null: sem filtro de local, vê tudo da unidade

    return {
        sql: ` AND ${col} IN (${placeholders})${localSql}`,
        params: [...ids, ...localParams]
    };
}

// Filtrar admins por unidade (via admin_unidades). Admin sempre vê todos.
// Retorna { sql, params } para colocar no WHERE da query de admins.
function buildAdminUnidadeWhere(req, adminAlias = 'a') {
    const ids = req?.session?.unidadeIds;
    if (!Array.isArray(ids)) {
        return { sql: '', params: [] };
    }
    if (ids.length === 0) {
        // Sem unidade vinculada: ver só si mesmo
        return { sql: ` AND ${adminAlias}.id = ?`, params: [req.session.userId] };
    }
    const placeholders = ids.map(() => '?').join(',');
    return {
        sql: ` AND ${adminAlias}.id IN (
            SELECT au.admin_id FROM admin_unidades au WHERE au.unidade_id IN (${placeholders})
        )`,
        params: [...ids]
    };
}

// Retorna o cliente WhatsApp adequado para enviar mensagem a partir de um chamado
async function obterClienteWhatsAppParaChamado(chamado) {
    if (chamado.instancia_id) {
        const [insts] = await db.query(
            'SELECT is_legacy, nome, session_name FROM instancias WHERE id = ? LIMIT 1',
            [chamado.instancia_id]
        );
        if (insts.length > 0 && !insts[0].is_legacy) {
            const cli = instanceManager.obterCliente(chamado.instancia_id);
            if (!cli) {
                console.warn(`[obterCliente] Instância "${insts[0].nome}" (id=${chamado.instancia_id}) não está no pool em memória. Tentando reconectar...`);
                // Tentar reconectar agora
                try {
                    await instanceManager.iniciarInstancia(chamado.instancia_id);
                    // Aguardar até 8 segundos para conectar
                    for (let i = 0; i < 16; i++) {
                        await new Promise(r => setTimeout(r, 500));
                        const cli2 = instanceManager.obterCliente(chamado.instancia_id);
                        if (cli2) return { client: cli2, isConnected: true };
                    }
                } catch (e) {
                    console.error('[obterCliente] Erro ao tentar reconectar:', e.message);
                }
                return { client: null, isConnected: false };
            }
            return { client: cli, isConnected: true };
        }
    }
    // Default: legacy (HGP)
    return {
        client: whatsappClient,
        isConnected: whatsappClient && whatsappState === 'connected'
    };
}

function obterControllerParaChamado(chamado) {
    if (chamado?.instancia_id) {
        const ctrl = instanceManager.obterController(chamado.instancia_id);
        if (ctrl) return ctrl;
    }
    return whatsappChatbotController;
}

function encerrarFluxoBotDoChamado(chamado) {
    const ctrl = obterControllerParaChamado(chamado);
    if (!ctrl || typeof ctrl.liberarSessao !== 'function') return;
    const ids = [chamado.chat_origem, chamado.telefone_whatsapp, chamado.telefone_contato]
        .filter(Boolean)
        .map(v => String(v).trim());
    for (const id of ids) {
        try { ctrl.liberarSessao(id); } catch (e) {}
        const digits = id.replace(/@.*$/, '').replace(/\D/g, '');
        if (digits) {
            try { ctrl.liberarSessao(`${digits}@c.us`); } catch (e) {}
            try { ctrl.liberarSessao(`${digits}@s.whatsapp.net`); } catch (e) {}
            try { ctrl.liberarSessao(digits); } catch (e) {}
        }
    }
}

const listChamadosOverview = async (req = null) => {
    const unidadeId = req ? resolveUnidadeFiltro(req) : null;
    const { sql, params } = req?.session
        ? buildChamadosListWhere(req, { unidadeId })
        : { sql: 'WHERE 1=1', params: [] };

    // Ativos NUNCA podem ficar de fora (antes LIMIT 200 por criado_em
    // escondia chamados antigos ainda em_atendimento — ex.: SESAU-0806-WYW).
    const [ativos] = await db.query(`
        SELECT *
        FROM chamados
        ${sql}
          AND status IN ('pendente', 'aberto', 'em_atendimento')
        ORDER BY criado_em DESC
    `, params);

    const [finalizados] = await db.query(`
        SELECT *
        FROM chamados
        ${sql}
          AND status = 'finalizado'
        ORDER BY COALESCE(encerrado_em, criado_em) DESC
        LIMIT 100
    `, params);

    // Busca por protocolo/nome: inclui matches fora do recorte de finalizados
    const busca = String(req?.query?.q || '').trim();
    let buscaExtra = [];
    if (busca.length >= 2) {
        const like = `%${busca}%`;
        const idsCarregados = new Set([...ativos, ...finalizados].map((c) => c.id));
        const [encontrados] = await db.query(`
            SELECT *
            FROM chamados
            ${sql}
              AND (
                    protocolo LIKE ?
                 OR solicitante_nome LIKE ?
                 OR setor LIKE ?
                 OR categoria LIKE ?
              )
            ORDER BY criado_em DESC
            LIMIT 50
        `, [...params, like, like, like, like]);
        buscaExtra = encontrados.filter((c) => !idsCarregados.has(c.id));
    }

    const chamados = [...ativos, ...finalizados, ...buscaExtra];

    // Contagem real no banco (não só dos registros carregados)
    const [counts] = await db.query(`
        SELECT
            COUNT(*) AS total,
            COALESCE(SUM(status = 'aberto'), 0) AS aberto,
            COALESCE(SUM(status = 'pendente'), 0) AS pendente,
            COALESCE(SUM(status = 'em_atendimento'), 0) AS em_atendimento,
            COALESCE(SUM(status = 'finalizado'), 0) AS finalizado
        FROM chamados
        ${sql}
    `, params);

    const contagem = {
        total: Number(counts[0]?.total || 0),
        aberto: Number(counts[0]?.aberto || 0),
        pendente: Number(counts[0]?.pendente || 0),
        em_atendimento: Number(counts[0]?.em_atendimento || 0),
        finalizado: Number(counts[0]?.finalizado || 0)
    };

    return { chamados, contagem };
};

// Middleware de autenticação
const isAuthenticated = (req, res, next) => {
    if (req.session.userId) {
        return next();
    }

    if (isApiRequest(req)) {
        return res.status(401).json({ success: false, message: 'Sessão expirada' });
    }

    res.redirect('/');
};

// Middleware de verificação de nível de acesso
const isAdmin = (req, res, next) => {
    if (req.session.nivelAcesso === 'administrador' || req.session.nivelAcesso === 'gerenciador') {
        return next();
    }

    if (isApiRequest(req)) {
        return res.status(403).json({ success: false, message: 'Acesso negado. Apenas administradores e gerenciadores.' });
    }

    res.redirect('/chamados');
};

// Middleware para funcionalidades exclusivas do administrador (fluxo bot, configurações)
const isAdminOnly = (req, res, next) => {
    if (req.session.nivelAcesso === 'administrador') {
        return next();
    }

    if (isApiRequest(req)) {
        return res.status(403).json({ success: false, message: 'Acesso negado. Apenas administradores.' });
    }

    res.redirect('/chamados');
};

// Rotas
app.get('/', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/dashboard');
    }
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        // Aceitar login por username OU CPF
        const cpfLimpo = String(username || '').replace(/\D/g, '');
        const [users] = await db.query(
            `SELECT * FROM admins 
             WHERE ativo = TRUE 
               AND (username = ? OR REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), ' ', '') = ?)
             LIMIT 1`,
            [username, cpfLimpo]
        );
        
        if (users.length === 0) {
            return res.render('login', { error: 'Usuário ou senha inválidos' });
        }
        
        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return res.render('login', { error: 'Usuário ou senha inválidos' });
        }
        
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.nivelAcesso = user.nivel_acesso;
        req.session.nomeCompleto = user.nome_completo;

        // Carregar unidades/locais (admin com vínculos respeita o filtro; sem vínculos = todas)
        await refreshUserScope(req);
        
        // Redirecionar baseado no nível de acesso
        if (user.nivel_acesso === 'gestor' || user.nivel_acesso === 'visualizador') {
            res.redirect('/chamados');
        } else {
            res.redirect('/dashboard');
        }
    } catch (error) {
        console.error('Erro no login:', error);
        res.render('login', { error: 'Erro ao fazer login' });
    }
});

app.get('/dashboard', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const ids = req.session.unidadeIds;
        const isAdminFull = !Array.isArray(ids); // null = administrador

        let session = null;
        let qrCode = null;
        let isLegacy = true;

        if (isAdminFull) {
            // Administrador: mostra a instância legada (HGP) como antes
            const legacyRuntime = await obterRuntimeLegacyStatus({ probe: true });
            const [sessions] = await db.query('SELECT * FROM whatsapp_sessions ORDER BY id DESC LIMIT 1');
            session = sessions[0]
                ? { ...sessions[0], is_connected: legacyRuntime.status === 'connected' }
                : null;
            qrCode = legacyRuntime.qr;
        } else if (ids.length > 0) {
            // Buscar instância(s) das unidades do usuário
            const ph = ids.map(() => '?').join(',');
            const [insts] = await db.query(
                `SELECT i.*, u.nome AS unidade_nome
                 FROM instancias i
                 LEFT JOIN unidades u ON u.id = i.unidade_id
                 WHERE i.unidade_id IN (${ph}) AND i.ativo = TRUE
                 ORDER BY i.is_legacy DESC, i.atualizado_em DESC
                 LIMIT 1`,
                ids
            );
            if (insts.length > 0) {
                const inst = insts[0];
                isLegacy = !!inst.is_legacy;

                // Sincronizar status real da legada antes de exibir
                let legacyRuntime = null;
                if (isLegacy) {
                    legacyRuntime = await obterRuntimeLegacyStatus({ probe: true });
                    inst.status = legacyRuntime.status;
                }

                session = {
                    session_name: inst.session_name,
                    is_connected: inst.status === 'connected',
                    last_connected: inst.last_connected,
                    nome: inst.nome,
                    unidade_nome: inst.unidade_nome,
                    instancia_id: inst.id,
                    is_legacy: isLegacy
                };
                qrCode = isLegacy ? legacyRuntime?.qr : inst.qr_code;
            }
        }

        res.render('dashboard', {
            username: req.session.username,
            session,
            qrCode,
            isLegacyInstance: isLegacy
        });
    } catch (error) {
        console.error('Erro ao carregar dashboard:', error);
        res.render('dashboard', { username: req.session.username, session: null, qrCode: null, isLegacyInstance: true });
    }
});

// Função reutilizável de iniciar WhatsApp legado (HGP)
async function iniciarWhatsAppLegacy() {
    if (whatsappState === 'connected') return { ok: true, alreadyConnected: true };
    if (whatsappState === 'connecting' && whatsappClient) return { ok: true, connecting: true };

    cancelarReconexaoHgp();

    if (whatsappClient) {
        try { await whatsappClient.destroy(); } catch (e) {}
        whatsappClient = null;
    }

    whatsappState = 'connecting';
    hgpClientReady = false;
    hgpConnectingSince = Date.now();
    currentQR = null;
    whatsappLastError = null;

    whatsappClient = HGP_USES_BAILEYS
        ? new BaileysClient({ clientId: 'admin-session', authDir: HGP_BAILEYS_AUTH_DIR })
        : new Client({
            authStrategy: new LocalAuth({ clientId: 'admin-session', dataPath: HGP_AUTH_DIR }),
            puppeteer: buildPuppeteerConfig(),
            restartOnAuthFail: false,
            authTimeoutMs: 120000,
            takeoverOnConflict: true,
            takeoverTimeoutMs: 10000
        });

    console.log(`[HGP] Iniciando cliente ${HGP_USES_BAILEYS ? 'Baileys' : 'whatsapp-web.js'}`);

    // Eventos de um cliente que já foi substituído não podem mexer no estado
    // global (nem resetar/derrubar o cliente atual).
    const esteCliente = whatsappClient;
    const ehAtual = () => whatsappClient === esteCliente;

    whatsappChatbotController = attachChatbot(whatsappClient, { managedByServer: true });

    whatsappClient.on('qr', async (qr) => {
        if (!ehAtual()) return;
        whatsappState = 'connecting';
        whatsappLastError = null;
        currentQR = String(qr || '').startsWith('data:image/')
            ? String(qr)
            : await qrcode.toDataURL(qr);
        await db.query(
            'INSERT INTO whatsapp_sessions (session_name, qr_code, is_connected) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE qr_code = ?, is_connected = ?',
            ['admin-session', currentQR, false, currentQR, false]
        );
        await syncLegacyInstanciaStatus('qr_ready', currentQR);
        console.log('[HGP] QR Code gerado — escaneie no painel /instancias');
    });

    whatsappClient.on('authenticated', async () => {
        if (!ehAtual()) return;
        console.log('[HGP] WhatsApp autenticado — aguardando sincronização...');
        whatsappState = 'connecting';
        whatsappLastError = null;
        currentQR = null;
        await db.query(
            'UPDATE whatsapp_sessions SET is_connected = ?, qr_code = NULL WHERE session_name = ?',
            [false, 'admin-session']
        );
        await syncLegacyInstanciaStatus('connecting', null);
    });

    whatsappClient.on('ready', async () => {
        if (!ehAtual()) {
            try { await esteCliente.destroy(); } catch (e) {}
            return;
        }
        console.log('[HGP] WhatsApp conectado ✓');
        hgpClientReady = true;
        anexarWatchdogChrome(whatsappClient);
        await confirmarLegacyConectado();
    });

    whatsappClient.on('change_state', (state) => {
        if (!ehAtual()) return;
        console.log('[HGP] change_state:', state);
        if (['CONFLICT', 'UNLAUNCHED', 'TIMEOUT'].includes(String(state || ''))) {
            forcarReconexaoHgp(`change_state:${state}`).catch(() => {});
        }
    });

    whatsappClient.on('auth_failure', async (message) => {
        try { await esteCliente.destroy(); } catch (e) {}
        if (!ehAtual()) return;
        console.error('[HGP] Falha de autenticação:', message);
        whatsappLastError = `Falha de autenticação do WhatsApp: ${message}`;
        await resetWhatsAppRuntime();
        agendarReconexaoHgp(`auth_failure: ${message}`);
    });

    whatsappClient.on('disconnected', async (reason) => {
        try { await esteCliente.destroy(); } catch (e) {}
        if (!ehAtual()) return;
        console.log('[HGP] WhatsApp desconectado:', reason);
        whatsappLastError = `WhatsApp desconectado: ${reason}`;
        await resetWhatsAppRuntime();
        agendarReconexaoHgp(reason);
    });

    whatsappClient.on('message', async (message) => {
        const primeiraEntrega = registrarIdMensagemHgp(message);
        const origemMensagem = message._hgpRecoverySource || (primeiraEntrega ? 'evento' : 'duplicada');
        console.log(
            `[HGP] msg recebida de ${message.from} id=${obterIdMensagemHgp(message)} origem=${origemMensagem} pid=${process.pid}`
        );
        try {
            const [sessions] = await db.query('SELECT id FROM whatsapp_sessions WHERE session_name = ?', ['admin-session']);
            if (primeiraEntrega && sessions.length > 0) {
                await db.query(
                    'INSERT INTO messages (session_id, from_number, to_number, message_body, message_type, is_from_me) VALUES (?, ?, ?, ?, ?, ?)',
                    [
                        sessions[0].id,
                        message.from,
                        message.to,
                        message.body || '',
                        String(message.type || 'text').slice(0, 100),
                        message.fromMe
                    ]
                );
            }
        } catch (error) {
            console.error('[HGP] Erro ao registrar mensagem:', error);
        }
    });

    whatsappClient.initialize().catch(async (error) => {
        try { await esteCliente.destroy(); } catch (e) {}
        if (!ehAtual()) return;
        console.error('[HGP] Erro ao inicializar cliente:', error);
        whatsappLastError = formatWhatsAppError(error);
        await resetWhatsAppRuntime();
        agendarReconexaoHgp(error.message || 'initialize_failed');
    });

    return { ok: true, started: true };
}

app.post('/whatsapp/connect', isAuthenticated, async (req, res) => {
    try {
        if (whatsappState === 'connected') {
            return res.json({ success: true, connected: true, message: 'WhatsApp já está conectado' });
        }
        if (whatsappState === 'connecting' && whatsappClient) {
            return res.json({ success: true, connected: false, message: 'Conexão com WhatsApp em andamento' });
        }
        await iniciarWhatsAppLegacy();
        res.json({ success: true, connected: false, message: 'Conectando ao WhatsApp...' });
    } catch (error) {
        console.error('Erro ao conectar:', error);
        await resetWhatsAppRuntime();
        res.status(500).json({ success: false, message: 'Erro ao conectar' });
    }
});

app.get('/whatsapp/status', isAuthenticated, async (req, res) => {
    try {
        // Para gerenciador/gestor com unidade vinculada não-HGP: usar o status da instância da unidade
        const ids = req.session.unidadeIds;
        if (Array.isArray(ids) && ids.length > 0) {
            const ph = ids.map(() => '?').join(',');
            const [insts] = await db.query(
                `SELECT * FROM instancias WHERE unidade_id IN (${ph}) AND ativo = TRUE
                 ORDER BY is_legacy DESC, atualizado_em DESC LIMIT 1`,
                ids
            );
            if (insts.length > 0) {
                const inst = insts[0];
                if (inst.is_legacy) {
                    // Legada: usa estado em memória
                    const legacyRuntime = await obterRuntimeLegacyStatus({ probe: true });
                    return res.json({
                        connected: legacyRuntime.status === 'connected',
                        state: legacyRuntime.status,
                        error: legacyRuntime.lastError,
                        qrCode: legacyRuntime.qr,
                        session: { session_name: 'admin-session', is_connected: legacyRuntime.status === 'connected' }
                    });
                }
                // Nova instância: usa status do banco
                return res.json({
                    connected: inst.status === 'connected',
                    state: inst.status,
                    error: inst.last_error,
                    qrCode: inst.status !== 'connected' ? inst.qr_code : null,
                    session: { session_name: inst.session_name, is_connected: inst.status === 'connected', last_connected: inst.last_connected }
                });
            }
        }

        // Administrador (sem unidade definida) ou sem instância: cai no comportamento padrão (legada)
        const legacyRuntime = await obterRuntimeLegacyStatus({ probe: true });
        const [sessions] = await db.query('SELECT * FROM whatsapp_sessions WHERE session_name = ?', ['admin-session']);
        res.json({
            connected: legacyRuntime.status === 'connected',
            state: legacyRuntime.status,
            error: legacyRuntime.lastError,
            qrCode: legacyRuntime.qr,
            session: sessions[0]
                ? {
                    ...sessions[0],
                    is_connected: legacyRuntime.status === 'connected'
                }
                : null
        });
    } catch (error) {
        res.status(500).json({ connected: false, state: 'disconnected', error: 'Erro ao consultar status do WhatsApp', qrCode: null, session: null });
    }
});

app.post('/whatsapp/disconnect', isAuthenticated, async (req, res) => {
    try {
        if (whatsappClient) {
            try {
                await whatsappClient.logout();
            } catch (error) {
                console.error('Erro ao fazer logout do WhatsApp:', error);
            }

            try {
                await whatsappClient.destroy();
            } catch (error) {
                console.error('Erro ao destruir cliente WhatsApp:', error);
            }
        }

        await resetWhatsAppRuntime();

        res.json({ success: true, message: 'WhatsApp desconectado com sucesso' });
    } catch (error) {
        console.error('Erro ao desconectar WhatsApp:', error);
        res.status(500).json({ success: false, message: 'Erro ao desconectar WhatsApp' });
    }
});

app.get('/messages', isAuthenticated, isAdmin, async (req, res) => {
    try {
        // Filtrar mensagens pelas instâncias das unidades do usuário
        const ids = req.session.unidadeIds;
        let extraSql = '';
        const extraParams = [];
        if (Array.isArray(ids)) {
            if (ids.length === 0) {
                // Sem unidade: ver só mensagens da instância legada (admin-session)
                extraSql = ` AND ws.session_name = 'admin-session'`;
            } else {
                const ph = ids.map(() => '?').join(',');
                extraSql = ` AND ws.session_name COLLATE utf8mb4_unicode_ci IN (
                    SELECT i.session_name COLLATE utf8mb4_unicode_ci FROM instancias i WHERE i.unidade_id IN (${ph})
                    UNION
                    SELECT 'admin-session' WHERE EXISTS (SELECT 1 FROM instancias WHERE is_legacy = TRUE AND unidade_id IN (${ph}))
                )`;
                extraParams.push(...ids, ...ids);
            }
        }

        const [messages] = await db.query(`
            SELECT m.*, ws.session_name 
            FROM messages m
            JOIN whatsapp_sessions ws ON m.session_id = ws.id
            WHERE 1=1 ${extraSql}
            ORDER BY m.timestamp DESC
            LIMIT 100
        `, extraParams);
        res.render('messages', { username: req.session.username, messages });
    } catch (error) {
        console.error('Erro ao carregar mensagens:', error);
        res.render('messages', { username: req.session.username, messages: [] });
    }
});

// ─── TV Dashboard (sem autenticação — para exibir na TV) ───────────────────
app.get('/tv', (req, res) => {
    // Se o usuário está logado, passar as unidades dele para a TV
    const unidadeIds = req.session?.unidadeIds || null;
    const nivelAcesso = req.session?.nivelAcesso || null;
    res.render('tv', { unidadeIds, nivelAcesso });
});

app.get('/api/tv/chamados', async (req, res) => {
    try {
        // Filtro por unidade via query param (ex: /api/tv/chamados?unidade_id=2 ou ?codigo=SESAU)
        let unidWhere = '';
        const unidParams = [];

        const unidadeId = req.query.unidade_id ? Number(req.query.unidade_id) : null;
        const codigoUnidade = req.query.codigo ? String(req.query.codigo).toUpperCase() : null;

        if (unidadeId) {
            unidWhere = ' AND (c.unidade_id IS NULL OR c.unidade_id = ?)';
            unidParams.push(unidadeId);
        } else if (codigoUnidade) {
            unidWhere = ` AND (c.unidade_id IS NULL OR c.unidade_id IN (
                SELECT id FROM unidades WHERE codigo = ? AND ativo = TRUE
            ))`;
            unidParams.push(codigoUnidade);
        }

        const [abertos] = await db.query(`
            SELECT
                c.id,
                c.protocolo,
                c.categoria,
                c.solicitante_nome,
                c.setor,
                c.status,
                c.atendente_nome,
                c.tecnico_nome,
                DATE_FORMAT(c.criado_em,   '%d/%m/%Y %H:%i') AS criado_fmt,
                DATE_FORMAT(c.iniciado_em, '%d/%m/%Y %H:%i') AS iniciado_fmt,
                DATE_FORMAT(c.encerrado_em,'%d/%m/%Y %H:%i') AS encerrado_fmt,
                TIMESTAMPDIFF(MINUTE, c.criado_em, NOW()) AS minutos_total
            FROM chamados c
            WHERE c.status IN ('pendente', 'aberto', 'em_atendimento')
            ${unidWhere}
            ORDER BY c.criado_em DESC
            LIMIT 50
        `, unidParams);

        const [finalizados] = await db.query(`
            SELECT
                c.id,
                c.protocolo,
                c.categoria,
                c.solicitante_nome,
                c.setor,
                c.status,
                c.atendente_nome,
                c.tecnico_nome,
                DATE_FORMAT(c.criado_em,   '%d/%m/%Y %H:%i') AS criado_fmt,
                DATE_FORMAT(c.iniciado_em, '%d/%m/%Y %H:%i') AS iniciado_fmt,
                DATE_FORMAT(c.encerrado_em,'%d/%m/%Y %H:%i') AS encerrado_fmt,
                TIMESTAMPDIFF(MINUTE, c.criado_em, c.encerrado_em) AS minutos_total
            FROM chamados c
            WHERE c.status = 'finalizado'
              AND c.encerrado_em >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            ${unidWhere}
            ORDER BY c.encerrado_em DESC
            LIMIT 300
        `, unidParams);

        const [stats] = await db.query(`
            SELECT
                SUM(status IN ('pendente','aberto','em_atendimento'))                                                        AS em_aberto,
                SUM(status = 'finalizado' AND encerrado_em >= DATE_SUB(NOW(), INTERVAL 24 HOUR))                             AS finalizados_24h,
                SUM(status = 'em_atendimento')                                                                               AS em_atendimento,
                SUM(status = 'pendente')                                                                                     AS pendentes,
                ROUND(AVG(CASE WHEN status = 'finalizado' AND encerrado_em IS NOT NULL
                    THEN TIMESTAMPDIFF(MINUTE, criado_em, encerrado_em) END), 0)                                             AS media_minutos_geral,
                ROUND(AVG(CASE WHEN status = 'finalizado' AND encerrado_em >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
                    THEN TIMESTAMPDIFF(MINUTE, criado_em, encerrado_em) END), 0)                                             AS media_minutos_24h
            FROM chamados
            WHERE 1=1
            ${unidWhere.replace(/c\./g, '')}
        `, unidParams);

        // Média das avaliações (1 a 5) por técnico nos últimos 30 dias.
        // Mesmo nome usado no ranking da TV: atendente_nome, senão tecnico_nome.
        // Falha aqui não pode derrubar a TV: sem avaliações, o ranking segue sem estrelas.
        let avaliacoesTecnicos = [];
        try {
            [avaliacoesTecnicos] = await db.query(`
                SELECT
                    COALESCE(NULLIF(c.atendente_nome, ''), NULLIF(c.tecnico_nome, ''), a.atendente_nome) AS tecnico,
                    ROUND(AVG(a.nota), 1) AS media,
                    COUNT(*) AS total
                FROM avaliacoes a
                JOIN chamados c ON c.id = a.chamado_id
                WHERE a.criado_em >= DATE_SUB(NOW(), INTERVAL 30 DAY)
                ${unidWhere}
                GROUP BY tecnico
            `, unidParams);
        } catch (e) {
            console.error('Erro TV API (avaliações):', e.message);
        }

        res.json({
            success: true,
            abertos,
            finalizados,
            stats: stats[0],
            avaliacoesTecnicos,
            timestamp: new Date()
        });
    } catch (error) {
        console.error('Erro TV API:', error);
        res.json({ success: false, abertos: [], finalizados: [], stats: {}, timestamp: new Date() });
    }
});

// ════════════════════════════════════════════════════════════════════
// MULTI-INSTÂNCIA — Unidades, Fluxos, Instâncias
// ════════════════════════════════════════════════════════════════════

// ─── UNIDADES ────────────────────────────────────────────────────
app.get('/unidades', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [unidades] = await db.query(`
            SELECT u.*, 
                   (SELECT COUNT(*) FROM admin_unidades au WHERE au.unidade_id = u.id) AS total_admins,
                   (SELECT COUNT(*) FROM instancias i WHERE i.unidade_id = u.id) AS total_instancias
            FROM unidades u
            ORDER BY u.nome
        `);
        res.render('unidades', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso,
            unidades
        });
    } catch (e) {
        console.error('Erro /unidades:', e);
        res.render('unidades', { username: req.session.username, nivelAcesso: req.session.nivelAcesso, unidades: [] });
    }
});

app.post('/api/unidades', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const { nome, codigo, descricao, cor } = req.body;
        if (!nome || !codigo) return res.json({ success: false, message: 'Nome e código são obrigatórios' });
        const [r] = await db.query(
            `INSERT INTO unidades (nome, codigo, descricao, cor, ativo) VALUES (?, ?, ?, ?, TRUE)`,
            [nome.trim(), codigo.trim().toUpperCase(), descricao || null, cor || '#25d366']
        );
        res.json({ success: true, id: r.insertId });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return res.json({ success: false, message: 'Código já existe' });
        res.json({ success: false, message: e.message });
    }
});

app.put('/api/unidades/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const { nome, codigo, descricao, cor, ativo } = req.body;
        await db.query(
            `UPDATE unidades SET nome = ?, codigo = ?, descricao = ?, cor = ?, ativo = ? WHERE id = ?`,
            [nome, codigo, descricao || null, cor || '#25d366', ativo ? 1 : 0, req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.delete('/api/unidades/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        await db.query('DELETE FROM unidades WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// Vincular admins a unidades
app.get('/api/unidades/:id/admins', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [vinc] = await db.query(
            `SELECT a.id, a.username, a.nome_completo, a.nivel_acesso
             FROM admins a
             JOIN admin_unidades au ON au.admin_id = a.id
             WHERE au.unidade_id = ? AND a.ativo = TRUE
             ORDER BY a.nome_completo, a.username`,
            [req.params.id]
        );
        const [todos] = await db.query(`
            SELECT id, username, nome_completo, nivel_acesso
            FROM admins
            WHERE ativo = TRUE
            ORDER BY nome_completo, username
        `);
        res.json({ success: true, vinculados: vinc, todos });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/api/unidades/:id/admins', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const { admin_ids } = req.body; // array de ids
        const unidadeId = req.params.id;
        await db.query('DELETE FROM admin_unidades WHERE unidade_id = ?', [unidadeId]);
        if (Array.isArray(admin_ids) && admin_ids.length > 0) {
            const values = admin_ids.map(id => [Number(id), Number(unidadeId)]);
            await db.query('INSERT INTO admin_unidades (admin_id, unidade_id) VALUES ?', [values]);
        }
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ─── LOCAIS (sub-unidades) ────────────────────────────────────────

// Listar locais de uma unidade
app.get('/api/unidades/:id/locais', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [locais] = await db.query(
            'SELECT id, nome, codigo, ativo FROM unidade_locais WHERE unidade_id = ? ORDER BY nome',
            [req.params.id]
        );
        res.json({ success: true, locais });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Salvar locais de uma unidade (substituir todos)
app.post('/api/unidades/:id/locais', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const unidadeId = Number(req.params.id);
        const { locais } = req.body;

        if (!Array.isArray(locais)) {
            return res.status(400).json({ success: false, message: 'Lista de locais inválida' });
        }

        // Remover locais que não estão na nova lista (mas manter se tem chamados vinculados)
        // Abordagem segura: desativar os antigos e inserir/atualizar os novos
        await db.query('UPDATE unidade_locais SET ativo = FALSE WHERE unidade_id = ?', [unidadeId]);

        for (const local of locais) {
            if (!local.nome) continue;
            const codigo = local.codigo || local.nome.trim().toUpperCase().replace(/\s+/g, '-').slice(0, 50);
            await db.query(
                `INSERT INTO unidade_locais (unidade_id, nome, codigo, ativo)
                 VALUES (?, ?, ?, TRUE)
                 ON DUPLICATE KEY UPDATE codigo = VALUES(codigo), ativo = TRUE`,
                [unidadeId, local.nome.trim(), codigo]
            );
        }

        res.json({ success: true, message: 'Locais atualizados' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Listar locais vinculados a um usuário
app.get('/api/usuarios/:id/locais', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [locais] = await db.query(`
            SELECT al.local_id, ul.nome, ul.codigo, u.nome AS unidade_nome
            FROM admin_locais al
            JOIN unidade_locais ul ON ul.id = al.local_id
            JOIN unidades u ON u.id = ul.unidade_id
            WHERE al.admin_id = ?
            ORDER BY u.nome, ul.nome
        `, [req.params.id]);
        res.json({ success: true, locais });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Salvar locais vinculados a um usuário
app.post('/api/usuarios/:id/locais', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const adminId = Number(req.params.id);
        const { local_ids } = req.body;

        await db.query('DELETE FROM admin_locais WHERE admin_id = ?', [adminId]);

        if (Array.isArray(local_ids) && local_ids.length > 0) {
            const values = local_ids.map(lid => [adminId, Number(lid)]);
            await db.query('INSERT INTO admin_locais (admin_id, local_id) VALUES ?', [values]);
        }

        // Invalidar sessão cached de localIds
        res.json({ success: true, message: 'Locais atualizados' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ─── FLOWS V2 ─────────────────────────────────────────────────────
app.get('/flows', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [flows] = await db.query(`
            SELECT id, nome, descricao, is_default, ativo, criado_em, atualizado_em
            FROM bot_flows_v2
            ORDER BY is_default DESC, nome
        `);
        res.render('flows', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso,
            flows
        });
    } catch (e) {
        res.render('flows', { username: req.session.username, nivelAcesso: req.session.nivelAcesso, flows: [] });
    }
});

app.get('/api/flows/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM bot_flows_v2 WHERE id = ?', [req.params.id]);
        if (rows.length === 0) return res.json({ success: false, message: 'Não encontrado' });
        const flow = rows[0];
        try {
            const [unidadesFlow] = await db.query(`
                SELECT DISTINCT u.codigo, u.nome
                FROM instancias i
                LEFT JOIN unidades u ON u.id = i.unidade_id
                WHERE i.flow_id = ?
            `, [req.params.id]);
            flow.definicao = normalizarFluxoSesau(JSON.parse(flow.definicao_json), {
                flowNome: flow.nome,
                unidadeCodigos: unidadesFlow.map((u) => u.codigo),
                unidadeNomes: unidadesFlow.map((u) => u.nome)
            });
        } catch (e) { flow.definicao = null; }
        delete flow.definicao_json;
        res.json({ success: true, flow });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/api/flows', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const { nome, descricao, definicao } = req.body;
        if (!nome || !definicao) return res.json({ success: false, message: 'Nome e definição são obrigatórios' });
        const json = typeof definicao === 'string' ? definicao : JSON.stringify(definicao);
        // Validar se é JSON válido
        try { JSON.parse(json); } catch (e) { return res.json({ success: false, message: 'Definição não é JSON válido' }); }
        const [r] = await db.query(
            `INSERT INTO bot_flows_v2 (nome, descricao, definicao_json, ativo) VALUES (?, ?, ?, TRUE)`,
            [nome.trim(), descricao || null, json]
        );
        res.json({ success: true, id: r.insertId });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.put('/api/flows/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const { nome, descricao, definicao, ativo } = req.body;
        const json = typeof definicao === 'string' ? definicao : JSON.stringify(definicao);
        try { JSON.parse(json); } catch (e) { return res.json({ success: false, message: 'Definição não é JSON válido' }); }
        await db.query(
            `UPDATE bot_flows_v2 SET nome = ?, descricao = ?, definicao_json = ?, ativo = ? WHERE id = ?`,
            [nome, descricao || null, json, ativo ? 1 : 0, req.params.id]
        );

        // Reiniciar instâncias que usam este fluxo (para recarregar a definição)
        const [insts] = await db.query(
            `SELECT id, status FROM instancias WHERE flow_id = ? AND is_legacy = FALSE AND ativo = TRUE`,
            [req.params.id]
        );
        const reiniciadas = [];
        for (const inst of insts) {
            if (inst.status === 'connected') {
                try {
                    await instanceManager.pararInstancia(inst.id);
                    // Aguardar um pouco antes de reiniciar
                    setTimeout(() => {
                        instanceManager.iniciarInstancia(inst.id).catch(err => {
                            console.error(`Erro ao reiniciar instância ${inst.id}:`, err.message);
                        });
                    }, 1500);
                    reiniciadas.push(inst.id);
                } catch (e) {
                    console.error(`Erro ao parar instância ${inst.id}:`, e.message);
                }
            }
        }

        res.json({
            success: true,
            instanciasReiniciadas: reiniciadas.length,
            message: reiniciadas.length > 0
                ? `Fluxo salvo. ${reiniciadas.length} instância(s) sendo reiniciada(s) com a nova definição.`
                : 'Fluxo salvo.'
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.delete('/api/flows/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [used] = await db.query('SELECT COUNT(*) AS c FROM instancias WHERE flow_id = ?', [req.params.id]);
        if (used[0].c > 0) return res.json({ success: false, message: 'Fluxo está vinculado a instâncias' });
        await db.query('DELETE FROM bot_flows_v2 WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// Helper: verifica se o usuário tem acesso para controlar uma instância
async function verificarAcessoInstancia(req, instanciaId) {
    // Administrador acessa tudo
    if (req.session.nivelAcesso === 'administrador') {
        return { ok: true };
    }

    const ids = req.session.unidadeIds;
    if (!Array.isArray(ids) || ids.length === 0) {
        return { ok: false, message: 'Sem permissão para esta instância' };
    }

    const [rows] = await db.query(
        'SELECT unidade_id, is_legacy FROM instancias WHERE id = ? LIMIT 1',
        [instanciaId]
    );
    if (rows.length === 0) {
        return { ok: false, message: 'Instância não encontrada' };
    }

    const inst = rows[0];

    // Não permite controle da legacy a quem não é admin (a legacy é HGP/admin)
    if (inst.is_legacy) {
        return { ok: false, message: 'Apenas administradores podem controlar a instância principal' };
    }

    if (!inst.unidade_id || !ids.includes(inst.unidade_id)) {
        return { ok: false, message: 'Você não tem acesso a esta instância' };
    }

    return { ok: true };
}

// ─── INSTÂNCIAS ───────────────────────────────────────────────────
app.get('/instancias', isAuthenticated, async (req, res) => {
    try {
        const legacyRuntime = await obterRuntimeLegacyStatus({ probe: true });

        // Sincronizar status da instância legada com o estado real do runtime
        await db.query(
            `UPDATE instancias SET status = ?, qr_code = ?, last_error = ? WHERE session_name = 'admin-session'`,
            [legacyRuntime.status, legacyRuntime.qr, legacyRuntime.lastError]
        );

        // Filtro por unidade do usuário
        const ids = req.session.unidadeIds;
        let unidWhere = '';
        const unidParams = [];
        if (Array.isArray(ids)) {
            if (ids.length === 0) {
                // Sem unidade vinculada e não é administrador: ver só legacy
                unidWhere = ' WHERE i.is_legacy = TRUE';
            } else {
                const ph = ids.map(() => '?').join(',');
                unidWhere = ` WHERE i.unidade_id IN (${ph})`;
                unidParams.push(...ids);
            }
        }

        const [instancias] = await db.query(`
            SELECT i.*, u.nome AS unidade_nome, u.cor AS unidade_cor, f.nome AS flow_nome
            FROM instancias i
            LEFT JOIN unidades u ON u.id = i.unidade_id
            LEFT JOIN bot_flows_v2 f ON f.id = i.flow_id
            ${unidWhere}
            ORDER BY i.is_legacy DESC, i.nome
        `, unidParams);

        // Listas auxiliares apenas para administrador (formulário de criação)
        const isAdminFull = req.session.nivelAcesso === 'administrador';
        let unidades = [];
        let flows = [];
        if (isAdminFull) {
            [unidades] = await db.query('SELECT id, nome, codigo FROM unidades WHERE ativo = TRUE ORDER BY nome');
            [flows] = await db.query('SELECT id, nome FROM bot_flows_v2 WHERE ativo = TRUE ORDER BY nome');
        }

        res.render('instancias', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso,
            instancias, unidades, flows
        });
    } catch (e) {
        console.error('Erro /instancias:', e);
        res.render('instancias', { username: req.session.username, nivelAcesso: req.session.nivelAcesso, instancias: [], unidades: [], flows: [] });
    }
});

app.post('/api/instancias', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const { nome, session_name, unidade_id, flow_id } = req.body;
        if (!nome || !session_name) return res.json({ success: false, message: 'Nome e session_name são obrigatórios' });
        if (session_name === 'admin-session') return res.json({ success: false, message: 'session_name "admin-session" é reservado' });

        const sessionSafe = String(session_name).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const [r] = await db.query(
            `INSERT INTO instancias (nome, session_name, unidade_id, flow_id, status, is_legacy, ativo)
             VALUES (?, ?, ?, ?, 'disconnected', FALSE, TRUE)`,
            [nome.trim(), sessionSafe, unidade_id || null, flow_id || null]
        );
        res.json({ success: true, id: r.insertId });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return res.json({ success: false, message: 'session_name já existe' });
        res.json({ success: false, message: e.message });
    }
});

app.put('/api/instancias/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [chk] = await db.query('SELECT is_legacy, status FROM instancias WHERE id = ?', [req.params.id]);
        if (chk.length === 0) return res.json({ success: false, message: 'Não encontrada' });
        if (chk[0].is_legacy) return res.json({ success: false, message: 'Não é possível editar a instância legada' });
        if (chk[0].status === 'connected' || chk[0].status === 'connecting') {
            return res.json({ success: false, message: 'Pare a instância antes de editar' });
        }

        const { nome, unidade_id, flow_id, ativo } = req.body;
        await db.query(
            `UPDATE instancias SET nome = ?, unidade_id = ?, flow_id = ?, ativo = ? WHERE id = ?`,
            [nome, unidade_id || null, flow_id || null, ativo ? 1 : 0, req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.delete('/api/instancias/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [chk] = await db.query('SELECT is_legacy FROM instancias WHERE id = ?', [req.params.id]);
        if (chk.length === 0) return res.json({ success: false, message: 'Não encontrada' });
        if (chk[0].is_legacy) return res.json({ success: false, message: 'Não é possível remover a instância legada' });

        await instanceManager.pararInstancia(Number(req.params.id)).catch(() => {});
        await db.query('DELETE FROM instancias WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/api/instancias/:id/iniciar', isAuthenticated, async (req, res) => {
    try {
        const id = Number(req.params.id);

        // Verificar acesso (gestor/gerenciador só pode iniciar instância de sua unidade)
        const acesso = await verificarAcessoInstancia(req, id);
        if (!acesso.ok) return res.status(403).json({ success: false, message: acesso.message });

        const [chk] = await db.query('SELECT is_legacy FROM instancias WHERE id = ?', [id]);
        if (chk.length === 0) return res.json({ success: false, message: 'Não encontrada' });

        if (chk[0].is_legacy) {
            // Iniciar a instância legada usando a função local
            if (whatsappState === 'connected') {
                return res.json({ success: true, message: 'HGP já está conectado' });
            }
            await iniciarWhatsAppLegacy();
            return res.json({ success: true, message: 'Conectando HGP — aguarde o QR Code' });
        }

        await instanceManager.iniciarInstancia(id);
        res.json({ success: true, message: 'Instância iniciada — aguarde o QR Code' });
    } catch (e) {
        console.error('Erro iniciar instância:', e);
        res.json({ success: false, message: e.message });
    }
});

app.post('/api/instancias/:id/parar', isAuthenticated, async (req, res) => {
    try {
        const id = Number(req.params.id);

        // Verificar acesso (gestor/gerenciador só pode parar instância de sua unidade)
        const acesso = await verificarAcessoInstancia(req, id);
        if (!acesso.ok) return res.status(403).json({ success: false, message: acesso.message });

        const [chk] = await db.query('SELECT is_legacy FROM instancias WHERE id = ?', [id]);
        if (chk.length === 0) return res.json({ success: false, message: 'Não encontrada' });

        if (chk[0].is_legacy) {
            // Desconectar a instância legada
            if (whatsappClient) {
                try { await whatsappClient.logout(); } catch (e) {}
                try { await whatsappClient.destroy(); } catch (e) {}
            }
            await resetWhatsAppRuntime();
            return res.json({ success: true });
        }

        await instanceManager.pararInstancia(id);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// Conectar TODAS as instâncias ativas que estão desconectadas
app.post('/api/instancias/conectar-todas', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [insts] = await db.query(
            `SELECT id, is_legacy, session_name, status FROM instancias 
             WHERE ativo = TRUE`
        );

        let iniciadas = 0;
        const legacyRuntime = await obterRuntimeLegacyStatus({ probe: true });
        for (const inst of insts) {
            try {
                if (inst.is_legacy) {
                    if (!['connected', 'connecting', 'qr_ready'].includes(legacyRuntime.status)) {
                        iniciarWhatsAppLegacy().catch(() => {});
                        iniciadas++;
                    }
                } else if (!['connected', 'connecting', 'qr_ready'].includes(inst.status)) {
                    instanceManager.iniciarInstancia(inst.id).catch(() => {});
                    iniciadas++;
                }
            } catch (e) {}
        }
        res.json({ success: true, message: `${iniciadas} instância(s) sendo conectada(s). Aguarde alguns segundos.` });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.get('/api/instancias/:id/status', isAuthenticated, async (req, res) => {
    try {
        const id = Number(req.params.id);

        // Verificar acesso (gestor/gerenciador só pode ver status de instância de sua unidade)
        const acesso = await verificarAcessoInstancia(req, id);
        if (!acesso.ok) return res.status(403).json({ success: false, message: acesso.message });

        const [rows] = await db.query('SELECT id, nome, session_name, status, qr_code, last_error, last_connected, is_legacy FROM instancias WHERE id = ?', [id]);
        if (rows.length === 0) return res.json({ success: false, message: 'Não encontrada' });

        let live;
        if (rows[0].is_legacy) {
            // Status real da legacy vem da memória
            live = await obterRuntimeLegacyStatus({ probe: true });
            rows[0].status = live.status;
            rows[0].qr_code = live.qr;
            rows[0].last_error = live.lastError;
        } else {
            live = instanceManager.obterStatus(id);
        }

        res.json({
            success: true,
            instancia: rows[0],
            runtime: live
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ════════════════════════════════════════════════════════════════════
// FIM Multi-Instância
// ════════════════════════════════════════════════════════════════════


app.get('/meus-chamados', isAuthenticated, async (req, res) => {
    try {
        res.render('meus-chamados', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador'
        });
    } catch (error) {
        console.error('Erro ao carregar meus chamados:', error);
        res.render('meus-chamados', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador'
        });
    }
});

app.get('/api/me/unidades', isAuthenticated, async (req, res) => {
    try {
        const escopo = await listarUnidadesDoEscopo(req);
        res.json({
            success: true,
            todas: escopo.todas,
            unidades: escopo.unidades,
            selected: resolveUnidadeFiltro(req)
        });
    } catch (error) {
        console.error('Erro ao listar unidades do usuário:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar unidades' });
    }
});

app.get('/chamados', isAuthenticated, async (req, res) => {
    try {
        // Garantir que nivelAcesso existe na sessão
        if (!req.session.nivelAcesso) {
            req.session.nivelAcesso = 'administrador';
        }

        const { chamados, contagem } = await listChamadosOverview(req);

        res.render('chamados', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador',
            chamados,
            contagem
        });
    } catch (error) {
        console.error('Erro ao carregar chamados:', error);
        res.render('chamados', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador',
            chamados: [],
            contagem: { total: 0, aberto: 0, pendente: 0, em_atendimento: 0, finalizado: 0 }
        });
    }
});

app.get('/api/chamados/overview', isAuthenticated, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        const overview = await listChamadosOverview(req);
        res.json({ success: true, ...overview });
    } catch (error) {
        console.error('Erro ao carregar overview de chamados:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar chamados em tempo real' });
    }
});

app.get('/api/chamados/pending-count', isAuthenticated, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');

        const { sql, params } = buildChamadosListWhere(req, {
            statuses: ['pendente', 'aberto']
        });

        const [rows] = await db.query(
            `SELECT COUNT(*) AS total FROM chamados ${sql}`,
            params
        );

        res.json({ success: true, total: Number(rows[0]?.total || 0) });
    } catch (error) {
        console.error('Erro ao carregar pendências de chamados:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar pendências' });
    }
});

app.get('/api/stats', isAuthenticated, async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Filtro de unidade do usuário logado
        const unidWhereSimple = buildUnidadeWhere(req, '', 'unidade_id');

        // Filtro de sessão por unidade (para tabela messages)
        const ids = req.session.unidadeIds;
        let msgSessionSql = '';
        let msgSessionParams = [];
        if (Array.isArray(ids) && ids.length > 0) {
            const ph = ids.map(() => '?').join(',');
            msgSessionSql = ` AND session_id IN (
                SELECT ws.id FROM whatsapp_sessions ws
                JOIN instancias i ON i.session_name COLLATE utf8mb4_unicode_ci = ws.session_name COLLATE utf8mb4_unicode_ci
                WHERE i.unidade_id IN (${ph})
            )`;
            msgSessionParams = [...ids];
        }
        // Se ids === null (admin) ou ids.length === 0: sem filtro, vê tudo

        const [messagesToday] = await db.query(
            `SELECT COUNT(*) as count FROM messages WHERE timestamp >= ? ${msgSessionSql}`,
            [today, ...msgSessionParams]
        );
        
        const [activeContacts] = await db.query(
            `SELECT COUNT(DISTINCT from_number) as count FROM messages WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY) ${msgSessionSql}`,
            msgSessionParams
        );

        // Dados das últimas 24h para o dashboard — filtrado por unidade
        const [chamados24h] = await db.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'pendente' THEN 1 ELSE 0 END) as pendentes,
                SUM(CASE WHEN status = 'em_atendimento' THEN 1 ELSE 0 END) as em_atendimento,
                SUM(CASE WHEN status = 'finalizado' THEN 1 ELSE 0 END) as finalizados
            FROM chamados
            WHERE criado_em >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            ${unidWhereSimple.sql}
        `, unidWhereSimple.params);

        const [chamadosHoje] = await db.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'finalizado' THEN 1 ELSE 0 END) as finalizados
            FROM chamados
            WHERE criado_em >= ?
            ${unidWhereSimple.sql}
        `, [today, ...unidWhereSimple.params]);

        // Mensagens por hora (últimas 12h) — filtrado por unidade/sessão
        const [msgsPorHora] = await db.query(`
            SELECT HOUR(timestamp) as hora, COUNT(*) as total
            FROM messages
            WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 12 HOUR)
            ${msgSessionSql}
            GROUP BY HOUR(timestamp)
            ORDER BY hora
        `, msgSessionParams);

        // Chamados por categoria (últimas 24h) — filtrado por unidade
        const [chamadosPorCategoria] = await db.query(`
            SELECT categoria, COUNT(*) as total
            FROM chamados
            WHERE criado_em >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            ${unidWhereSimple.sql}
            GROUP BY categoria
            ORDER BY total DESC
            LIMIT 5
        `, unidWhereSimple.params);

        // Atendentes mais ativos (últimas 24h) — filtrado por unidade
        const [atendentesAtivos] = await db.query(`
            SELECT atendente_nome, COUNT(*) as total
            FROM chamados
            WHERE atendente_nome IS NOT NULL
              AND criado_em >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            ${unidWhereSimple.sql}
            GROUP BY atendente_nome
            ORDER BY total DESC
            LIMIT 5
        `, unidWhereSimple.params);

        res.json({
            messagesToday: messagesToday[0].count,
            activeContacts: activeContacts[0].count,
            chamados24h: chamados24h[0],
            chamadosHoje: chamadosHoje[0],
            msgsPorHora,
            chamadosPorCategoria,
            atendentesAtivos
        });
    } catch (error) {
        res.json({ messagesToday: 0, activeContacts: 0, chamados24h: {}, chamadosHoje: {}, msgsPorHora: [], chamadosPorCategoria: [], atendentesAtivos: [] });
    }
});

app.get('/api/messages/recent', isAuthenticated, async (req, res) => {
    try {
        const [messages] = await db.query(`
            SELECT from_number, to_number, message_body, message_type, is_from_me, timestamp
            FROM messages
            ORDER BY timestamp DESC
            LIMIT 30
        `);
        res.json({ success: true, messages: messages.reverse() });
    } catch (error) {
        res.json({ success: false, messages: [] });
    }
});

app.get('/contacts', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [contacts] = await db.query(`
            SELECT * FROM contacts
            ORDER BY last_message_at DESC
        `);

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);

        const [statsToday] = await db.query(
            'SELECT COUNT(*) as count FROM contacts WHERE created_at >= ?',
            [today]
        );

        const [statsWeek] = await db.query(
            'SELECT COUNT(*) as count FROM contacts WHERE last_message_at >= ?',
            [weekAgo]
        );

        const stats = {
            total: contacts.length,
            today: statsToday[0].count,
            week: statsWeek[0].count
        };

        res.render('contacts', { 
            username: req.session.username, 
            contacts,
            stats
        });
    } catch (error) {
        console.error('Erro ao carregar contatos:', error);
        res.render('contacts', { 
            username: req.session.username, 
            contacts: [],
            stats: { total: 0, today: 0, week: 0 }
        });
    }
});

app.post('/api/contacts/sync', isAuthenticated, async (req, res) => {
    try {
        // Buscar todos os números únicos das mensagens (excluindo mensagens enviadas por nós)
        const [messages] = await db.query(`
            SELECT 
                from_number as phone_number,
                MIN(timestamp) as first_message,
                MAX(timestamp) as last_message,
                COUNT(*) as msg_count
            FROM messages
            WHERE is_from_me = FALSE
            GROUP BY from_number
        `);

        let synced = 0;

        for (const msg of messages) {
            // Tentar obter o nome do contato do WhatsApp se o cliente estiver conectado
            let contactName = null;
            
            if (whatsappClient && whatsappState === 'connected') {
                try {
                    const contact = await whatsappClient.getContactById(msg.phone_number);
                    contactName = contact.pushname || contact.name || null;
                } catch (error) {
                    // Ignorar erros ao buscar contato individual
                }
            }

            // Inserir ou atualizar contato
            const cleanNumber = msg.phone_number.replace(/@.*$/, '');
            await db.query(`
                INSERT INTO contacts (phone_number, contact_name, first_message_at, last_message_at, message_count)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    contact_name = COALESCE(VALUES(contact_name), contact_name),
                    first_message_at = LEAST(first_message_at, VALUES(first_message_at)),
                    last_message_at = GREATEST(last_message_at, VALUES(last_message_at)),
                    message_count = VALUES(message_count)
            `, [cleanNumber, contactName, msg.first_message, msg.last_message, msg.msg_count]);

            synced++;
        }

        res.json({ 
            success: true, 
            message: 'Contatos sincronizados com sucesso',
            synced
        });
    } catch (error) {
        console.error('Erro ao sincronizar contatos:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Erro ao sincronizar contatos' 
        });
    }
});

app.get('/escala', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [escalas, usuariosEscala] = await Promise.all([
            listEscalas(req),
            listEscalaUsers(req)
        ]);

        res.render('escala', {
            username: req.session.username,
            escalas,
            usuariosEscala,
            stats: buildEscalaStats(escalas),
            hoje: dayjs().format('YYYY-MM-DD')
        });
    } catch (error) {
        console.error('Erro ao carregar página de escala:', error);
        res.status(500).render('escala', {
            username: req.session.username,
            escalas: [],
            usuariosEscala: [],
            stats: { total: 0, hoje: 0, futuras: 0, tecnicos: 0 },
            hoje: dayjs().format('YYYY-MM-DD')
        });
    }
});

app.get('/fluxo', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const flows = await listChatbotFlows();
        const selectedFlowId = req.query.flowId ? Number(req.query.flowId) : flows[0]?.id;
        const selectedFlowData = selectedFlowId ? await getChatbotFlowById(selectedFlowId) : null;

        res.render('fluxo', {
            username: req.session.username,
            flows,
            selectedFlowData,
            stats: buildFluxoStats(flows, selectedFlowData)
        });
    } catch (error) {
        console.error('Erro ao carregar módulo de fluxo:', error);
        res.status(500).render('fluxo', {
            username: req.session.username,
            flows: [],
            selectedFlowData: null,
            stats: { totalFlows: 0, ativos: 0, padroes: 0, etapas: 0 }
        });
    }
});

app.get('/avaliacoes', isAuthenticated, isAdmin, async (req, res) => {
    try {
        // Filtrar avaliações pelos chamados da unidade do usuário
        const ids = req.session.unidadeIds;
        let extraSql = '';
        const extraParams = [];
        if (Array.isArray(ids)) {
            if (ids.length === 0) {
                extraSql = ' AND c.unidade_id IS NULL';
            } else {
                const ph = ids.map(() => '?').join(',');
                extraSql = ` AND (c.unidade_id IS NULL OR c.unidade_id IN (${ph}))`;
                extraParams.push(...ids);
            }
        }

        const [avaliacoes] = await db.query(`
            SELECT a.*, c.categoria, c.setor, c.unidade_id
            FROM avaliacoes a
            LEFT JOIN chamados c ON c.id = a.chamado_id
            WHERE 1=1 ${extraSql}
            ORDER BY a.criado_em DESC
            LIMIT 100
        `, extraParams);

        const [stats] = await db.query(`
            SELECT 
                COUNT(*) as total,
                ROUND(AVG(a.nota), 1) as media,
                SUM(CASE WHEN a.nota >= 4 THEN 1 ELSE 0 END) as positivas,
                SUM(CASE WHEN a.nota <= 2 THEN 1 ELSE 0 END) as negativas
            FROM avaliacoes a
            LEFT JOIN chamados c ON c.id = a.chamado_id
            WHERE 1=1 ${extraSql}
        `, extraParams);

        res.render('avaliacoes', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador',
            avaliacoes,
            stats: stats[0]
        });
    } catch (error) {
        console.error('Erro ao carregar avaliações:', error);
        res.render('avaliacoes', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador',
            avaliacoes: [],
            stats: { total: 0, media: 0, positivas: 0, negativas: 0 }
        });
    }
});

// API - Responder avaliação (justificativa do técnico)
app.post('/api/avaliacoes/:id/responder', isAuthenticated, async (req, res) => {
    try {
        const avaliacaoId = req.params.id;
        const { resposta } = req.body;

        if (!resposta || resposta.trim().length < 3) {
            return res.status(400).json({ success: false, message: 'A resposta deve ter pelo menos 3 caracteres' });
        }

        const [avaliacao] = await db.query('SELECT * FROM avaliacoes WHERE id = ?', [avaliacaoId]);
        if (avaliacao.length === 0) {
            return res.status(404).json({ success: false, message: 'Avaliação não encontrada' });
        }

        await db.query(
            `UPDATE avaliacoes 
             SET resposta_tecnico = ?, respondido_por = ?, respondido_em = NOW()
             WHERE id = ?`,
            [resposta.trim(), req.session.username, avaliacaoId]
        );

        res.json({ success: true, message: 'Resposta registrada com sucesso' });
    } catch (error) {
        console.error('Erro ao responder avaliação:', error);
        res.status(500).json({ success: false, message: 'Erro ao registrar resposta' });
    }
});

app.get('/relatorios', isAuthenticated, isAdmin, async (req, res) => {
    try {
        res.render('relatorios', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador'
        });
    } catch (error) {
        console.error('Erro ao carregar relatórios:', error);
        res.render('relatorios', {
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador'
        });
    }
});

// Monta WHERE do relatório: período + escopo de unidade + seletor + categoria
function buildRelatorioWhere(req) {
    const { dataInicio, dataFim, categoria } = req.query;
    let sql = 'WHERE DATE(c.criado_em) BETWEEN ? AND ?';
    const params = [dataInicio, dataFim];

    const unidadeId = resolveUnidadeFiltro(req);
    const ids = req.session?.unidadeIds;

    if (unidadeId) {
        sql += ' AND c.unidade_id = ?';
        params.push(unidadeId);
    } else if (Array.isArray(ids)) {
        if (ids.length === 0) {
            sql += ' AND c.unidade_id IS NULL';
        } else {
            const ph = ids.map(() => '?').join(',');
            sql += ` AND (c.unidade_id IS NULL OR c.unidade_id IN (${ph}))`;
            params.push(...ids);
        }
    }

    const cat = String(categoria || '').trim();
    if (cat) {
        sql += ' AND c.categoria = ?';
        params.push(cat);
    }

    return { sql, params, dataInicio, dataFim, categoria: cat || null, unidadeId };
}

app.get('/api/relatorios/chamados', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { dataInicio, dataFim } = req.query;

        if (!dataInicio || !dataFim) {
            return res.status(400).json({ success: false, message: 'Informe dataInicio e dataFim' });
        }

        const { sql: where, params } = buildRelatorioWhere(req);

        const [totalPeriodo] = await db.query(`
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN c.status = 'aberto' THEN 1 ELSE 0 END) as abertos,
                   SUM(CASE WHEN c.status = 'pendente' THEN 1 ELSE 0 END) as pendentes,
                   SUM(CASE WHEN c.status = 'em_atendimento' THEN 1 ELSE 0 END) as em_atendimento,
                   SUM(CASE WHEN c.status = 'finalizado' THEN 1 ELSE 0 END) as finalizados,
                   ROUND(AVG(CASE
                       WHEN c.status = 'finalizado' AND c.encerrado_em IS NOT NULL
                       THEN TIMESTAMPDIFF(MINUTE, c.criado_em, c.encerrado_em)
                   END)) as sla_medio_minutos
            FROM chamados c
            ${where}
        `, params);

        const [porSetor] = await db.query(`
            SELECT c.setor, COUNT(*) as total,
                   SUM(CASE WHEN c.status = 'finalizado' THEN 1 ELSE 0 END) as finalizados,
                   SUM(CASE WHEN c.status != 'finalizado' THEN 1 ELSE 0 END) as abertos
            FROM chamados c
            ${where}
            GROUP BY c.setor
            ORDER BY total DESC
        `, params);

        const [porCategoria] = await db.query(`
            SELECT c.categoria, COUNT(*) as total,
                   SUM(CASE WHEN c.status = 'finalizado' THEN 1 ELSE 0 END) as finalizados,
                   SUM(CASE WHEN c.status != 'finalizado' THEN 1 ELSE 0 END) as abertos
            FROM chamados c
            ${where}
            GROUP BY c.categoria
            ORDER BY total DESC
        `, params);

        // Chamados por técnico/operador. Nome vazio conta como "Sem atendente".
        // Avaliação: média das notas dos chamados do técnico no período (1 nota por chamado).
        const [porAtendente] = await db.query(`
            SELECT COALESCE(NULLIF(TRIM(c.atendente_nome), ''), NULLIF(TRIM(c.tecnico_nome), ''), 'Sem atendente') as atendente,
                   COUNT(*) as total,
                   SUM(CASE WHEN c.status = 'finalizado' THEN 1 ELSE 0 END) as finalizados,
                   SUM(CASE WHEN c.status = 'em_atendimento' THEN 1 ELSE 0 END) as em_atendimento,
                   SUM(CASE WHEN c.status NOT IN ('finalizado','em_atendimento') THEN 1 ELSE 0 END) as pendentes,
                   ROUND(AVG(CASE
                       WHEN c.status = 'finalizado' AND c.encerrado_em IS NOT NULL
                       THEN TIMESTAMPDIFF(MINUTE, c.criado_em, c.encerrado_em)
                   END)) as sla_medio_minutos,
                   ROUND(AVG(CASE
                       WHEN c.iniciado_em IS NOT NULL AND c.iniciado_em >= c.criado_em
                       THEN TIMESTAMPDIFF(MINUTE, c.criado_em, c.iniciado_em)
                   END)) as resposta_media_minutos,
                   ROUND(AVG(av.nota), 1) as avaliacao_media,
                   COUNT(av.nota) as avaliacoes
            FROM chamados c
            LEFT JOIN (
                SELECT chamado_id, AVG(nota) AS nota
                FROM avaliacoes
                GROUP BY chamado_id
            ) av ON av.chamado_id = c.id
            ${where}
            GROUP BY atendente
            ORDER BY (atendente = 'Sem atendente'), total DESC
        `, params);

        const [porDia] = await db.query(`
            SELECT DATE_FORMAT(c.criado_em, '%Y-%m-%d') as dia, COUNT(*) as total
            FROM chamados c
            ${where}
            GROUP BY dia
            ORDER BY dia ASC
        `, params);

        const [porSetorCategoria] = await db.query(`
            SELECT c.setor, c.categoria, COUNT(*) as total
            FROM chamados c
            ${where}
            GROUP BY c.setor, c.categoria
            ORDER BY c.setor, total DESC
        `, params);

        const [detalhes] = await db.query(`
            SELECT c.id, c.protocolo, c.solicitante_nome, c.setor, c.categoria, c.status,
                   COALESCE(c.atendente_nome, c.tecnico_nome) AS atendente_nome,
                   c.unidade_id, u.nome AS unidade_nome, u.codigo AS unidade_codigo,
                   c.criado_em, c.iniciado_em, c.encerrado_em, c.observacoes,
                   TIMESTAMPDIFF(
                       MINUTE,
                       c.criado_em,
                       COALESCE(c.encerrado_em, NOW())
                   ) AS sla_minutos
            FROM chamados c
            LEFT JOIN unidades u ON u.id = c.unidade_id
            ${where}
            ORDER BY c.criado_em DESC
            LIMIT 1000
        `, params);

        // Categorias disponíveis no escopo (sem filtro de categoria, para popular o select)
        const unidadeId = resolveUnidadeFiltro(req);
        const ids = req.session?.unidadeIds;
        let catWhere = 'WHERE 1=1';
        const catParams = [];
        if (unidadeId) {
            catWhere += ' AND unidade_id = ?';
            catParams.push(unidadeId);
        } else if (Array.isArray(ids)) {
            if (ids.length === 0) {
                catWhere += ' AND unidade_id IS NULL';
            } else {
                const ph = ids.map(() => '?').join(',');
                catWhere += ` AND (unidade_id IS NULL OR unidade_id IN (${ph}))`;
                catParams.push(...ids);
            }
        }
        const [categoriasRows] = await db.query(
            `SELECT DISTINCT categoria FROM chamados ${catWhere} AND categoria IS NOT NULL AND categoria != '' ORDER BY categoria`,
            catParams
        );

        const resumo = totalPeriodo[0] || {};
        resumo.slaMedioMinutos = resumo.sla_medio_minutos != null ? Number(resumo.sla_medio_minutos) : null;

        res.json({
            success: true,
            resumo,
            porSetor,
            porCategoria,
            porAtendente,
            porDia,
            porSetorCategoria,
            detalhes,
            categorias: categoriasRows.map(r => r.categoria)
        });
    } catch (error) {
        console.error('Erro ao gerar relatório:', error);
        res.status(500).json({ success: false, message: 'Erro ao gerar relatório' });
    }
});

app.get('/api/relatorios/chamados.csv', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { dataInicio, dataFim } = req.query;
        if (!dataInicio || !dataFim) {
            return res.status(400).send('Informe dataInicio e dataFim');
        }

        const { sql: where, params } = buildRelatorioWhere(req);

        const [rows] = await db.query(`
            SELECT c.protocolo, c.solicitante_nome, c.setor, c.categoria, c.status,
                   COALESCE(c.atendente_nome, c.tecnico_nome, '') AS atendente_nome,
                   COALESCE(u.codigo, u.nome, '') AS unidade,
                   c.criado_em, c.encerrado_em, c.observacoes,
                   TIMESTAMPDIFF(MINUTE, c.criado_em, COALESCE(c.encerrado_em, NOW())) AS sla_minutos
            FROM chamados c
            LEFT JOIN unidades u ON u.id = c.unidade_id
            ${where}
            ORDER BY c.criado_em DESC
            LIMIT 5000
        `, params);

        const esc = (v) => {
            const s = v == null ? '' : String(v);
            if (/[",\n\r;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
            return s;
        };
        const fmtDt = (d) => {
            if (!d) return '';
            const dt = new Date(d);
            if (Number.isNaN(dt.getTime())) return '';
            return dt.toLocaleString('pt-BR');
        };

        const header = [
            'Protocolo', 'Solicitante', 'Setor', 'Categoria', 'Status',
            'Atendente', 'Unidade', 'Criado em', 'Encerrado em', 'SLA (minutos)', 'Observacoes'
        ].join(';');

        const lines = rows.map(r => [
            esc(r.protocolo),
            esc(r.solicitante_nome),
            esc(r.setor),
            esc(r.categoria),
            esc(r.status),
            esc(r.atendente_nome),
            esc(r.unidade),
            esc(fmtDt(r.criado_em)),
            esc(fmtDt(r.encerrado_em)),
            esc(r.sla_minutos),
            esc(r.observacoes)
        ].join(';'));

        const csv = '\uFEFF' + header + '\n' + lines.join('\n');
        const filename = `relatorio-chamados-${dataInicio}_${dataFim}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
    } catch (error) {
        console.error('Erro ao exportar CSV:', error);
        res.status(500).send('Erro ao exportar CSV');
    }
});

app.get('/settings', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const chatbotCode = await readChatbotFile();
        const [settings] = await db.query('SELECT setting_key, setting_value FROM system_settings');
        const settingsMap = {};
        settings.forEach(s => { settingsMap[s.setting_key] = s.setting_value; });

        res.render('settings', {
            username: req.session.username,
            chatbotCode,
            chatbotFileName: 'chatbot.js',
            systemSettings: settingsMap
        });
    } catch (error) {
        console.error('Erro ao carregar configurações:', error);
        res.status(500).render('settings', {
            username: req.session.username,
            chatbotCode: '',
            chatbotFileName: 'chatbot.js',
            systemSettings: {}
        });
    }
});

app.get('/api/settings/system', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [settings] = await db.query('SELECT setting_key, setting_value FROM system_settings');
        const settingsMap = {};
        settings.forEach(s => { settingsMap[s.setting_key] = s.setting_value; });
        res.json({ success: true, settings: settingsMap });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro ao carregar configurações' });
    }
});

app.post('/api/settings/system', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const { key, value } = req.body;
        if (!key) return res.status(400).json({ success: false, message: 'Chave obrigatória' });

        await db.query(
            'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
            [key, String(value), String(value)]
        );
        res.json({ success: true, message: 'Configuração salva' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro ao salvar configuração' });
    }
});

app.get('/api/settings/chatbot-file', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const content = await readChatbotFile();
        res.json({ success: true, content, fileName: 'chatbot.js' });
    } catch (error) {
        console.error('Erro ao ler chatbot.js:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar chatbot.js' });
    }
});

app.post('/api/settings/chatbot-file', isAuthenticated, isAdminOnly, async (req, res) => {
    const { content } = req.body;

    if (typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ success: false, message: 'O conteúdo do arquivo não pode ficar vazio' });
    }

    try {
        const validationError = await validateChatbotSource(content);

        if (validationError) {
            return res.status(400).json({
                success: false,
                message: 'O arquivo não foi salvo porque há erro de sintaxe',
                details: validationError
            });
        }

        await fs.writeFile(CHATBOT_FILE_PATH, content, 'utf8');

        res.json({
            success: true,
            message: 'chatbot.js atualizado no projeto com sucesso'
        });
    } catch (error) {
        console.error('Erro ao salvar chatbot.js:', error);
        res.status(500).json({ success: false, message: 'Erro ao salvar chatbot.js' });
    }
});

app.get('/api/escala', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const escalas = await listEscalas(req);
        res.json({ success: true, escalas });
    } catch (error) {
        console.error('Erro ao listar escala:', error);
        res.status(500).json({ success: false, message: 'Erro ao listar escala' });
    }
});

app.get('/api/escala/:id', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id, DATE_FORMAT(data_escala, '%Y-%m-%d') AS data_escala, admin_id
             FROM escalas
             WHERE id = ?`,
            [req.params.id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Registro de escala não encontrado' });
        }

        res.json({ success: true, escala: rows[0] });
    } catch (error) {
        console.error('Erro ao buscar registro de escala:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar registro de escala' });
    }
});

app.get('/api/fluxos', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const flows = await listChatbotFlows();
        res.json({ success: true, flows });
    } catch (error) {
        console.error('Erro ao listar fluxos:', error);
        res.status(500).json({ success: false, message: 'Erro ao listar fluxos' });
    }
});

app.get('/api/fluxos/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const flowData = await getChatbotFlowById(req.params.id);

        if (!flowData) {
            return res.status(404).json({ success: false, message: 'Fluxo não encontrado' });
        }

        res.json({ success: true, ...flowData });
    } catch (error) {
        console.error('Erro ao buscar fluxo:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar fluxo' });
    }
});

app.post('/api/fluxos', isAuthenticated, isAdminOnly, async (req, res) => {
    const { name, description, is_active } = req.body;

    if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ success: false, message: 'Informe o nome do fluxo' });
    }

    try {
        const baseSlug = buildSlug(name);
        const slug = baseSlug || `fluxo-${Date.now()}`;
        const [existing] = await db.query('SELECT id FROM chatbot_flows WHERE slug = ?', [slug]);
        const finalSlug = existing.length > 0 ? `${slug}-${Date.now()}` : slug;

        const [result] = await db.query(
            `INSERT INTO chatbot_flows (name, slug, description, is_default, is_active, source_file)
             VALUES (?, ?, ?, FALSE, ?, NULL)`,
            [name.trim(), finalSlug, description || null, Boolean(is_active)]
        );

        res.json({ success: true, message: 'Fluxo criado com sucesso', id: result.insertId });
    } catch (error) {
        console.error('Erro ao criar fluxo:', error);
        res.status(500).json({ success: false, message: 'Erro ao criar fluxo' });
    }
});

app.put('/api/fluxos/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    const { name, description, is_active } = req.body;

    if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ success: false, message: 'Informe o nome do fluxo' });
    }

    try {
        const [flows] = await db.query('SELECT id, slug FROM chatbot_flows WHERE id = ?', [req.params.id]);
        if (flows.length === 0) {
            return res.status(404).json({ success: false, message: 'Fluxo não encontrado' });
        }

        await db.query(
            `UPDATE chatbot_flows
             SET name = ?, description = ?, is_active = ?
             WHERE id = ?`,
            [name.trim(), description || null, Boolean(is_active), req.params.id]
        );

        res.json({ success: true, message: 'Fluxo atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar fluxo:', error);
        res.status(500).json({ success: false, message: 'Erro ao atualizar fluxo' });
    }
});

app.delete('/api/fluxos/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [flows] = await db.query('SELECT id, is_default FROM chatbot_flows WHERE id = ?', [req.params.id]);
        if (flows.length === 0) {
            return res.status(404).json({ success: false, message: 'Fluxo não encontrado' });
        }

        if (flows[0].is_default) {
            return res.status(400).json({ success: false, message: 'O fluxo padrão não pode ser excluído' });
        }

        await db.query('DELETE FROM chatbot_flows WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Fluxo excluído com sucesso' });
    } catch (error) {
        console.error('Erro ao excluir fluxo:', error);
        res.status(500).json({ success: false, message: 'Erro ao excluir fluxo' });
    }
});

app.post('/api/fluxos/:id/steps', isAuthenticated, isAdminOnly, async (req, res) => {
    const {
        step_key,
        title,
        prompt_text,
        field_key,
        validation_type,
        next_step,
        error_message,
        conditions_text,
        action_summary,
        sort_order,
        is_terminal
    } = req.body;

    if (typeof step_key !== 'string' || !step_key.trim()) {
        return res.status(400).json({ success: false, message: 'Informe a chave da etapa' });
    }

    if (typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ success: false, message: 'Informe o título da etapa' });
    }

    try {
        const [flows] = await db.query('SELECT id FROM chatbot_flows WHERE id = ?', [req.params.id]);
        if (flows.length === 0) {
            return res.status(404).json({ success: false, message: 'Fluxo não encontrado' });
        }

        const [existing] = await db.query(
            'SELECT id FROM chatbot_flow_steps WHERE flow_id = ? AND step_key = ?',
            [req.params.id, step_key.trim()]
        );

        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Já existe uma etapa com essa chave neste fluxo' });
        }

        await db.query(
            `INSERT INTO chatbot_flow_steps (
                flow_id, step_key, title, prompt_text, field_key, validation_type, next_step,
                error_message, conditions_text, action_summary, sort_order, is_terminal
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.params.id,
                step_key.trim(),
                title.trim(),
                prompt_text || null,
                field_key || null,
                validation_type || null,
                next_step || null,
                error_message || null,
                conditions_text || null,
                action_summary || null,
                Number(sort_order) || 0,
                Boolean(is_terminal)
            ]
        );

        res.json({ success: true, message: 'Etapa criada com sucesso' });
    } catch (error) {
        console.error('Erro ao criar etapa:', error);
        res.status(500).json({ success: false, message: 'Erro ao criar etapa' });
    }
});

app.put('/api/fluxos/:flowId/steps/:stepId', isAuthenticated, isAdminOnly, async (req, res) => {
    const {
        step_key,
        title,
        prompt_text,
        field_key,
        validation_type,
        next_step,
        error_message,
        conditions_text,
        action_summary,
        sort_order,
        is_terminal
    } = req.body;

    if (typeof step_key !== 'string' || !step_key.trim()) {
        return res.status(400).json({ success: false, message: 'Informe a chave da etapa' });
    }

    if (typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ success: false, message: 'Informe o título da etapa' });
    }

    try {
        const [steps] = await db.query(
            'SELECT id FROM chatbot_flow_steps WHERE id = ? AND flow_id = ?',
            [req.params.stepId, req.params.flowId]
        );

        if (steps.length === 0) {
            return res.status(404).json({ success: false, message: 'Etapa não encontrada' });
        }

        const [existing] = await db.query(
            'SELECT id FROM chatbot_flow_steps WHERE flow_id = ? AND step_key = ? AND id <> ?',
            [req.params.flowId, step_key.trim(), req.params.stepId]
        );

        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Já existe outra etapa com essa chave neste fluxo' });
        }

        await db.query(
            `UPDATE chatbot_flow_steps
             SET step_key = ?, title = ?, prompt_text = ?, field_key = ?, validation_type = ?, next_step = ?,
                 error_message = ?, conditions_text = ?, action_summary = ?, sort_order = ?, is_terminal = ?
             WHERE id = ? AND flow_id = ?`,
            [
                step_key.trim(),
                title.trim(),
                prompt_text || null,
                field_key || null,
                validation_type || null,
                next_step || null,
                error_message || null,
                conditions_text || null,
                action_summary || null,
                Number(sort_order) || 0,
                Boolean(is_terminal),
                req.params.stepId,
                req.params.flowId
            ]
        );

        res.json({ success: true, message: 'Etapa atualizada com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar etapa:', error);
        res.status(500).json({ success: false, message: 'Erro ao atualizar etapa' });
    }
});

app.delete('/api/fluxos/:flowId/steps/:stepId', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const [steps] = await db.query(
            'SELECT id FROM chatbot_flow_steps WHERE id = ? AND flow_id = ?',
            [req.params.stepId, req.params.flowId]
        );

        if (steps.length === 0) {
            return res.status(404).json({ success: false, message: 'Etapa não encontrada' });
        }

        await db.query('DELETE FROM chatbot_flow_steps WHERE id = ? AND flow_id = ?', [req.params.stepId, req.params.flowId]);
        res.json({ success: true, message: 'Etapa excluída com sucesso' });
    } catch (error) {
        console.error('Erro ao excluir etapa:', error);
        res.status(500).json({ success: false, message: 'Erro ao excluir etapa' });
    }
});

app.post('/api/escala', isAuthenticated, isAdmin, async (req, res) => {
    const { data_escala, admin_id } = req.body;

    if (!isValidIsoDate(data_escala)) {
        return res.status(400).json({ success: false, message: 'Informe uma data válida no formato YYYY-MM-DD' });
    }

    if (!admin_id) {
        return res.status(400).json({ success: false, message: 'Selecione um técnico para a escala' });
    }

    try {
        const [usuarios] = await db.query(
            `SELECT id
             FROM admins
             WHERE id = ? AND ativo = TRUE AND telefone IS NOT NULL AND telefone <> ''`,
            [admin_id]
        );

        if (usuarios.length === 0) {
            return res.status(400).json({ success: false, message: 'O técnico selecionado precisa estar ativo e ter telefone cadastrado' });
        }

        const [existente] = await db.query(
            'SELECT id FROM escalas WHERE data_escala = ? AND admin_id = ?',
            [data_escala, admin_id]
        );
        if (existente.length > 0) {
            return res.status(400).json({ success: false, message: 'Este técnico já possui escala cadastrada para esta data' });
        }

        await db.query(
            'INSERT INTO escalas (data_escala, admin_id) VALUES (?, ?)',
            [data_escala, admin_id]
        );

        res.json({ success: true, message: 'Escala cadastrada com sucesso' });
    } catch (error) {
        console.error('Erro ao cadastrar escala:', error);
        res.status(500).json({ success: false, message: 'Erro ao cadastrar escala' });
    }
});

app.put('/api/escala/:id', isAuthenticated, isAdmin, async (req, res) => {
    const { data_escala, admin_id } = req.body;

    if (!isValidIsoDate(data_escala)) {
        return res.status(400).json({ success: false, message: 'Informe uma data válida no formato YYYY-MM-DD' });
    }

    if (!admin_id) {
        return res.status(400).json({ success: false, message: 'Selecione um técnico para a escala' });
    }

    try {
        const [registro] = await db.query('SELECT id FROM escalas WHERE id = ?', [req.params.id]);
        if (registro.length === 0) {
            return res.status(404).json({ success: false, message: 'Registro de escala não encontrado' });
        }

        const [usuarios] = await db.query(
            `SELECT id
             FROM admins
             WHERE id = ? AND ativo = TRUE AND telefone IS NOT NULL AND telefone <> ''`,
            [admin_id]
        );

        if (usuarios.length === 0) {
            return res.status(400).json({ success: false, message: 'O técnico selecionado precisa estar ativo e ter telefone cadastrado' });
        }

        const [existente] = await db.query(
            'SELECT id FROM escalas WHERE data_escala = ? AND admin_id = ? AND id <> ?',
            [data_escala, admin_id, req.params.id]
        );

        if (existente.length > 0) {
            return res.status(400).json({ success: false, message: 'Este técnico já possui escala cadastrada para esta data' });
        }

        await db.query(
            'UPDATE escalas SET data_escala = ?, admin_id = ? WHERE id = ?',
            [data_escala, admin_id, req.params.id]
        );

        res.json({ success: true, message: 'Escala atualizada com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar escala:', error);
        res.status(500).json({ success: false, message: 'Erro ao atualizar escala' });
    }
});

app.delete('/api/escala/:id', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [registro] = await db.query('SELECT id FROM escalas WHERE id = ?', [req.params.id]);
        if (registro.length === 0) {
            return res.status(404).json({ success: false, message: 'Registro de escala não encontrado' });
        }

        await db.query('DELETE FROM escalas WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Escala removida com sucesso' });
    } catch (error) {
        console.error('Erro ao excluir escala:', error);
        res.status(500).json({ success: false, message: 'Erro ao excluir escala' });
    }
});

app.get('/usuarios', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const filtro = buildAdminUnidadeWhere(req, 'a');

        const [usuarios] = await db.query(`
            SELECT a.id, a.username, a.nome_completo, a.cpf, a.telefone, a.nivel_acesso, a.ativo, a.created_at,
                   GROUP_CONCAT(u.nome ORDER BY u.nome SEPARATOR ', ') AS unidades_nomes,
                   GROUP_CONCAT(u.id) AS unidades_ids
            FROM admins a
            LEFT JOIN admin_unidades au ON au.admin_id = a.id
            LEFT JOIN unidades u ON u.id = au.unidade_id
            WHERE 1=1 ${filtro.sql}
            GROUP BY a.id
            ORDER BY a.created_at DESC
        `, filtro.params);

        // Listar só unidades às quais o usuário tem acesso (admin = todas)
        let unidades;
        if (Array.isArray(req.session.unidadeIds) && req.session.unidadeIds.length > 0) {
            const ph = req.session.unidadeIds.map(() => '?').join(',');
            [unidades] = await db.query(`SELECT id, nome, codigo FROM unidades WHERE ativo = TRUE AND id IN (${ph}) ORDER BY nome`, req.session.unidadeIds);
        } else if (Array.isArray(req.session.unidadeIds) && req.session.unidadeIds.length === 0) {
            unidades = [];
        } else {
            [unidades] = await db.query(`SELECT id, nome, codigo FROM unidades WHERE ativo = TRUE ORDER BY nome`);
        }

        const stats = {
            total: usuarios.length,
            administradores: usuarios.filter(u => u.nivel_acesso === 'administrador').length,
            gerenciadores: usuarios.filter(u => u.nivel_acesso === 'gerenciador').length,
            gestores: usuarios.filter(u => u.nivel_acesso === 'gestor').length,
            ativos: usuarios.filter(u => u.ativo).length
        };

        res.render('usuarios', { 
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador',
            usuarios,
            unidades,
            stats
        });
    } catch (error) {
        console.error('Erro ao carregar usuários:', error);
        res.render('usuarios', { 
            username: req.session.username,
            nivelAcesso: req.session.nivelAcesso || 'administrador',
            usuarios: [],
            unidades: [],
            stats: { total: 0, administradores: 0, gerenciadores: 0, gestores: 0, ativos: 0 }
        });
    }
});

// API - Listar gestores disponíveis para encaminhar (apenas quem está no turno ATUAL)
app.get('/api/usuarios/gestores', isAuthenticated, async (req, res) => {
    try {
        if (req.session.nivelAcesso === 'visualizador') {
            return res.status(403).json({ success: false, message: 'Sem permissão.' });
        }

        const agora = new Date();
        const diaSemana = agora.getDay();
        const horaAtual = agora.toTimeString().slice(0, 5);

        // Filtro por unidade
        const ids = req.session.unidadeIds;
        let unidWhere = '';
        const unidParams = [];
        if (Array.isArray(ids)) {
            if (ids.length === 0) {
                unidWhere = ' AND a.id = ?';
                unidParams.push(req.session.userId);
            } else {
                const ph = ids.map(() => '?').join(',');
                unidWhere = ` AND a.id IN (SELECT au.admin_id FROM admin_unidades au WHERE au.unidade_id IN (${ph}))`;
                unidParams.push(...ids);
            }
        }

        const [gestores] = await db.query(`
            SELECT DISTINCT a.id, a.username, a.nome_completo, a.telefone
            FROM admins a
            INNER JOIN user_turnos t ON t.admin_id = a.id
            WHERE a.nivel_acesso IN ('administrador', 'gerenciador', 'gestor')
              AND a.ativo = TRUE
              AND a.id != ?
              AND t.ativo = TRUE
              AND t.dia_semana = ?
              AND t.hora_inicio <= ?
              AND t.hora_fim >= ?
              ${unidWhere}
            ORDER BY a.nome_completo
        `, [req.session.userId, diaSemana, horaAtual, horaAtual, ...unidParams]);

        res.json({ success: true, gestores });
    } catch (error) {
        console.error('Erro ao buscar gestores:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar gestores' });
    }
});

// API - Listar atendentes disponíveis para transferência (próximo turno)
app.get('/api/usuarios/atendentes', isAuthenticated, async (req, res) => {
    try {
        const agora = dayjs();
        const diaSemana = agora.day();
        const horaAtual = agora.format('HH:mm:ss');

        // Filtro por unidade
        const ids = req.session.unidadeIds;
        let unidWhere = '';
        const unidParams = [];
        if (Array.isArray(ids)) {
            if (ids.length === 0) {
                unidWhere = ' AND a.id = ?';
                unidParams.push(req.session.userId);
            } else {
                const ph = ids.map(() => '?').join(',');
                unidWhere = ` AND a.id IN (SELECT au.admin_id FROM admin_unidades au WHERE au.unidade_id IN (${ph}))`;
                unidParams.push(...ids);
            }
        }

        // Determinar o próximo turno: turnos que começam DEPOIS do horário atual (hoje)
        // ou se não houver mais turno hoje, o primeiro turno do dia seguinte
        const proximoDia = (diaSemana + 1) % 7;

        // Buscar técnicos que têm turno INICIANDO DEPOIS do horário atual (hoje)
        // OU que tenham turno no dia seguinte (se não houver mais turnos hoje)
        const [atendentesHoje] = await db.query(`
            SELECT DISTINCT a.id, a.username, a.nome_completo, a.telefone, a.nivel_acesso,
                   MIN(t.hora_inicio) AS proximo_inicio, t.hora_fim AS proximo_fim
            FROM admins a
            INNER JOIN user_turnos t ON t.admin_id = a.id AND t.ativo = TRUE
            WHERE a.ativo = TRUE
              AND a.nivel_acesso IN ('administrador', 'gerenciador', 'gestor')
              AND a.id != ?
              AND t.dia_semana = ?
              AND t.hora_inicio > ?
              ${unidWhere}
            GROUP BY a.id
            ORDER BY proximo_inicio, a.nome_completo
        `, [req.session.userId, diaSemana, horaAtual, ...unidParams]);

        let atendentes = atendentesHoje;
        let labelTurno = 'próximo turno (hoje)';

        // Se ninguém tem turno posterior hoje, buscar primeiro turno do dia seguinte
        if (atendentes.length === 0) {
            const [atendenteAmanha] = await db.query(`
                SELECT DISTINCT a.id, a.username, a.nome_completo, a.telefone, a.nivel_acesso,
                       MIN(t.hora_inicio) AS proximo_inicio, t.hora_fim AS proximo_fim
                FROM admins a
                INNER JOIN user_turnos t ON t.admin_id = a.id AND t.ativo = TRUE
                WHERE a.ativo = TRUE
                  AND a.nivel_acesso IN ('administrador', 'gerenciador', 'gestor')
                  AND a.id != ?
                  AND t.dia_semana = ?
                  ${unidWhere}
                GROUP BY a.id
                ORDER BY proximo_inicio, a.nome_completo
            `, [req.session.userId, proximoDia, ...unidParams]);
            atendentes = atendenteAmanha;
            const dias = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
            labelTurno = `primeiro turno de amanhã (${dias[proximoDia]})`;
        }

        // Buscar os turnos de cada atendente (só do dia relevante) para mostrar horário
        for (const atendente of atendentes) {
            const diaRelevante = atendentes === atendentesHoje ? diaSemana : proximoDia;
            const [turnos] = await db.query(`
                SELECT dia_semana, hora_inicio, hora_fim
                FROM user_turnos
                WHERE admin_id = ? AND ativo = TRUE AND dia_semana = ?
                ORDER BY hora_inicio
            `, [atendente.id, diaRelevante]);
            atendente.turnos = turnos;
        }

        res.json({ success: true, atendentes, labelTurno });
    } catch (error) {
        console.error('Erro ao buscar atendentes:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar atendentes' });
    }
});

// API - Listar usuário específico
app.get('/api/usuarios/:id', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [usuarios] = await db.query(
            'SELECT id, username, nome_completo, cpf, telefone, nivel_acesso, ativo FROM admins WHERE id = ?',
            [req.params.id]
        );

        if (usuarios.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
        }

        const [unids] = await db.query('SELECT unidade_id FROM admin_unidades WHERE admin_id = ?', [req.params.id]);
        usuarios[0].unidade_ids = unids.map(u => u.unidade_id);

        res.json({ success: true, usuario: usuarios[0] });
    } catch (error) {
        console.error('Erro ao buscar usuário:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar usuário' });
    }
});

// API - Criar usuário
app.post('/api/usuarios', isAuthenticated, isAdmin, async (req, res) => {
    const { nome_completo, username, cpf, telefone, nivel_acesso, password, ativo, unidade_ids } = req.body;

    // Gerenciador não pode criar administrador
    if (req.session.nivelAcesso === 'gerenciador' && nivel_acesso === 'administrador') {
        return res.status(403).json({ success: false, message: 'Você não tem permissão para criar administradores.' });
    }

    // Gerenciador só pode atribuir unidades que ele mesmo tem
    if (req.session.nivelAcesso !== 'administrador' && Array.isArray(unidade_ids)) {
        const minhasUnidades = new Set((req.session.unidadeIds || []).map(Number));
        const invalidas = unidade_ids.map(Number).filter(uid => !minhasUnidades.has(uid));
        if (invalidas.length > 0) {
            return res.status(403).json({ success: false, message: 'Você só pode atribuir unidades às quais está vinculado.' });
        }
    }

    try {
        // Verificar se o usuário já existe
        const [existing] = await db.query('SELECT id FROM admins WHERE username = ? OR cpf = ?', [username, cpf]);
        
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Usuário ou CPF já cadastrado' });
        }

        // Criptografar senha
        const hashedPassword = await bcrypt.hash(password, 10);

        const [result] = await db.query(
            `INSERT INTO admins (username, nome_completo, cpf, telefone, nivel_acesso, password, ativo)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [username, String(nome_completo || '').toUpperCase(), cpf, telefone, nivel_acesso, hashedPassword, ativo]
        );

        // Vincular unidades
        if (Array.isArray(unidade_ids) && unidade_ids.length > 0) {
            const values = unidade_ids.map(uid => [result.insertId, Number(uid)]);
            await db.query('INSERT INTO admin_unidades (admin_id, unidade_id) VALUES ?', [values]);
        }

        res.json({ success: true, message: 'Usuário criado com sucesso', userId: result.insertId });
    } catch (error) {
        console.error('Erro ao criar usuário:', error);
        res.status(500).json({ success: false, message: 'Erro ao criar usuário' });
    }
});

// API - Atualizar usuário
app.put('/api/usuarios/:id', isAuthenticated, isAdmin, async (req, res) => {
    const { nome_completo, username, cpf, telefone, nivel_acesso, password, ativo, unidade_ids } = req.body;
    const userId = req.params.id;

    // Gerenciador não pode promover a administrador
    if (req.session.nivelAcesso === 'gerenciador' && nivel_acesso === 'administrador') {
        return res.status(403).json({ success: false, message: 'Você não tem permissão para definir nível administrador.' });
    }

    // Gerenciador só pode atribuir unidades que ele mesmo tem
    if (req.session.nivelAcesso !== 'administrador' && Array.isArray(unidade_ids)) {
        const minhasUnidades = new Set((req.session.unidadeIds || []).map(Number));
        const invalidas = unidade_ids.map(Number).filter(uid => !minhasUnidades.has(uid));
        if (invalidas.length > 0) {
            return res.status(403).json({ success: false, message: 'Você só pode atribuir unidades às quais está vinculado.' });
        }
    }

    try {
        // Verificar se outro usuário já usa o username ou CPF
        const [existing] = await db.query(
            'SELECT id FROM admins WHERE (username = ? OR cpf = ?) AND id != ?',
            [username, cpf, userId]
        );
        
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'Usuário ou CPF já cadastrado por outro usuário' });
        }

        // Se a senha foi fornecida, atualizar com ela
        const nomeUpper = String(nome_completo || '').toUpperCase();
        if (password && password.trim() !== '') {
            const hashedPassword = await bcrypt.hash(password, 10);
            await db.query(
                `UPDATE admins 
                 SET username = ?, nome_completo = ?, cpf = ?, telefone = ?, nivel_acesso = ?, password = ?, ativo = ?
                 WHERE id = ?`,
                [username, nomeUpper, cpf, telefone, nivel_acesso, hashedPassword, ativo, userId]
            );
        } else {
            // Atualizar sem modificar a senha
            await db.query(
                `UPDATE admins 
                 SET username = ?, nome_completo = ?, cpf = ?, telefone = ?, nivel_acesso = ?, ativo = ?
                 WHERE id = ?`,
                [username, nomeUpper, cpf, telefone, nivel_acesso, ativo, userId]
            );
        }

        // Sincronizar unidades vinculadas
        if (Array.isArray(unidade_ids)) {
            if (req.session.nivelAcesso === 'administrador') {
                // Admin pode resetar tudo livremente
                await db.query('DELETE FROM admin_unidades WHERE admin_id = ?', [userId]);
                if (unidade_ids.length > 0) {
                    const values = unidade_ids.map(uid => [Number(userId), Number(uid)]);
                    await db.query('INSERT INTO admin_unidades (admin_id, unidade_id) VALUES ?', [values]);
                }
            } else {
                // Gerenciador: só mexe nas unidades que ele tem
                const minhas = (req.session.unidadeIds || []).map(Number);
                if (minhas.length > 0) {
                    const ph = minhas.map(() => '?').join(',');
                    await db.query(
                        `DELETE FROM admin_unidades WHERE admin_id = ? AND unidade_id IN (${ph})`,
                        [userId, ...minhas]
                    );
                }
                if (unidade_ids.length > 0) {
                    const values = unidade_ids.map(uid => [Number(userId), Number(uid)]);
                    await db.query('INSERT IGNORE INTO admin_unidades (admin_id, unidade_id) VALUES ?', [values]);
                }
            }
        }

        res.json({ success: true, message: 'Usuário atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar usuário:', error);
        res.status(500).json({ success: false, message: 'Erro ao atualizar usuário' });
    }
});

app.post('/api/usuarios/:id/reset-password', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        const [usuarios] = await db.query('SELECT id, username FROM admins WHERE id = ?', [userId]);

        if (usuarios.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
        }

        const senhaTemporaria = `${Math.random().toString(36).slice(-8)}A1`;
        const hashedPassword = await bcrypt.hash(senhaTemporaria, 10);

        await db.query('UPDATE admins SET password = ? WHERE id = ?', [hashedPassword, userId]);

        res.json({
            success: true,
            message: `Senha redefinida para ${usuarios[0].username}`,
            temporaryPassword: senhaTemporaria
        });
    } catch (error) {
        console.error('Erro ao resetar senha do usuário:', error);
        res.status(500).json({ success: false, message: 'Erro ao resetar senha do usuário' });
    }
});

// API - Toggle status do usuário
app.patch('/api/usuarios/:id/toggle', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [usuario] = await db.query('SELECT ativo FROM admins WHERE id = ?', [req.params.id]);
        
        if (usuario.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
        }

        const novoStatus = !usuario[0].ativo;
        await db.query('UPDATE admins SET ativo = ? WHERE id = ?', [novoStatus, req.params.id]);

        res.json({ 
            success: true, 
            message: `Usuário ${novoStatus ? 'ativado' : 'desativado'} com sucesso` 
        });
    } catch (error) {
        console.error('Erro ao alterar status:', error);
        res.status(500).json({ success: false, message: 'Erro ao alterar status do usuário' });
    }
});

// API - Turnos de trabalho
app.get('/api/usuarios/:id/turnos', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [turnos] = await db.query(
            'SELECT * FROM user_turnos WHERE admin_id = ? ORDER BY dia_semana',
            [req.params.id]
        );
        res.json({ success: true, turnos });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro ao buscar turnos' });
    }
});

app.post('/api/usuarios/:id/turnos', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const adminId = req.params.id;
        const { turnos } = req.body; // array de { dia_semana, hora_inicio, hora_fim, ativo }

        if (!Array.isArray(turnos)) {
            return res.status(400).json({ success: false, message: 'Formato inválido' });
        }

        // Remover turnos antigos e inserir novos
        await db.query('DELETE FROM user_turnos WHERE admin_id = ?', [adminId]);

        for (const turno of turnos) {
            if (turno.ativo) {
                await db.query(
                    'INSERT INTO user_turnos (admin_id, dia_semana, hora_inicio, hora_fim, ativo) VALUES (?, ?, ?, ?, TRUE)',
                    [adminId, turno.dia_semana, turno.hora_inicio || '07:00', turno.hora_fim || '19:00']
                );
            }
        }

        res.json({ success: true, message: 'Turnos salvos com sucesso' });
    } catch (error) {
        console.error('Erro ao salvar turnos:', error);
        res.status(500).json({ success: false, message: 'Erro ao salvar turnos' });
    }
});

// Página de turnos
app.get('/turnos', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const filtro = buildAdminUnidadeWhere(req, 'a');

        const [usuarios] = await db.query(`
            SELECT a.id, a.username, a.nome_completo, a.telefone, a.nivel_acesso, a.ativo
            FROM admins a
            WHERE a.ativo = TRUE AND a.telefone IS NOT NULL AND a.telefone <> '' AND a.nivel_acesso = 'gestor'
              ${filtro.sql}
            ORDER BY a.nome_completo
        `, filtro.params);

        const filtroTurnos = buildAdminUnidadeWhere(req, 'a');
        const [todosTurnos] = await db.query(`
            SELECT t.*, COALESCE(NULLIF(a.nome_completo,''), a.username) as nome_usuario
            FROM user_turnos t
            JOIN admins a ON a.id = t.admin_id
            WHERE t.ativo = TRUE ${filtroTurnos.sql}
            ORDER BY t.admin_id, t.dia_semana
        `, filtroTurnos.params);

        // Agrupar turnos por usuário
        const turnosPorUsuario = {};
        todosTurnos.forEach(t => {
            if (!turnosPorUsuario[t.admin_id]) turnosPorUsuario[t.admin_id] = [];
            turnosPorUsuario[t.admin_id].push(t);
        });

        // Buscar unidades vinculadas de cada usuário
        const userIds = usuarios.map(u => u.id);
        const unidadesPorUsuario = {};
        if (userIds.length > 0) {
            const [vincs] = await db.query(`
                SELECT au.admin_id, u.id, u.nome, u.codigo
                FROM admin_unidades au
                JOIN unidades u ON u.id = au.unidade_id
                WHERE au.admin_id IN (?) AND u.ativo = TRUE
                ORDER BY u.nome
            `, [userIds]);

            vincs.forEach(v => {
                if (!unidadesPorUsuario[v.admin_id]) unidadesPorUsuario[v.admin_id] = [];
                unidadesPorUsuario[v.admin_id].push({ id: v.id, nome: v.nome, codigo: v.codigo });
            });
        }

        // Buscar todos os presets de turnos por unidade
        const [presetsRows] = await db.query(`
            SELECT id, unidade_id, chave, label, icone, hora_inicio, hora_fim, ordem
            FROM unidade_turnos_presets
            WHERE ativo = TRUE
            ORDER BY unidade_id, ordem ASC, chave ASC
        `);

        const presetsPorUnidade = {};
        presetsRows.forEach(p => {
            if (!presetsPorUnidade[p.unidade_id]) presetsPorUnidade[p.unidade_id] = [];
            presetsPorUnidade[p.unidade_id].push({
                chave: p.chave,
                label: p.label,
                icone: p.icone,
                hora_inicio: String(p.hora_inicio).slice(0, 5),
                hora_fim: String(p.hora_fim).slice(0, 5)
            });
        });

        res.render('turnos', {
            username: req.session.username,
            usuarios,
            turnosPorUsuario,
            unidadesPorUsuario,
            presetsPorUnidade
        });
    } catch (error) {
        console.error('Erro ao carregar turnos:', error);
        res.render('turnos', {
            username: req.session.username,
            usuarios: [],
            turnosPorUsuario: {},
            unidadesPorUsuario: {},
            presetsPorUnidade: {}
        });
    }
});

// API - Listar presets de turnos por unidade
app.get('/api/unidades/:id/turno-presets', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [presets] = await db.query(`
            SELECT id, chave, label, icone, hora_inicio, hora_fim, ordem, ativo
            FROM unidade_turnos_presets
            WHERE unidade_id = ?
            ORDER BY ordem ASC, chave ASC
        `, [req.params.id]);

        res.json({
            success: true,
            presets: presets.map(p => ({
                ...p,
                hora_inicio: String(p.hora_inicio).slice(0, 5),
                hora_fim: String(p.hora_fim).slice(0, 5)
            }))
        });
    } catch (error) {
        console.error('Erro ao listar presets:', error);
        res.status(500).json({ success: false, message: 'Erro ao listar presets' });
    }
});

// API - Salvar/atualizar presets de uma unidade (admin only)
app.post('/api/unidades/:id/turno-presets', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const unidadeId = Number(req.params.id);
        const { presets } = req.body;

        if (!Array.isArray(presets)) {
            return res.status(400).json({ success: false, message: 'Lista de presets inválida' });
        }

        // Apagar todos e inserir novos
        await db.query('DELETE FROM unidade_turnos_presets WHERE unidade_id = ?', [unidadeId]);

        for (let i = 0; i < presets.length; i++) {
            const p = presets[i];
            if (!p.chave || !p.label || !p.hora_inicio || !p.hora_fim) continue;
            await db.query(
                `INSERT INTO unidade_turnos_presets
                 (unidade_id, chave, label, icone, hora_inicio, hora_fim, ordem, ativo)
                 VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
                [unidadeId, p.chave, p.label, p.icone || '🕐', p.hora_inicio, p.hora_fim, i + 1]
            );
        }

        res.json({ success: true, message: 'Presets atualizados' });
    } catch (error) {
        console.error('Erro ao salvar presets:', error);
        res.status(500).json({ success: false, message: 'Erro ao salvar presets' });
    }
});

// API - Excluir usuário
app.delete('/api/usuarios/:id', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [usuario] = await db.query('SELECT username FROM admins WHERE id = ?', [req.params.id]);
        
        if (usuario.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
        }

        // Não permitir excluir o admin padrão
        if (usuario[0].username === 'admin') {
            return res.status(403).json({ success: false, message: 'Não é possível excluir o usuário admin padrão' });
        }

        await db.query('DELETE FROM admins WHERE id = ?', [req.params.id]);

        res.json({ success: true, message: 'Usuário excluído com sucesso' });
    } catch (error) {
        console.error('Erro ao excluir usuário:', error);
        res.status(500).json({ success: false, message: 'Erro ao excluir usuário' });
    }
});

// API - Encaminhar chamado para técnico no mesmo turno (DEVE VIR ANTES DE :id/atender)
app.post('/api/chamados/:id/encaminhar', isAuthenticated, async (req, res) => {
    try {
        if (req.session.nivelAcesso === 'visualizador') {
            return res.status(403).json({ success: false, message: 'Sem permissão para encaminhar chamados.' });
        }

        const chamadoId = req.params.id;
        const { gestorId } = req.body;

        // Buscar dados do técnico destino
        const [gestor] = await db.query(
            'SELECT id, nome_completo, telefone FROM admins WHERE id = ? AND nivel_acesso IN ("administrador", "gerenciador", "gestor") AND ativo = TRUE',
            [gestorId]
        );

        if (gestor.length === 0) {
            return res.status(404).json({ success: false, message: 'Gestor não encontrado' });
        }

        // Buscar dados do chamado
        const [chamado] = await db.query('SELECT * FROM chamados WHERE id = ?', [chamadoId]);

        if (chamado.length === 0) {
            return res.status(404).json({ success: false, message: 'Chamado não encontrado' });
        }

        // Atualizar chamado
        await db.query(
            `UPDATE chamados 
             SET status = 'em_atendimento',
                 atendente_id = ?,
                 atendente_nome = ?,
                 iniciado_em = NOW()
             WHERE id = ?`,
            [gestor[0].id, gestor[0].nome_completo, chamadoId]
        );

        encerrarFluxoBotDoChamado(chamado[0]);

        // Enviar WhatsApp para o gestor (usar cliente da instância do chamado)
        const wppGes = await obterClienteWhatsAppParaChamado(chamado[0]);
        if (wppGes.isConnected && wppGes.client && gestor[0].telefone) {
            try {
                const mensagemGestor = `🔔 *NOVO CHAMADO ATRIBUÍDO*\n\n` +
                    `📌 *Protocolo:* ${chamado[0].protocolo}\n` +
                    `👤 *Solicitante:* ${chamado[0].solicitante_nome}\n` +
                    `🏢 *Setor:* ${chamado[0].setor}\n` +
                    `📂 *Categoria:* ${chamado[0].categoria}\n` +
                    `📝 *Descrição:* ${chamado[0].descricao}\n` +
                    `📱 *Contato:* ${chamado[0].telefone_contato}\n\n` +
                    `Este chamado foi encaminhado para você. Por favor, entre em contato com o solicitante.`;

                // Normalizar número do gestor
                let numeroGestor = gestor[0].telefone.replace(/\D/g, '');
                if (!numeroGestor.startsWith('55')) {
                    numeroGestor = '55' + numeroGestor;
                }

                console.log('Tentando enviar para gestor:', numeroGestor);

                // Gerar variações do número (com e sem 9º dígito)
                const variacoes = [numeroGestor];
                if (numeroGestor.length === 13) {
                    variacoes.push(numeroGestor.slice(0, 4) + numeroGestor.slice(5));
                }
                if (numeroGestor.length === 12) {
                    variacoes.push(numeroGestor.slice(0, 4) + '9' + numeroGestor.slice(4));
                }

                let enviado = false;
                for (const numero of variacoes) {
                    try {
                        const numberId = await wppGes.client.getNumberId(numero);
                        if (numberId && numberId._serialized) {
                            console.log('ID do gestor encontrado:', numberId._serialized);
                            await wppGes.client.sendMessage(numberId._serialized, mensagemGestor);
                            console.log('Mensagem enviada com sucesso para o gestor');
                            enviado = true;
                            break;
                        }
                    } catch (err) {
                        console.log(`Tentativa com ${numero} falhou, tentando próxima variação...`);
                    }
                }

                if (!enviado) {
                    console.error('Número do gestor não encontrado no WhatsApp após todas as tentativas');
                }
            } catch (error) {
                console.error('Erro ao enviar WhatsApp para gestor:', error.message);
            }
        }

        // Enviar WhatsApp para o solicitante
        const wppEnc = await obterClienteWhatsAppParaChamado(chamado[0]);
        if (wppEnc.isConnected && wppEnc.client && chamado[0].chat_origem) {
            try {
                const mensagemSolicitante = `🔔 *ATUALIZAÇÃO DO CHAMADO*\n\n` +
                    `📌 *Protocolo:* ${chamado[0].protocolo}\n` +
                    `👤 *Atendente:* ${gestor[0].nome_completo}\n` +
                    `📊 *Status:* Em Atendimento\n\n` +
                    `Seu chamado foi encaminhado e está sendo atendido.`;

                await entregarMensagem(wppEnc.client, chamado[0].chat_origem, mensagemSolicitante);
            } catch (error) {
                console.error('Erro ao enviar WhatsApp para solicitante:', error);
            }
        }

        res.json({ 
            success: true, 
            message: `Chamado encaminhado para ${gestor[0].nome_completo} com sucesso` 
        });
    } catch (error) {
        console.error('Erro ao encaminhar chamado:', error);
        res.status(500).json({ success: false, message: 'Erro ao encaminhar chamado' });
    }
});

// API - Transferir chamado para outro atendente (com observação obrigatória)
app.post('/api/chamados/:id/transferir', isAuthenticated, async (req, res) => {
    let chaveTransferencia = null;
    try {
        if (req.session.nivelAcesso === 'visualizador') {
            return res.status(403).json({ success: false, message: 'Sem permissão para transferir chamados.' });
        }

        const chamadoId = req.params.id;
        const { novoAtendenteId, observacao } = req.body;
        const observacaoLimpa = String(observacao || '').trim();

        if (!novoAtendenteId) {
            return res.status(400).json({ success: false, message: 'Selecione o atendente destino' });
        }

        if (!observacaoLimpa || observacaoLimpa.length < 5) {
            return res.status(400).json({ success: false, message: 'A observação é obrigatória (mínimo 5 caracteres). Informe o status do caso e motivo da transferência.' });
        }

        limparTransferenciasExpiradas();
        chaveTransferencia = criarChaveTransferencia(chamadoId, req.session.userId, novoAtendenteId, observacaoLimpa);
        if (transferenciasEmAndamento.has(chaveTransferencia)) {
            return res.status(429).json({ success: false, message: 'Transferência já está sendo processada. Aguarde alguns segundos.' });
        }
        transferenciasEmAndamento.set(chaveTransferencia, Date.now() + 15000);

        const [chamado] = await db.query('SELECT * FROM chamados WHERE id = ?', [chamadoId]);
        if (chamado.length === 0) {
            return res.status(404).json({ success: false, message: 'Chamado não encontrado' });
        }

        const [novoAtendente] = await db.query(
            'SELECT id, nome_completo, username, telefone FROM admins WHERE id = ? AND ativo = TRUE',
            [novoAtendenteId]
        );
        if (novoAtendente.length === 0) {
            return res.status(404).json({ success: false, message: 'Atendente destino não encontrado' });
        }

        const nomeAnterior = req.session.nomeCompleto || req.session.username;
        const nomeNovo = novoAtendente[0].nome_completo || novoAtendente[0].username;
        const mensagemSistemaTransferencia = `📤 Chamado transferido de ${nomeAnterior} para ${nomeNovo}.\nMotivo: ${observacaoLimpa}`;

        const [duplicadaRecente] = await db.query(
            `SELECT id FROM chat_messages
             WHERE chamado_id = ?
               AND remetente_tipo = 'sistema'
               AND mensagem = ?
               AND enviada_em >= DATE_SUB(NOW(), INTERVAL 30 SECOND)
             LIMIT 1`,
            [chamadoId, mensagemSistemaTransferencia]
        );

        if (duplicadaRecente.length > 0) {
            return res.json({ success: true, message: `Chamado transferido para ${nomeNovo}` });
        }

        // Atualizar chamado
        await db.query(
            `UPDATE chamados 
             SET atendente_id = ?,
                 atendente_nome = ?,
                 observacoes = CONCAT(COALESCE(observacoes, ''), ?)
             WHERE id = ?`,
            [novoAtendente[0].id, nomeNovo, `\n[Transferido de ${nomeAnterior} para ${nomeNovo} em ${new Date().toLocaleString('pt-BR')}]\nMotivo: ${observacaoLimpa}\n`, chamadoId]
        );

        // Registrar no chat do chamado
        await db.query(
            `INSERT INTO chat_messages (chamado_id, remetente_tipo, remetente_nome, mensagem)
             VALUES (?, 'sistema', 'Sistema', ?)`,
            [chamadoId, mensagemSistemaTransferencia]
        );

        // Notificar novo atendente via WhatsApp (usar cliente correto da instância do chamado)
        const wppTr = await obterClienteWhatsAppParaChamado(chamado[0]);
        if (wppTr.isConnected && wppTr.client && novoAtendente[0].telefone) {
            try {
                const destino = await resolveWhatsAppDestinationWith(wppTr.client, wppTr.isConnected, novoAtendente[0].telefone);
                if (destino) {
                    await wppTr.client.sendMessage(destino,
                        `📤 *CHAMADO TRANSFERIDO PARA VOCÊ*\n\n` +
                        `📌 *Protocolo:* ${chamado[0].protocolo}\n` +
                        `👤 *Solicitante:* ${chamado[0].solicitante_nome}\n` +
                        `🏢 *Setor:* ${chamado[0].setor}\n` +
                        `📂 *Categoria:* ${chamado[0].categoria}\n` +
                        `📝 *Obs:* ${observacaoLimpa}\n\n` +
                        `Transferido por: ${nomeAnterior}\n` +
                        `🔗 https://hgpto.shop/chamados`
                    );
                }
            } catch (error) {
                console.error('Erro ao notificar novo atendente:', error.message);
            }
        }

        res.json({ success: true, message: `Chamado transferido para ${nomeNovo}` });
    } catch (error) {
        console.error('Erro ao transferir chamado:', error);
        res.status(500).json({ success: false, message: 'Erro ao transferir chamado' });
    } finally {
        if (chaveTransferencia) {
            setTimeout(() => transferenciasEmAndamento.delete(chaveTransferencia), 15000);
        }
    }
});

// API - Iniciar atendimento de chamado
app.post('/api/chamados/:id/atender', isAuthenticated, async (req, res) => {
    try {
        // Bloquear usuários com nível "visualizador"
        if (req.session.nivelAcesso === 'visualizador') {
            return res.status(403).json({ success: false, message: 'Seu perfil não tem permissão para atender chamados. Apenas visualização.' });
        }

        const chamadoId = req.params.id;
        const atendenteId = req.session.userId;
        const atendenteNome = req.session.nomeCompleto || req.session.username;

        // Verificar se o chamado existe e não está sendo atendido
        const [chamado] = await db.query(
            'SELECT * FROM chamados WHERE id = ?',
            [chamadoId]
        );

        if (chamado.length === 0) {
            return res.status(404).json({ success: false, message: 'Chamado não encontrado' });
        }

        if (chamado[0].status === 'em_atendimento' && chamado[0].atendente_id !== atendenteId) {
            return res.status(400).json({ 
                success: false, 
                message: `Este chamado já está sendo atendido por ${chamado[0].atendente_nome}` 
            });
        }

        // Atualizar chamado para em atendimento
        await db.query(
            `UPDATE chamados 
             SET status = 'em_atendimento', 
                 atendente_id = ?, 
                 atendente_nome = ?,
                 iniciado_em = NOW()
             WHERE id = ?`,
            [atendenteId, atendenteNome, chamadoId]
        );

        // Responder ao front IMEDIATAMENTE; o WhatsApp vai em segundo plano.
        res.json({ success: true, message: 'Atendimento iniciado com sucesso' });

        encerrarFluxoBotDoChamado(chamado[0]);

        // Enviar mensagem pelo WhatsApp (fire-and-forget)
        (async () => {
            try {
                const wppAt = await obterClienteWhatsAppParaChamado(chamado[0]);
                if (wppAt.isConnected && wppAt.client && chamado[0].chat_origem) {
                    const mensagem = `🔔 *ATUALIZAÇÃO DO CHAMADO*\n\n` +
                        `📌 *Protocolo:* ${chamado[0].protocolo}\n` +
                        `👤 *Atendente:* ${atendenteNome}\n` +
                        `📊 *Status:* Em Atendimento\n\n` +
                        `Seu chamado está sendo atendido. Em breve entraremos em contato.`;
                    await entregarMensagem(wppAt.client, chamado[0].chat_origem, mensagem);
                }
            } catch (error) {
                console.error('Erro ao enviar mensagem WhatsApp (atender):', error.message);
            }
        })();
    } catch (error) {
        console.error('Erro ao iniciar atendimento:', error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Erro ao iniciar atendimento' });
        }
    }
});

// API - Encerrar chamado
app.post('/api/chamados/:id/encerrar', isAuthenticated, async (req, res) => {
    try {
        if (req.session.nivelAcesso === 'visualizador') {
            return res.status(403).json({ success: false, message: 'Seu perfil não tem permissão para encerrar chamados.' });
        }

        const chamadoId = req.params.id;
        const { observacoes } = req.body;

        // Verificar se o chamado existe
        const [chamado] = await db.query(
            'SELECT * FROM chamados WHERE id = ?',
            [chamadoId]
        );

        if (chamado.length === 0) {
            return res.status(404).json({ success: false, message: 'Chamado não encontrado' });
        }

        // Atualizar chamado para finalizado
        await db.query(
            `UPDATE chamados 
             SET status = 'finalizado', 
                 encerrado_em = NOW(),
                 observacoes = ?
             WHERE id = ?`,
            [observacoes || null, chamadoId]
        );

        const mensagemEncerramento = `✅ Chamado encerrado.\n📌 Protocolo: ${chamado[0].protocolo}`;

        // Responder ao front IMEDIATAMENTE — o envio pelo WhatsApp (com delays
        // anti-ban + mensagem de avaliação) roda em segundo plano. Assim o botão
        // não fica "travado" esperando e o atendente não clica várias vezes.
        res.json({ success: true, message: 'Chamado encerrado com sucesso' });

        // ── Envio em segundo plano (fire-and-forget) ──
        (async () => {
            try {
                const wppEnc2 = await obterClienteWhatsAppParaChamado(chamado[0]);
                if (!wppEnc2.isConnected || !wppEnc2.client) return;

                let notificacaoEnviada = false;

                // Reabertura de fluxo (avaliação): HGP usa controller legacy, instâncias novas usam o controller do instance-manager
                let controllerParaReabrir = null;
                if (wppEnc2.client === whatsappClient) {
                    controllerParaReabrir = whatsappChatbotController;
                } else if (chamado[0].instancia_id) {
                    controllerParaReabrir = instanceManager.obterController(chamado[0].instancia_id);
                }

                if (controllerParaReabrir?.reiniciarFluxoPorEncerramento) {
                    notificacaoEnviada = await controllerParaReabrir.reiniciarFluxoPorEncerramento(chamado[0].chat_origem, {
                        protocolo: chamado[0].protocolo,
                        chamadoId: chamado[0].id,
                        atendenteNome: chamado[0].atendente_nome || 'Equipe TI',
                        nomeExibicao: chamado[0].solicitante_nome || 'Prezado'
                    });
                }

                if (!notificacaoEnviada) {
                    const destinoSolicitante = await resolveWhatsAppDestinationWith(
                        wppEnc2.client,
                        wppEnc2.isConnected,
                        chamado[0].chat_origem,
                        chamado[0].telefone_whatsapp,
                        chamado[0].telefone_contato
                    );

                    if (destinoSolicitante) {
                        const okEnc = await entregarMensagem(wppEnc2.client, destinoSolicitante, mensagemEncerramento);
                        notificacaoEnviada = okEnc;
                    }
                }

                if (!notificacaoEnviada) {
                    console.error(`Nao foi possivel enviar a mensagem de encerramento do chamado ${chamado[0].protocolo}`);
                }
            } catch (error) {
                console.error('Erro ao enviar mensagem WhatsApp (encerramento):', error.message);
            }
        })();
    } catch (error) {
        console.error('Erro ao encerrar chamado:', error);
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Erro ao encerrar chamado' });
        }
    }
});

// API - Excluir chamado (somente administrador)
app.delete('/api/chamados/:id', isAuthenticated, isAdminOnly, async (req, res) => {
    try {
        const chamadoId = req.params.id;

        const [chamado] = await db.query('SELECT id, protocolo FROM chamados WHERE id = ?', [chamadoId]);
        if (chamado.length === 0) {
            return res.status(404).json({ success: false, message: 'Chamado não encontrado' });
        }

        // Excluir chamado (chat_messages tem ON DELETE CASCADE, então cai junto)
        await db.query('DELETE FROM chamados WHERE id = ?', [chamadoId]);

        console.log(`[ADMIN] Chamado ${chamado[0].protocolo} excluído por ${req.session.username}`);
        res.json({ success: true, message: `Chamado ${chamado[0].protocolo} excluído com sucesso` });
    } catch (error) {
        console.error('Erro ao excluir chamado:', error);
        res.status(500).json({ success: false, message: 'Erro ao excluir chamado: ' + error.message });
    }
});

// API - Reabrir chamado finalizado
app.post('/api/chamados/:id/reabrir', isAuthenticated, async (req, res) => {
    try {
        if (req.session.nivelAcesso === 'visualizador') {
            return res.status(403).json({ success: false, message: 'Seu perfil não tem permissão para reabrir chamados.' });
        }

        const chamadoId = req.params.id;
        const { motivo } = req.body;

        const [chamado] = await db.query('SELECT * FROM chamados WHERE id = ?', [chamadoId]);
        if (chamado.length === 0) {
            return res.status(404).json({ success: false, message: 'Chamado não encontrado' });
        }
        if (chamado[0].status !== 'finalizado') {
            return res.status(400).json({ success: false, message: 'Somente chamados finalizados podem ser reabertos' });
        }

        // Reabrir como "em_atendimento" mantendo o atendente
        await db.query(
            `UPDATE chamados 
             SET status = 'em_atendimento', 
                 encerrado_em = NULL,
                 observacoes = CONCAT(IFNULL(observacoes,''), '\n[Reaberto em ', NOW(), ' por ', ?, ': ', ?, ']')
             WHERE id = ?`,
            [req.session.username, motivo || 'Sem motivo informado', chamadoId]
        );

        // Registrar no chat como mensagem de sistema
        await db.query(
            `INSERT INTO chat_messages (chamado_id, remetente_tipo, remetente_nome, mensagem) VALUES (?, 'sistema', 'Sistema', ?)`,
            [chamadoId, `🔄 Chamado reaberto por ${req.session.username}${motivo ? ': ' + motivo : ''}`]
        );

        res.json({ success: true, message: 'Chamado reaberto com sucesso' });
    } catch (error) {
        console.error('Erro ao reabrir chamado:', error);
        res.status(500).json({ success: false, message: 'Erro ao reabrir chamado' });
    }
});

// API - Buscar mensagens do chat de um chamado
app.get('/api/chamados/:id/chat', isAuthenticated, async (req, res) => {
    try {
        const chamadoId = req.params.id;

        // Buscar mensagens do chat
        const [mensagens] = await db.query(
            `SELECT * FROM chat_messages 
             WHERE chamado_id = ? 
             ORDER BY enviada_em ASC`,
            [chamadoId]
        );

        // Marcar mensagens como lidas
        await db.query(
            `UPDATE chat_messages 
             SET lida = TRUE 
             WHERE chamado_id = ? AND remetente_tipo = 'solicitante'`,
            [chamadoId]
        );

        res.json({ success: true, mensagens });
    } catch (error) {
        console.error('Erro ao buscar mensagens:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar mensagens' });
    }
});

// API - Enviar mensagem do técnico para o solicitante
// Ao enviar mensagem/mídia: se o chamado ainda está pendente/aberto, o técnico
// que digitou assume automaticamente o atendimento (sem notificação extra no WA).
async function assumirAtendimentoAoResponder(chamado, req) {
    if (!chamado || !req?.session?.userId) return { assumiu: false, chamado };
    if (req.session.nivelAcesso === 'visualizador') return { assumiu: false, chamado };
    if (chamado.status === 'finalizado') return { assumiu: false, chamado };

    const atendenteId = req.session.userId;
    const atendenteNome = req.session.nomeCompleto || req.session.username;
    const precisaAssumir =
        chamado.status === 'pendente' ||
        chamado.status === 'aberto' ||
        (chamado.status === 'em_atendimento' && !chamado.atendente_id);

    if (!precisaAssumir) return { assumiu: false, chamado };

    // Não roubar chamado que já está com outro técnico
    if (chamado.status === 'em_atendimento' && chamado.atendente_id && Number(chamado.atendente_id) !== Number(atendenteId)) {
        return { assumiu: false, chamado };
    }

    await db.query(
        `UPDATE chamados
         SET status = 'em_atendimento',
             atendente_id = ?,
             atendente_nome = ?,
             iniciado_em = COALESCE(iniciado_em, NOW())
         WHERE id = ?`,
        [atendenteId, atendenteNome, chamado.id]
    );

    return {
        assumiu: true,
        chamado: {
            ...chamado,
            status: 'em_atendimento',
            atendente_id: atendenteId,
            atendente_nome: atendenteNome
        }
    };
}

app.post('/api/chamados/:id/chat/enviar', isAuthenticated, async (req, res) => {
    try {
        const chamadoId = req.params.id;
        const { mensagem } = req.body;
        const remetenteNome = req.session.nomeCompleto || req.session.username;

        if (!mensagem || !mensagem.trim()) {
            return res.status(400).json({ success: false, message: 'Mensagem não pode estar vazia' });
        }

        // Buscar dados do chamado
        const [chamadoRows] = await db.query('SELECT * FROM chamados WHERE id = ?', [chamadoId]);

        if (chamadoRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Chamado não encontrado' });
        }

        const { assumiu, chamado } = await assumirAtendimentoAoResponder(chamadoRows[0], req);
        encerrarFluxoBotDoChamado(chamado);

        // Salvar mensagem no banco
        await db.query(
            `INSERT INTO chat_messages (chamado_id, remetente_tipo, remetente_nome, mensagem) 
             VALUES (?, 'tecnico', ?, ?)`,
            [chamadoId, remetenteNome, mensagem.trim()]
        );

        // Enviar mensagem pelo WhatsApp (escolhendo cliente correto da instância)
        const wpp = await obterClienteWhatsAppParaChamado(chamado);
        if (wpp.isConnected && wpp.client && chamado.chat_origem) {
            try {
                // Formato de conversa: nome do técnico em negrito e a mensagem logo abaixo
                const mensagemWhatsApp = `*${remetenteNome}:*\n${mensagem.trim()}`;
                
                const okEnvio = await entregarMensagem(wpp.client, chamado.chat_origem, mensagemWhatsApp, { options: { immediate: true } });
                if (!okEnvio) {
                    return res.status(500).json({ success: false, message: 'WhatsApp não conseguiu entregar a mensagem. Aguarde a reconexão e tente de novo.' });
                }
                
                res.json({ success: true, message: 'Mensagem enviada com sucesso', assumiu });
            } catch (error) {
                console.error('Erro ao enviar mensagem WhatsApp:', error);
                res.status(500).json({ success: false, message: 'Erro ao enviar mensagem pelo WhatsApp: ' + error.message });
            }
        } else if (!chamado.chat_origem) {
            res.status(400).json({ success: false, message: 'Chamado sem chat_origem definido (não é possível enviar via WhatsApp)' });
        } else {
            res.status(400).json({ success: false, message: 'WhatsApp da instância deste chamado não está conectado. Verifique em /instancias' });
        }
    } catch (error) {
        console.error('Erro ao enviar mensagem:', error);
        res.status(500).json({ success: false, message: 'Erro ao enviar mensagem' });
    }
});

// API - Contar mensagens não lidas por chamado
app.get('/api/chamados/:id/chat/nao-lidas', isAuthenticated, async (req, res) => {
    try {
        const chamadoId = req.params.id;

        const [result] = await db.query(
            `SELECT COUNT(*) as total FROM chat_messages 
             WHERE chamado_id = ? AND remetente_tipo = 'solicitante' AND lida = FALSE`,
            [chamadoId]
        );

        res.json({ success: true, total: result[0].total });
    } catch (error) {
        console.error('Erro ao contar mensagens não lidas:', error);
        res.status(500).json({ success: false, message: 'Erro ao contar mensagens' });
    }
});

// API - Enviar mídia (imagem, vídeo, áudio) no chat
app.post('/api/chamados/:id/chat/enviar-midia', isAuthenticated, (req, res, next) => {
    uploadChatMedia.single('midia')(req, res, (err) => {
        if (err) {
            console.error('Erro multer no upload de mídia:', err);
            return res.status(400).json({ success: false, message: err.message || 'Erro ao processar arquivo' });
        }
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado' });
        }

        const chamadoId = req.params.id;
        const remetenteNome = req.session.nomeCompleto || req.session.username;
        const legenda = req.body.mensagem?.trim() || '';
        const mediaUrl = `/uploads/chat-media/${req.file.filename}`;
        const mimeType = req.file.mimetype;

        let messageType = 'document';
        if (mimeType.startsWith('image/')) messageType = 'image';
        else if (mimeType.startsWith('video/')) messageType = 'video';
        else if (mimeType.startsWith('audio/')) messageType = 'audio';

        // Comprimir imagem para economizar espaço (mantém qualidade visual)
        if (messageType === 'image') {
            try {
                const compResult = await mediaManager.comprimirImagem(req.file.path, mimeType);
                if (compResult && compResult.ratio > 0) {
                    const economia = (compResult.ratio * 100).toFixed(0);
                    console.log(`[Upload] Imagem comprimida: ${economia}% de redução (${(compResult.originalSize/1024).toFixed(0)}KB → ${(compResult.newSize/1024).toFixed(0)}KB)`);
                }
            } catch (e) {
                console.warn('[Upload] Falha ao comprimir imagem:', e.message);
            }
        }

        const [chamadoRows] = await db.query('SELECT * FROM chamados WHERE id = ?', [chamadoId]);
        if (chamadoRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Chamado não encontrado' });
        }

        const { assumiu, chamado } = await assumirAtendimentoAoResponder(chamadoRows[0], req);
        encerrarFluxoBotDoChamado(chamado);

        await db.query(
            `INSERT INTO chat_messages (chamado_id, remetente_tipo, remetente_nome, mensagem, message_type, media_url, media_mime_type, media_filename)
             VALUES (?, 'tecnico', ?, ?, ?, ?, ?, ?)`,
            [chamadoId, remetenteNome, legenda || `[${messageType}]`, messageType, mediaUrl, mimeType, req.file.originalname]
        );

        const wppMd = await obterClienteWhatsAppParaChamado(chamado);
        if (wppMd.isConnected && wppMd.client && chamado.chat_origem) {
            try {
                const filePath = path.join(__dirname, 'public', 'uploads', 'chat-media', req.file.filename);
                const fileData = await fs.readFile(filePath);
                const base64 = fileData.toString('base64');
                const media = new MessageMedia(mimeType, base64, req.file.originalname);
                const caption = legenda ? `*${remetenteNome}:*\n${legenda}` : `*${remetenteNome}*`;
                await entregarMensagem(wppMd.client, chamado.chat_origem, media, { options: { caption } });
            } catch (waError) {
                console.error('Erro ao enviar mídia pelo WhatsApp:', waError.message);
            }
        }

        res.json({ success: true, message: 'Mídia enviada com sucesso', assumiu });
    } catch (error) {
        console.error('Erro ao enviar mídia (detalhe):', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao enviar mídia',
            error: error.message,
            code: error.code,
            sqlMessage: error.sqlMessage
        });
    }
});

// API - Contar meus chamados em andamento
app.get('/api/chamados/meus-em-andamento', isAuthenticated, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT COUNT(*) AS total FROM chamados WHERE atendente_id = ? AND status = 'em_atendimento'`,
            [req.session.userId]
        );
        res.json({ success: true, total: Number(rows[0]?.total || 0) });
    } catch (error) {
        res.status(500).json({ success: false, total: 0 });
    }
});

// API - Listar meus atendimentos
app.get('/api/chamados/meus-atendimentos', isAuthenticated, async (req, res) => {
    try {
        const atendenteId = req.session.userId;

        const [chamados] = await db.query(`
            SELECT *
            FROM chamados
            WHERE atendente_id = ? AND status IN ('em_atendimento', 'finalizado')
            ORDER BY 
                CASE 
                    WHEN status = 'em_atendimento' THEN 1
                    ELSE 2
                END,
                criado_em DESC
            LIMIT 50
        `, [atendenteId]);

        res.json({ success: true, chamados });
    } catch (error) {
        console.error('Erro ao buscar atendimentos:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar atendimentos' });
    }
});

// API - Obter dados do perfil do usuário logado
app.get('/api/perfil', isAuthenticated, async (req, res) => {
    try {
        const [users] = await db.query(
            'SELECT id, username, nome_completo, telefone, nivel_acesso FROM admins WHERE id = ?',
            [req.session.userId]
        );
        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
        }
        res.json({ success: true, usuario: users[0] });
    } catch (error) {
        console.error('Erro ao buscar perfil:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar perfil' });
    }
});

// API - Atualizar perfil do usuário logado (nome, telefone, senha)
app.put('/api/perfil', isAuthenticated, async (req, res) => {
    try {
        const { nome_completo, telefone, senha_atual, nova_senha } = req.body;
        const userId = req.session.userId;

        // Se está tentando alterar a senha, validar a senha atual
        if (nova_senha) {
            if (!senha_atual) {
                return res.status(400).json({ success: false, message: 'Informe a senha atual para alterar a senha' });
            }

            const [users] = await db.query('SELECT password FROM admins WHERE id = ?', [userId]);
            if (users.length === 0) {
                return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
            }

            const senhaValida = await bcrypt.compare(senha_atual, users[0].password);
            if (!senhaValida) {
                return res.status(400).json({ success: false, message: 'Senha atual incorreta' });
            }

            if (nova_senha.length < 4) {
                return res.status(400).json({ success: false, message: 'A nova senha deve ter pelo menos 4 caracteres' });
            }

            const hashedPassword = await bcrypt.hash(nova_senha, 10);
            await db.query('UPDATE admins SET password = ? WHERE id = ?', [hashedPassword, userId]);
        }

        // Atualizar nome e telefone
        await db.query(
            'UPDATE admins SET nome_completo = ?, telefone = ? WHERE id = ?',
            [nome_completo || '', telefone || '', userId]
        );

        // Atualizar sessão
        if (nome_completo) {
            req.session.nomeCompleto = nome_completo;
        }

        res.json({ success: true, message: 'Perfil atualizado com sucesso' });
    } catch (error) {
        console.error('Erro ao atualizar perfil:', error);
        res.status(500).json({ success: false, message: 'Erro ao atualizar perfil' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
});

process.on('uncaughtException', (error) => {
    if (isIgnorableWhatsAppRuntimeError(error)) {
        logRuntimeError('Erro transitório ignorado do WhatsApp', error);
        if (whatsappState === 'connected' || whatsappState === 'connecting') {
            forcarReconexaoHgp(error.message || 'uncaughtException').catch(() => {});
        }
        return;
    }

    logRuntimeError('Exceção não capturada no servidor', error);
});

process.on('unhandledRejection', (reason) => {
    if (isIgnorableWhatsAppRuntimeError(reason)) {
        logRuntimeError('Promessa rejeitada transitória do WhatsApp', reason);
        if (whatsappState === 'connected' || whatsappState === 'connecting') {
            forcarReconexaoHgp(reason?.message || 'unhandledRejection').catch(() => {});
        }
        return;
    }

    logRuntimeError('Promessa rejeitada não tratada no servidor', reason);
});

async function startServer() {
    try {
        const schemaChanges = await ensureSchema(db);
        if (schemaChanges.length > 0) {
            console.log(`Schema sincronizado automaticamente: ${schemaChanges.join(', ')}`);
        }

        await syncDisconnectedSession();
        await instanceManager.syncOnStartup();

        // Auto-reconectar HGP (legacy) se já existe sessão salva
        try {
            if (hgpTemSessaoSalva()) {
                console.log('[HGP] Auto-reconectando WhatsApp legado...');
                iniciarWhatsAppLegacy().catch(err => {
                    console.error('[HGP] Erro auto-reconnect:', err.message);
                    agendarReconexaoHgp(err.message);
                });
            } else if (HGP_USES_BAILEYS && fsSync.existsSync(hgpWwebjsSessionPath())) {
                console.log(
                    '[HGP] Migração para Baileys pendente: clique em Conectar na tela /instancias e leia o novo QR uma única vez.'
                );
            }
        } catch (e) {
            console.error('[HGP] Erro check auto-reconnect:', e.message);
        }

        // Watchdog: detecta Chrome morto, estado zumbi e tenta religar sozinho
        setInterval(() => {
            verificarSaudeHgp().catch((e) => console.error('[HGP] Watchdog:', e.message));
            instanceManager.reconectarInstanciasCaiadas().catch((e) => console.error('[InstanceManager] Watchdog:', e.message));
        }, 45000);

        // Fallback leve para o caso especifico em que o HGP aparece conectado,
        // mas o listener do Chrome para de entregar novas mensagens.
        setInterval(() => {
            recuperarMensagensNaoLidasHgp().catch((e) => console.error('[HGP] Fallback não lidas:', e.message));
        }, 12000);

        app.listen(PORT, () => {
            console.log(`Servidor rodando em http://localhost:${PORT}`);
        });

        // Inicia limpeza automática de mídia (executa após 30s e a cada 24h)
        mediaManager.iniciarLimpezaAutomatica(db);
    } catch (error) {
        console.error('Falha ao sincronizar schema do banco antes de iniciar o servidor:', error);
        process.exit(1);
    }
}

startServer();
