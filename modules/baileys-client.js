// ════════════════════════════════════════════════════════════════════
// Baileys Client — wrapper compatível com whatsapp-web.js
// ════════════════════════════════════════════════════════════════════
// Usado pelas instâncias dinâmicas (SESAU, etc.) e pela principal HGP.
// ════════════════════════════════════════════════════════════════════

const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const EventEmitter = require('events');

const logger = pino({ level: 'silent' });

class BaileysClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.clientId = options.clientId || 'default';
        this.authDir = options.authDir || path.join(__dirname, '..', '.baileys_auth');
        this.sock = null;
        this.isConnected = false;
        this.qrRetries = 0;
        this.maxQrRetries = 8;
        this.reconnectAttempts = 0;
        this._destroyed = false;
        // Dedup de mensagens recebidas por ID — sobrevive a reconexões (515 etc).
        // Mantido no nível da instância (não do socket) para que múltiplos
        // sockets criados na mesma instância compartilhem o mesmo registro.
        this._recentMsgIds = new Map();
    }

    async initialize() {
        if (this._destroyed) return;

        const sessionDir = path.join(this.authDir, this.clientId);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        this._state = state;
        this._saveCreds = saveCreds;
        this._sessionDir = sessionDir;

        await this._createSocket();
    }

    async _reconnect() {
        if (this._destroyed) return;
        await this._createSocket();
    }

    async _createSocket() {
        const { version } = await fetchLatestBaileysVersion();
        // Se o cliente foi destruído durante o await acima (reconexão sobreposta),
        // não abrir socket: um socket "fantasma" com as mesmas credenciais
        // disputa a sessão com o cliente novo e faz mensagens se perderem.
        if (this._destroyed) return;
        const { state, saveCreds } = await useMultiFileAuthState(this._sessionDir);
        this._state = state;

        // Limpar socket anterior se existir — remover listeners E encerrar a
        // conexão websocket antiga. Sem o end(), o socket antigo pode continuar
        // vivo e entregar mensagens em paralelo ao novo (duplicação).
        if (this.sock) {
            try { this.sock.ev.removeAllListeners(); } catch (e) {}
            try { this.sock.end(undefined); } catch (e) {}
            this.sock = null;
        }

        this.sock = makeWASocket({
            version,
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            logger,
            printQRInTerminal: false,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            // ═══ ANTI-BAN: Configurações otimizadas ═══
            markOnlineOnConnect: false,
            connectTimeoutMs: 60_000,
            keepAliveIntervalMs: 25_000,
            retryRequestDelayMs: 500,
            defaultQueryTimeoutMs: 60_000,
            emitOwnEvents: false,
            fireInitQueries: true
        });

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', async (update) => {
            if (this._destroyed) return;
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.qrRetries++;
                if (this.qrRetries > this.maxQrRetries) {
                    // Encerra ANTES de emitir: sem isso o socket segue vivo, o
                    // 408 dispara a reconexão interna e o cliente vira um órfão
                    // gerando QR e disputando as credenciais com o cliente novo.
                    await this.destroy();
                    this.emit('auth_failure', 'QR Code expirado');
                    return;
                }
                try {
                    const qrDataUrl = await qrcode.toDataURL(qr);
                    this.emit('qr', qrDataUrl);
                } catch (e) {
                    this.emit('qr', qr);
                }
            }

            if (connection === 'close') {
                this.isConnected = false;
                this._disconnectedAt = Date.now();
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.message || '';
                const nomeMotivo = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === statusCode) || 'desconhecido';
                console.log(`[Baileys:${this.clientId}] Conexão fechada — código=${statusCode} (${nomeMotivo}) msg="${reason}"`);

                // Casos terminais: NÃO reconectar automaticamente
                // - loggedOut (401): número deslogou / removeu o aparelho
                // - 403 / 401 podem indicar BAN do número
                if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403) {
                    console.log(`[Baileys:${this.clientId}] Sessão inválida (logout/ban). Limpando credenciais — será necessário ler o QR de novo.`);
                    try {
                        if (fs.existsSync(this._sessionDir)) fs.rmSync(this._sessionDir, { recursive: true, force: true });
                    } catch (e) {}
                    this.emit('disconnected', statusCode === DisconnectReason.loggedOut ? 'LOGOUT' : 'BANIDO/INVÁLIDO');
                    return;
                }

                // connectionReplaced (440): OUTRO dispositivo/processo abriu a mesma
                // sessão. Reconectar criaria uma guerra de conexões (e duplicação).
                if (statusCode === DisconnectReason.connectionReplaced) {
                    console.log(`[Baileys:${this.clientId}] Conexão substituída — reconectando em 8s (outro processo provavelmente encerrou).`);
                    this.reconnectAttempts++;
                    setTimeout(() => {
                        if (!this._destroyed) this._reconnect();
                    }, 8000);
                    return;
                }

                if (this._destroyed) return;

                // 408 antes do pareamento = WhatsApp esgotou os QRs sem ninguém
                // ler. Reconectar só gera mais QR no vazio; encerra e deixa o
                // usuário clicar em Conectar de novo.
                if (statusCode === DisconnectReason.timedOut && !this._state?.creds?.me) {
                    await this.destroy();
                    this.emit('auth_failure', 'QR Code expirado');
                    return;
                }

                // Demais casos (incl. 515 restartRequired, timeouts, etc): reconectar.
                // 515 logo após parear é esperado e deve reconectar rápido.
                this.reconnectAttempts++;
                let delay;
                if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
                    delay = 1500; // restart logo após o pareamento — rápido
                } else {
                    delay = Math.min(30000, 3000 * this.reconnectAttempts);
                }
                console.log(`[Baileys:${this.clientId}] Reconectando em ${delay/1000}s (tentativa ${this.reconnectAttempts})...`);
                setTimeout(() => {
                    if (!this._destroyed) this._reconnect();
                }, delay);
            }

            if (connection === 'open') {
                this.isConnected = true;
                this._disconnectedAt = 0;
                this.qrRetries = 0;
                this.reconnectAttempts = 0;
                console.log(`[Baileys:${this.clientId}] Conexão aberta ✓`);
                this.emit('ready');
            }
        });

        // Mensagens recebidas — registra UMA vez por socket
        this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify' || this._destroyed) return;
            for (const msg of messages) {
                if (msg.key.fromMe) continue;
                if (!msg.message) continue;

                // ═══ DEDUP À PROVA DE RECONEXÃO ═══
                // O WhatsApp pode reentregar a mesma mensagem (mesmo key.id) após
                // uma reconexão (código 515) ou se houver mais de um socket vivo.
                // Filtramos aqui, no nível da instância, ANTES de emitir ao handler.
                const msgId = msg.key.id;
                if (msgId) {
                    const now = Date.now();
                    if (this._recentMsgIds.has(msgId)) {
                        console.log(`[Baileys:${this.clientId}] Msg duplicada ignorada (id=${msgId})`);
                        continue;
                    }
                    this._recentMsgIds.set(msgId, now);
                    // Limpeza preguiçosa: remove ids com mais de 5 min
                    if (this._recentMsgIds.size > 500) {
                        for (const [k, t] of this._recentMsgIds) {
                            if (now - t > 5 * 60 * 1000) this._recentMsgIds.delete(k);
                        }
                    }
                }

                const fakeMsg = this._converterMensagem(msg);
                this.emit('message', fakeMsg);
            }
        });
    }

    _desembrulharMensagem(message) {
        let atual = message || {};
        for (let i = 0; i < 5; i++) {
            const proxima =
                atual.ephemeralMessage?.message ||
                atual.viewOnceMessage?.message ||
                atual.viewOnceMessageV2?.message ||
                atual.documentWithCaptionMessage?.message ||
                atual.editedMessage?.message ||
                null;
            if (!proxima) break;
            atual = proxima;
        }
        return atual;
    }

    _converterMensagem(msg) {
        const jid = msg.key.remoteJid || '';
        const message = this._desembrulharMensagem(msg.message || {});
        const texto = message.conversation || message.extendedTextMessage?.text || message.imageMessage?.caption || message.videoMessage?.caption || '';
        let type = 'chat';
        const hasMedia = !!(message.imageMessage || message.videoMessage || message.audioMessage || message.documentMessage || message.stickerMessage);
        if (message.imageMessage) type = 'image';
        else if (message.videoMessage) type = 'video';
        else if (message.audioMessage) type = 'ptt';
        else if (message.documentMessage) type = 'document';
        else if (message.stickerMessage) type = 'sticker';
        const pushName = msg.pushName || '';
        const self = this;
        const mediaPayload = message.imageMessage || message.videoMessage || message.audioMessage || message.documentMessage || message.stickerMessage || null;

        return {
            from: jid, to: '', body: texto, type, hasMedia, fromMe: false,
            timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000),
            id: { _serialized: msg.key.id || `${jid}-${Date.now()}` },
            async getContact() { return { pushname: pushName, name: pushName, number: jid.replace(/@.*$/, '') }; },
            async getChat() {
                return {
                    id: { _serialized: jid },
                    async sendMessage(content) { return self.sendMessage(jid, content, { immediate: true }); }
                };
            },
            async reply(text) { return self.sendMessage(jid, text, { immediate: true }); },
            async delete(forEveryone) { try { await self.sock.sendMessage(jid, { delete: msg.key }); } catch (e) {} },
            async downloadMedia() {
                if (!hasMedia || !mediaPayload) return null;
                const mensagemDownload = { ...msg, message };
                let ultimoErro = null;
                for (let tentativa = 1; tentativa <= 2; tentativa++) {
                    try {
                        const buffer = await downloadMediaMessage(
                            mensagemDownload,
                            'buffer',
                            {},
                            {
                                logger,
                                reuploadRequest: self.sock?.updateMediaMessage
                                    ? self.sock.updateMediaMessage.bind(self.sock)
                                    : undefined
                            }
                        );

                        if (!buffer) return null;

                        return {
                            data: Buffer.from(buffer).toString('base64'),
                            mimetype: mediaPayload.mimetype || '',
                            filename: mediaPayload.fileName || mediaPayload.filename || `${type}-${msg.key.id || Date.now()}`
                        };
                    } catch (e) {
                        ultimoErro = e;
                        if (tentativa < 2) await new Promise(r => setTimeout(r, 700));
                    }
                }
                console.error('[BaileysClient] Erro ao baixar mídia recebida:', ultimoErro?.message || 'erro desconhecido');
                return null;
            }
        };
    }

    async sendMessage(chatId, content, options = {}) {
        if (!this.sock || !this.isConnected) throw new Error('WhatsApp não está conectado');

        // Mensagens manuais (atendente respondendo no chat) devem sair NA HORA.
        // O delay anti-ban só faz sentido para mensagens automáticas do bot.
        const immediate = options.immediate === true;

        if (!immediate) {
            // ═══ ANTI-BAN: Simular comportamento humano ═══
            // 1. Delay aleatório ANTES de enviar (humanos não respondem instantaneamente)
            const preDelay = 1000 + Math.floor(Math.random() * 2000); // 1-3s
            await new Promise(r => setTimeout(r, preDelay));

            // 2. Mostrar "digitando..." (presença composing)
            try {
                await this.sock.sendPresenceUpdate('composing', chatId);
                // Tempo de "digitação" proporcional ao tamanho do texto (50-80ms por caractere)
                const textoLen = typeof content === 'string' ? content.length : (options.caption || '').length || 20;
                const typingTime = Math.min(4000, Math.max(800, textoLen * (50 + Math.floor(Math.random() * 30))));
                await new Promise(r => setTimeout(r, typingTime));
                await this.sock.sendPresenceUpdate('paused', chatId);
            } catch (e) { /* não-crítico */ }
        }

        // 3. Micro-delay final aleatório (100-500ms) — pulado no modo imediato
        if (!immediate) {
            await new Promise(r => setTimeout(r, 100 + Math.floor(Math.random() * 400)));
        }

        // ═══ ENVIO ═══
        if (typeof content === 'string') {
            await this.sock.sendMessage(chatId, { text: content });
            return {};
        }
        if (content && content.mimetype) {
            const buffer = Buffer.from(content.data, 'base64');
            const mime = content.mimetype;
            if (mime.startsWith('image/')) await this.sock.sendMessage(chatId, { image: buffer, caption: options.caption || '', mimetype: mime });
            else if (mime.startsWith('video/')) await this.sock.sendMessage(chatId, { video: buffer, caption: options.caption || '', mimetype: mime });
            else if (mime.startsWith('audio/')) await this.sock.sendMessage(chatId, { audio: buffer, mimetype: mime, ptt: true });
            else await this.sock.sendMessage(chatId, { document: buffer, mimetype: mime, fileName: content.filename || 'arquivo' });
            return {};
        }
        if (content?.text) await this.sock.sendMessage(chatId, { text: content.text });
        return {};
    }

    async getNumberId(numero) {
        if (!this.sock) return null;
        try {
            let num = String(numero).replace(/\D/g, '');
            const [result] = await this.sock.onWhatsApp(num);
            if (result?.exists) return { _serialized: result.jid };
            return null;
        } catch (e) { return null; }
    }

    async getContactById(jid) { return { pushname: '', name: '', number: jid.replace(/@.*$/, '') }; }

    async getChatById(chatId) {
        const self = this;
        return {
            async sendStateTyping() { try { await self.sock.sendPresenceUpdate('composing', chatId); } catch (e) {} },
            async clearState() { try { await self.sock.sendPresenceUpdate('paused', chatId); } catch (e) {} }
        };
    }

    async destroy() {
        this._destroyed = true;
        if (this.sock) {
            try { this.sock.ev.removeAllListeners(); this.sock.end(); } catch (e) {}
            this.sock = null;
        }
        this.isConnected = false;
    }

    async logout() {
        if (this.sock) { try { await this.sock.logout(); } catch (e) {} }
        await this.destroy();
        const sessionDir = path.join(this.authDir, this.clientId);
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    }
}

module.exports = { BaileysClient };
