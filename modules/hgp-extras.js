// Recursos exclusivos do WhatsApp HGP (instância legada).
// A SESAU usa o fluxo dinâmico e não passa por aqui.
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const multer = require('multer');
const db = require('../config/database');

const DIR_DIRETO = path.join(__dirname, '..', 'public', 'uploads', 'hgp-direto');
const DIR_BOAS_VINDAS = path.join(__dirname, '..', 'public', 'uploads', 'hgp-boas-vindas');

let cacheHgp = { expira: 0, unidadeId: null, legacyIds: [] };

function variacoesNumero(valor) {
    const bruto = String(valor || '').replace(/@.*$/, '');
    const digits = bruto.replace(/\D/g, '');
    if (!digits) return [];

    const normalized = digits.startsWith('55') ? digits : `55${digits}`;
    const set = new Set([digits, normalized]);
    if (normalized.length === 13) set.add(normalized.slice(0, 4) + normalized.slice(5));
    if (normalized.length === 12) set.add(normalized.slice(0, 4) + '9' + normalized.slice(4));
    return [...set].filter((v) => v.length >= 10);
}

function telefoneCanonico(valor) {
    const vars = variacoesNumero(valor);
    return vars.find((v) => v.startsWith('55') && v.length === 13)
        || vars.find((v) => v.startsWith('55') && v.length === 12)
        || '';
}

function numerosCompativeis(candidatos, telefoneCadastrado) {
    const alvos = new Set();
    for (const candidato of candidatos) {
        for (const variacao of variacoesNumero(candidato)) alvos.add(variacao);
    }
    if (!alvos.size) return false;
    return variacoesNumero(telefoneCadastrado).some((variacao) => alvos.has(variacao));
}

function extensaoPorMime(mime, nomeOriginal) {
    const mapa = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'image/gif': '.gif',
        'video/mp4': '.mp4',
        'audio/ogg': '.ogg',
        'audio/mpeg': '.mp3',
        'audio/mp4': '.m4a',
        'application/pdf': '.pdf'
    };
    if (mapa[mime]) return mapa[mime];
    const ext = path.extname(String(nomeOriginal || '')).toLowerCase();
    return ext && ext.length <= 8 ? ext : '.bin';
}

async function contextoHgp() {
    if (Date.now() < cacheHgp.expira) return cacheHgp;
    const [unidades] = await db.query("SELECT id FROM unidades WHERE codigo = 'HGP' LIMIT 1");
    const [instancias] = await db.query('SELECT id FROM instancias WHERE is_legacy = TRUE');
    cacheHgp = {
        expira: Date.now() + 60000,
        unidadeId: unidades[0] ? Number(unidades[0].id) : null,
        legacyIds: instancias.map((row) => Number(row.id))
    };
    return cacheHgp;
}

function chamadoEhHgpComContexto(chamado, ctx) {
    if (!chamado) return false;
    const unidadeId = chamado.unidade_id == null ? null : Number(chamado.unidade_id);
    const instanciaId = chamado.instancia_id == null ? null : Number(chamado.instancia_id);
    if (ctx.unidadeId && unidadeId === ctx.unidadeId) return true;
    if (unidadeId == null && (instanciaId == null || ctx.legacyIds.includes(instanciaId))) return true;
    return false;
}

async function chamadoEhHgp(chamado) {
    return chamadoEhHgpComContexto(chamado, await contextoHgp());
}

async function marcarEhHgp(chamados) {
    if (!Array.isArray(chamados) || chamados.length === 0) return chamados;
    const ctx = await contextoHgp();
    for (const chamado of chamados) {
        chamado.eh_hgp = chamadoEhHgpComContexto(chamado, ctx);
    }
    return chamados;
}

async function encontrarTerceirizado(candidatos) {
    const [rows] = await db.query(
        'SELECT id, nome, telefone, ativo FROM hgp_terceirizados WHERE ativo = TRUE'
    );
    return rows.find((row) => numerosCompativeis(candidatos, row.telefone)) || null;
}

async function telefoneEmUso(telefone, ignorarId = null) {
    const [rows] = await db.query('SELECT id, telefone FROM hgp_terceirizados');
    return rows.find((row) => Number(row.id) !== Number(ignorarId) && numerosCompativeis([telefone], row.telefone)) || null;
}

async function registrarEntrada(terceirizadoId, msg) {
    let messageType = 'text';
    let mensagem = String(msg?.body || '').trim();
    let mediaUrl = null;
    let mediaMime = null;
    let mediaFilename = null;

    const tipo = String(msg?.type || '').toLowerCase();
    const ehMidia = Boolean(msg?.hasMedia) || ['audio', 'ptt', 'video', 'image', 'document', 'sticker'].includes(tipo);

    if (ehMidia && typeof msg.downloadMedia === 'function') {
        try {
            const media = await msg.downloadMedia();
            if (media?.data) {
                const mime = media.mimetype || 'application/octet-stream';
                const nome = `direto-${terceirizadoId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extensaoPorMime(mime, media.filename)}`;
                await fs.mkdir(DIR_DIRETO, { recursive: true });
                await fs.writeFile(path.join(DIR_DIRETO, nome), Buffer.from(media.data, 'base64'));
                mediaUrl = `/uploads/hgp-direto/${nome}`;
                mediaMime = mime;
                mediaFilename = media.filename || nome;
                messageType = tipo === 'ptt' ? 'audio' : (tipo || 'media');
                if (!mensagem) mensagem = media.filename || '[mídia]';
            }
        } catch (error) {
            console.error('[HGP direto] Falha ao salvar mídia:', error.message);
            if (!mensagem) mensagem = '[mídia não salva]';
        }
    }

    if (!mensagem && !mediaUrl) mensagem = '[mensagem sem texto]';

    await db.query(
        `INSERT INTO hgp_terceirizado_mensagens
            (terceirizado_id, direcao, mensagem, message_type, media_url, media_mime_type, media_filename, lida)
         VALUES (?, 'entrada', ?, ?, ?, ?, ?, FALSE)`,
        [terceirizadoId, mensagem, messageType, mediaUrl, mediaMime, mediaFilename]
    );
}

async function registrarSaida(terceirizadoId, mensagem) {
    const texto = String(mensagem || '').trim();
    const [result] = await db.query(
        `INSERT INTO hgp_terceirizado_mensagens
            (terceirizado_id, direcao, mensagem, message_type, lida)
         VALUES (?, 'saida', ?, 'text', TRUE)`,
        [terceirizadoId, texto]
    );
    return result.insertId;
}

async function carregarBoasVindas() {
    const [rows] = await db.query(
        `SELECT setting_key, setting_value FROM system_settings
         WHERE setting_key IN ('hgp_boas_vindas_ativa', 'hgp_boas_vindas_arquivo', 'hgp_boas_vindas_legenda')`
    );
    const map = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]));
    const rel = String(map.hgp_boas_vindas_arquivo || '');
    const abs = rel ? path.join(__dirname, '..', 'public', rel.replace(/^\//, '')) : '';
    const existe = Boolean(abs && fsSync.existsSync(abs));
    return {
        ativa: map.hgp_boas_vindas_ativa === 'true' && existe,
        solicitada: map.hgp_boas_vindas_ativa === 'true',
        arquivo: existe ? abs : null,
        url: existe ? rel : '',
        legenda: map.hgp_boas_vindas_legenda || ''
    };
}

async function salvarConfigBoasVindas({ ativa, legenda, arquivoRelativo, remover }) {
    const atual = await carregarBoasVindas();
    let arquivo = atual.url || '';

    if (remover) {
        if (atual.arquivo) await fs.unlink(atual.arquivo).catch(() => null);
        arquivo = '';
    } else if (arquivoRelativo) {
        if (atual.arquivo && atual.url !== arquivoRelativo) {
            await fs.unlink(atual.arquivo).catch(() => null);
        }
        arquivo = arquivoRelativo;
    }

    const pares = [
        ['hgp_boas_vindas_ativa', ativa ? 'true' : 'false'],
        ['hgp_boas_vindas_legenda', String(legenda || '').slice(0, 500)],
        ['hgp_boas_vindas_arquivo', arquivo]
    ];
    for (const [chave, valor] of pares) {
        await db.query(
            `INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
            [chave, valor]
        );
    }
    return carregarBoasVindas();
}

async function listarEquipeTiHgp() {
    const ctx = await contextoHgp();
    if (!ctx.unidadeId) return [];
    const [rows] = await db.query(
        `SELECT DISTINCT a.id, a.username, a.nome_completo, a.telefone, a.nivel_acesso
         FROM admins a
         INNER JOIN admin_unidades au ON au.admin_id = a.id
         WHERE au.unidade_id = ?
           AND a.ativo = TRUE
           AND a.nivel_acesso IN ('administrador', 'gerenciador', 'gestor')
         ORDER BY a.nome_completo`,
        [ctx.unidadeId]
    );
    return rows;
}

async function enviarTextoWhatsApp(client, telefone, texto) {
    if (!client || !telefone || !texto) return false;
    for (const numero of variacoesNumero(telefone)) {
        try {
            const numberId = await client.getNumberId(numero);
            if (numberId?._serialized) {
                await client.sendMessage(numberId._serialized, texto, { immediate: true });
                return true;
            }
        } catch (error) {
            // tenta a próxima variação do número
        }
    }
    return false;
}

const uploadBoasVindas = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            fsSync.mkdirSync(DIR_BOAS_VINDAS, { recursive: true });
            cb(null, DIR_BOAS_VINDAS);
        },
        filename: (req, file, cb) => {
            const ext = extensaoPorMime(file.mimetype, file.originalname);
            cb(null, `comunicado-${Date.now()}${ext}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Envie uma imagem JPG, PNG, WEBP ou GIF.'));
    }
});

function registrarRotas(app, deps) {
    const { isAuthenticated, obterClienteHgp, resolverDestino, entregarMensagem } = deps;

    const podeComunicacaoHgp = (req, res, next) => {
        if (req.session.nivelAcesso === 'visualizador') {
            if (String(req.originalUrl || '').startsWith('/api/')) {
                return res.status(403).json({ success: false, message: 'Sem permissão.' });
            }
            return res.redirect('/chamados');
        }
        return next();
    };

    app.get('/hgp', isAuthenticated, podeComunicacaoHgp, (req, res) => {
        const nivelAcesso = req.session.nivelAcesso || 'administrador';
        res.render('hgp', {
            username: req.session.username,
            nivelAcesso,
            isAdmin: nivelAcesso === 'administrador' || nivelAcesso === 'gerenciador'
        });
    });

    app.get('/api/hgp/terceirizados', isAuthenticated, podeComunicacaoHgp, async (req, res) => {
        try {
            const [rows] = await db.query(
                `SELECT t.id, t.nome, t.telefone, t.observacao, t.ativo, t.criado_em,
                        (SELECT COUNT(*) FROM hgp_terceirizado_mensagens m
                          WHERE m.terceirizado_id = t.id AND m.direcao = 'entrada' AND m.lida = FALSE) AS nao_lidas,
                        (SELECT MAX(m2.criado_em) FROM hgp_terceirizado_mensagens m2
                          WHERE m2.terceirizado_id = t.id) AS ultima_mensagem_em
                 FROM hgp_terceirizados t
                 ORDER BY t.ativo DESC, ultima_mensagem_em DESC, t.nome`
            );
            res.json({ success: true, terceirizados: rows });
        } catch (error) {
            console.error('[HGP direto] listar:', error.message);
            res.status(500).json({ success: false, message: 'Erro ao listar terceirizados' });
        }
    });

    app.post('/api/hgp/terceirizados', isAuthenticated, podeComunicacaoHgp, async (req, res) => {
        try {
            const nome = String(req.body?.nome || '').trim();
            const telefone = telefoneCanonico(req.body?.telefone);
            const observacao = String(req.body?.observacao || '').trim().slice(0, 255);
            if (nome.length < 2) {
                return res.status(400).json({ success: false, message: 'Informe o nome do contato.' });
            }
            if (!telefone) {
                return res.status(400).json({ success: false, message: 'Informe um telefone válido com DDD.' });
            }
            if (await telefoneEmUso(telefone)) {
                return res.status(409).json({ success: false, message: 'Este número já está cadastrado.' });
            }
            const [result] = await db.query(
                `INSERT INTO hgp_terceirizados (nome, telefone, observacao, ativo) VALUES (?, ?, ?, TRUE)`,
                [nome, telefone, observacao || null]
            );
            res.json({ success: true, id: result.insertId, message: 'Terceirizado cadastrado. Esse número não vai mais acionar o bot do HGP.' });
        } catch (error) {
            console.error('[HGP direto] criar:', error.message);
            res.status(500).json({ success: false, message: 'Erro ao cadastrar terceirizado' });
        }
    });

    app.put('/api/hgp/terceirizados/:id', isAuthenticated, podeComunicacaoHgp, async (req, res) => {
        try {
            const id = Number(req.params.id);
            const [atuais] = await db.query('SELECT * FROM hgp_terceirizados WHERE id = ?', [id]);
            if (!atuais.length) return res.status(404).json({ success: false, message: 'Contato não encontrado' });

            const nome = req.body?.nome != null ? String(req.body.nome).trim() : atuais[0].nome;
            const observacao = req.body?.observacao != null
                ? String(req.body.observacao).trim().slice(0, 255)
                : (atuais[0].observacao || '');
            const ativo = req.body?.ativo == null ? Boolean(atuais[0].ativo) : Boolean(req.body.ativo);
            let telefone = atuais[0].telefone;
            if (req.body?.telefone != null) {
                telefone = telefoneCanonico(req.body.telefone);
                if (!telefone) return res.status(400).json({ success: false, message: 'Telefone inválido.' });
                if (await telefoneEmUso(telefone, id)) {
                    return res.status(409).json({ success: false, message: 'Este número já está cadastrado.' });
                }
            }
            if (nome.length < 2) return res.status(400).json({ success: false, message: 'Informe o nome do contato.' });

            await db.query(
                `UPDATE hgp_terceirizados SET nome = ?, telefone = ?, observacao = ?, ativo = ? WHERE id = ?`,
                [nome, telefone, observacao || null, ativo, id]
            );
            res.json({ success: true, message: ativo ? 'Contato atualizado.' : 'Contato desativado. O bot do HGP volta a atender esse número.' });
        } catch (error) {
            console.error('[HGP direto] atualizar:', error.message);
            res.status(500).json({ success: false, message: 'Erro ao atualizar terceirizado' });
        }
    });

    app.delete('/api/hgp/terceirizados/:id', isAuthenticated, podeComunicacaoHgp, async (req, res) => {
        try {
            const [result] = await db.query('DELETE FROM hgp_terceirizados WHERE id = ?', [req.params.id]);
            if (!result.affectedRows) return res.status(404).json({ success: false, message: 'Contato não encontrado' });
            res.json({ success: true, message: 'Contato removido. O bot do HGP volta a atender esse número.' });
        } catch (error) {
            console.error('[HGP direto] excluir:', error.message);
            res.status(500).json({ success: false, message: 'Erro ao excluir terceirizado' });
        }
    });

    app.get('/api/hgp/terceirizados/:id/mensagens', isAuthenticated, podeComunicacaoHgp, async (req, res) => {
        try {
            const id = Number(req.params.id);
            const depois = Number(req.query.depois || 0);
            const [rows] = await db.query(
                `SELECT id, direcao, mensagem, message_type, media_url, media_mime_type, media_filename, lida, criado_em
                 FROM hgp_terceirizado_mensagens
                 WHERE terceirizado_id = ? AND id > ?
                 ORDER BY id ASC
                 LIMIT 300`,
                [id, Number.isInteger(depois) && depois > 0 ? depois : 0]
            );
            await db.query(
                `UPDATE hgp_terceirizado_mensagens
                 SET lida = TRUE
                 WHERE terceirizado_id = ? AND direcao = 'entrada' AND lida = FALSE`,
                [id]
            );
            res.json({ success: true, mensagens: rows });
        } catch (error) {
            console.error('[HGP direto] mensagens:', error.message);
            res.status(500).json({ success: false, message: 'Erro ao carregar mensagens' });
        }
    });

    app.post('/api/hgp/terceirizados/:id/enviar', isAuthenticated, podeComunicacaoHgp, async (req, res) => {
        try {
            const id = Number(req.params.id);
            const texto = String(req.body?.mensagem || '').trim();
            if (!texto) return res.status(400).json({ success: false, message: 'Digite a mensagem.' });
            if (texto.length > 4000) return res.status(400).json({ success: false, message: 'Mensagem muito longa.' });

            const [rows] = await db.query('SELECT * FROM hgp_terceirizados WHERE id = ? AND ativo = TRUE', [id]);
            if (!rows.length) return res.status(404).json({ success: false, message: 'Contato ativo não encontrado' });

            const { client, connected } = obterClienteHgp();
            if (!client || !connected) {
                return res.status(503).json({ success: false, message: 'O WhatsApp do HGP não está conectado.' });
            }

            const destino = await resolverDestino(rows[0].telefone);
            if (!destino) {
                return res.status(422).json({ success: false, message: 'Não foi possível localizar esse número no WhatsApp.' });
            }

            const ok = await entregarMensagem(client, destino, texto, { options: { immediate: true } });
            if (!ok) {
                return res.status(502).json({ success: false, message: 'O WhatsApp não confirmou a entrega.' });
            }

            await registrarSaida(id, texto);
            res.json({ success: true, message: 'Mensagem enviada.' });
        } catch (error) {
            console.error('[HGP direto] enviar:', error.message);
            res.status(500).json({ success: false, message: 'Erro ao enviar mensagem' });
        }
    });

    app.get('/api/hgp/boas-vindas', isAuthenticated, podeComunicacaoHgp, async (req, res) => {
        try {
            res.json({ success: true, ...(await carregarBoasVindas()), arquivo: undefined });
        } catch (error) {
            res.status(500).json({ success: false, message: 'Erro ao carregar comunicado' });
        }
    });

    app.post('/api/hgp/boas-vindas', isAuthenticated, podeComunicacaoHgp, (req, res) => {
        uploadBoasVindas.single('imagem')(req, res, async (err) => {
            if (err) {
                return res.status(400).json({ success: false, message: err.message || 'Falha no upload' });
            }
            try {
                const ativa = req.body?.ativa === 'true' || req.body?.ativa === '1' || req.body?.ativa === true;
                const remover = req.body?.remover === 'true' || req.body?.remover === '1';
                const arquivoRelativo = req.file ? `/uploads/hgp-boas-vindas/${req.file.filename}` : '';
                const cfg = await salvarConfigBoasVindas({
                    ativa,
                    legenda: req.body?.legenda,
                    arquivoRelativo,
                    remover
                });
                let message = 'Comunicado desativado. O menu do HGP segue sem imagem.';
                if (ativa && !cfg.ativa) {
                    message = 'Ficou marcado como ativo, mas ainda falta a imagem. Nada será enviado até o upload.';
                } else if (cfg.ativa) {
                    message = 'Comunicado ativo. A imagem sai antes do menu, só no WhatsApp do HGP.';
                }
                res.json({
                    success: true,
                    message,
                    url: cfg.url,
                    legenda: cfg.legenda,
                    ativa: cfg.solicitada,
                    pronta: cfg.ativa
                });
            } catch (error) {
                console.error('[HGP boas-vindas] salvar:', error.message);
                res.status(500).json({ success: false, message: 'Erro ao salvar comunicado' });
            }
        });
    });
}

module.exports = {
    variacoesNumero,
    telefoneCanonico,
    numerosCompativeis,
    chamadoEhHgp,
    marcarEhHgp,
    encontrarTerceirizado,
    registrarEntrada,
    carregarBoasVindas,
    listarEquipeTiHgp,
    enviarTextoWhatsApp,
    registrarRotas
};
