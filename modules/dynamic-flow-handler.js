// ════════════════════════════════════════════════════════════════════
// Dynamic Flow Handler — Bot que segue um fluxo definido em JSON
// ════════════════════════════════════════════════════════════════════
// Ele NÃO substitui o chatbot-handler.js original (instância legada).
// Apenas as instâncias novas (não-legadas) usam este handler.
// ════════════════════════════════════════════════════════════════════

const dayjs = require('dayjs');
const fs = require('fs/promises');
const path = require('path');
const db = require('../config/database');
const { validarDescricao } = require('./ai-description-validator');

const ATTACH_FLAG = Symbol.for('hgp.dynamicFlow.attached');
const CHAT_MEDIA_DIR = path.join(__dirname, '..', 'public', 'uploads', 'chat-media');

function gerarProtocolo(prefixo = 'HGP') {
    const data = dayjs().format('DDMM');
    const random = Math.random().toString(36).substring(2, 5).toUpperCase();
    return `${prefixo}-${data}-${random}`;
}

// Campos que são "pessoais" e devem ser memorizados entre chamados
const CAMPOS_PESSOAIS = ['nome_completo', 'cpf', 'email', 'telefone'];
const CAMPOS_BLOQUEIO_HOSPITAL = ['unidade', 'setor'];
const MENSAGEM_BLOQUEIO_HOSPITAL = '❌ Esta central não realiza abertura de chamados para hospitais. Procure o canal de atendimento interno da sua unidade hospitalar.';
const LABEL_NOME_HOSPITAL = 'Nome do Hospital';
const TERMOS_HGP_PERMITIDOS = [
    /\bhgp\b/,
    /\bhospital\s+geral\s+publico\b/,
    /\bhospital\s+geral\s+de\s+palmas\b/
];
const TERMOS_HOSPITAL_BLOQUEADOS = [
    /\bhrg\b/,
    /\bhrgua\b/,
    /\bhra\b/,
    /\bunacon\b/,
    /\bpronto\s*socorro\b/,
    /\bhospital\s+regional\b/,
    /\bhospital\s+de\s+referencia\b/
];
const MUNICIPIOS_TOCANTINS_BLOQUEADOS = [
    "abreulandia",
    "aguiarnopolis",
    "alianca do tocantins",
    "almas",
    "alvorada",
    "ananas",
    "angico",
    "aparecida do rio negro",
    "aragominas",
    "araguacema",
    "araguacu",
    "araguaina",
    "araguana",
    "araguatins",
    "arapoema",
    "arraias",
    "augustinopolis",
    "aurora do tocantins",
    "axixa do tocantins",
    "babaculandia",
    "bandeirantes do tocantins",
    "barra do ouro",
    "barrolandia",
    "bernardo sayao",
    "bom jesus do tocantins",
    "brasilandia do tocantins",
    "brejinho de nazare",
    "buriti do tocantins",
    "cachoeirinha",
    "campos lindos",
    "cariri do tocantins",
    "carmolandia",
    "carrasco bonito",
    "caseara",
    "centenario",
    "chapada da natividade",
    "chapada de areia",
    "colinas do tocantins",
    "colmeia",
    "combinado",
    "conceicao do tocantins",
    "couto magalhaes",
    "cristalandia",
    "crixas do tocantins",
    "darcinopolis",
    "dianopolis",
    "divinopolis do tocantins",
    "dois irmaos do tocantins",
    "duere",
    "esperantina",
    "fatima",
    "figueiropolis",
    "filadelfia",
    "formoso do araguaia",
    "goianorte",
    "goiatins",
    "guarai",
    "gurupi",
    "ipueiras",
    "itacaja",
    "itaguatins",
    "itapiratins",
    "itapora do tocantins",
    "jau do tocantins",
    "juarina",
    "lagoa da confusao",
    "lagoa do tocantins",
    "lajeado",
    "lavandeira",
    "lizarda",
    "luzinopolis",
    "marianopolis do tocantins",
    "mateiros",
    "maurilandia do tocantins",
    "miracema do tocantins",
    "miranorte",
    "monte do carmo",
    "monte santo do tocantins",
    "muricilandia",
    "natividade",
    "nazare",
    "nova olinda",
    "nova rosalandia",
    "novo acordo",
    "novo alegre",
    "novo jardim",
    "oliveira de fatima",
    "palmas",
    "palmeirante",
    "palmeiras do tocantins",
    "palmeiropolis",
    "paraiso do tocantins",
    "parana",
    "pau d arco",
    "pedro afonso",
    "peixe",
    "pequizeiro",
    "pindorama do tocantins",
    "piraque",
    "pium",
    "ponte alta do bom jesus",
    "ponte alta do tocantins",
    "porto alegre do tocantins",
    "porto nacional",
    "praia norte",
    "presidente kennedy",
    "pugmil",
    "recursolandia",
    "riachinho",
    "rio da conceicao",
    "rio dos bois",
    "rio sono",
    "sampaio",
    "sandolandia",
    "santa fe do araguaia",
    "santa maria do tocantins",
    "santa rita do tocantins",
    "santa rosa do tocantins",
    "santa tereza do tocantins",
    "santa terezinha do tocantins",
    "sao bento do tocantins",
    "sao felix do tocantins",
    "sao miguel do tocantins",
    "sao salvador do tocantins",
    "sao sebastiao do tocantins",
    "sao valerio",
    "silvanopolis",
    "sitio novo do tocantins",
    "sucupira",
    "tabocao",
    "taguatinga",
    "taipas do tocantins",
    "talisma",
    "tocantinia",
    "tocantinopolis",
    "tupirama",
    "tupiratins",
    "wanderlandia",
    "xambioa",
    "fortaleza do tabocao"
];

function normalizarTextoBusca(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function termoNormalizadoPresente(texto, termo) {
    const escaped = termo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('\\b' + escaped + '\\b').test(texto);
}

function contemHospitalBloqueado(valor) {
    const texto = normalizarTextoBusca(valor);
    if (!texto) return false;

    const municipioBloqueado = MUNICIPIOS_TOCANTINS_BLOQUEADOS
        .find((municipio) => termoNormalizadoPresente(texto, municipio));
    const ehHgpPermitido = TERMOS_HGP_PERMITIDOS.some((termo) => termo.test(texto));

    if (ehHgpPermitido && (!municipioBloqueado || municipioBloqueado === 'palmas')) {
        return false;
    }

    if (TERMOS_HOSPITAL_BLOQUEADOS.some((termo) => termo.test(texto))) {
        return true;
    }

    if (municipioBloqueado) {
        return true;
    }

    return /\bhospital\b/.test(texto);
}
function dadosTemHospitalBloqueado(dados = {}, permitirHospitais = false) {
    if (permitirHospitais) return false;
    return CAMPOS_BLOQUEIO_HOSPITAL.some((campo) => contemHospitalBloqueado(dados[campo]));
}

function fluxoPermiteHospitais(flowDefinition = {}) {
    return flowDefinition.permitirHospitais === true || flowDefinition.aceitaHospitais === true;
}

function unidadeSelecionadaEhHospital(dados = {}) {
    const unidade = normalizarTextoBusca(dados.unidade);
    return /\bhospitais?\b/.test(unidade);
}

function labelCampoParaEstado(campo, estado) {
    if (campo?.key === 'setor' && unidadeSelecionadaEhHospital(estado?.dados)) {
        return LABEL_NOME_HOSPITAL;
    }
    return campo?.label || '';
}

function extrairTelefoneDoSession(sessionId) {
    return String(sessionId || '').replace(/@.*$/, '').replace(/\D/g, '');
}

function tipoMidiaNormalizado(tipoMsg) {
    const tipo = String(tipoMsg || '').toLowerCase();
    if (tipo === 'ptt') return 'audio';
    if (['image', 'video', 'audio', 'document', 'sticker'].includes(tipo)) return tipo;
    return 'media';
}

function extensaoMidia(media, tipoMsg) {
    const extOriginal = path.extname(media?.filename || '');
    if (extOriginal) return extOriginal;

    const mime = String(media?.mimetype || '').toLowerCase().split(';')[0];
    const porMime = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'image/gif': '.gif',
        'audio/ogg': '.ogg',
        'audio/mpeg': '.mp3',
        'audio/mp4': '.m4a',
        'video/mp4': '.mp4',
        'application/pdf': '.pdf'
    };

    return porMime[mime] || `.${tipoMidiaNormalizado(tipoMsg) || 'bin'}`;
}

async function salvarMidiaChat(msg, chamadoId, tipoMsg, instanciaNome) {
    if (!msg?.hasMedia && !['audio', 'ptt', 'video', 'image', 'document', 'sticker'].includes(String(tipoMsg || '').toLowerCase())) {
        return null;
    }

    const media = await msg.downloadMedia();
    if (!media?.data) {
        console.warn(`[DynamicFlow:${instanciaNome}] Mídia recebida, mas o WhatsApp não liberou o download.`);
        return null;
    }

    await fs.mkdir(CHAT_MEDIA_DIR, { recursive: true });

    const extensao = extensaoMidia(media, tipoMsg);
    const filename = `chamado-${chamadoId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extensao}`;
    const filePath = path.join(CHAT_MEDIA_DIR, filename);
    await fs.writeFile(filePath, Buffer.from(media.data, 'base64'));

    const messageType = tipoMidiaNormalizado(tipoMsg);
    if (messageType === 'image' && media.mimetype) {
        try {
            const mediaManager = require('./media-manager');
            await mediaManager.comprimirImagem(filePath, media.mimetype);
        } catch (e) {
            console.warn(`[DynamicFlow:${instanciaNome}] Não foi possível comprimir imagem recebida: ${e.message}`);
        }
    }

    return {
        messageType,
        mediaUrl: `/uploads/chat-media/${filename}`,
        mediaMimeType: media.mimetype || null,
        mediaFilename: media.filename || filename
    };
}

async function buscarPerfilPorTelefone(telefone) {
    if (!telefone) return null;
    try {
        const [rows] = await db.query(
            `SELECT dados_json FROM bot_user_profiles WHERE telefone = ? LIMIT 1`,
            [telefone]
        );
        if (rows.length === 0) return null;
        const d = rows[0].dados_json;
        return typeof d === 'string' ? JSON.parse(d) : d;
    } catch (e) {
        return null;
    }
}

async function salvarPerfilPorTelefone(telefone, dados, unidadeId = null) {
    if (!telefone) return;
    try {
        // Extrair só os campos pessoais
        const perfil = {};
        for (const k of CAMPOS_PESSOAIS) {
            if (dados[k] !== undefined && dados[k] !== null && dados[k] !== '') {
                perfil[k] = dados[k];
            }
        }
        if (Object.keys(perfil).length === 0) return;

        // Mesclar com perfil existente
        const existente = await buscarPerfilPorTelefone(telefone);
        const merged = { ...(existente || {}), ...perfil };

        await db.query(
            `INSERT INTO bot_user_profiles (telefone, dados_json, ultima_unidade_id)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE dados_json = ?, ultima_unidade_id = ?`,
            [telefone, JSON.stringify(merged), unidadeId, JSON.stringify(merged), unidadeId]
        );
    } catch (e) {
        console.error('Erro salvarPerfilPorTelefone:', e.message);
    }
}

function validarCampo(valor, tipo, opcoes = null) {
    const v = String(valor || '').trim();
    if (!v) return false;
    switch (tipo) {
        case 'cpf': {
            const digits = v.replace(/\D/g, '');
            return digits.length === 11;
        }
        case 'email':
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
        case 'telefone': {
            const digits = v.replace(/\D/g, '');
            // Aceita 10 (fixo com DDD), 11 (celular com DDD) ou 12-13 (com 55)
            return digits.length >= 10 && digits.length <= 13;
        }
        case 'opcoes': {
            if (!Array.isArray(opcoes)) return false;
            return opcoes.some(o => String(o.id) === v);
        }
        case 'texto_longo':
            return v.length >= 5;
        case 'texto':
        default:
            return v.length >= 1;
    }
}

function attachDynamicFlow(client, options = {}) {
    if (client[ATTACH_FLAG]) return client[ATTACH_FLAG];

    const {
        instanciaId,
        instanciaNome = 'Instância',
        unidadeId = null,
        flowDefinition,
        registrarEvento = () => {}
    } = options;

    if (!flowDefinition) {
        console.error(`[DynamicFlow:${instanciaNome}] flowDefinition não fornecida`);
        return null;
    }

    const estados = new Map();
    const bloqueados = new Map();
    const mensagensProcessadas = new Map();
    const inactivityTimers = new Map();
    const INACTIVITY_TIMEOUT = (flowDefinition.inatividadeMinutos || 10) * 60 * 1000;
    const COOLDOWN_POS_TICKET = 60 * 1000; // 1 min após criar chamado
    const permiteHospitais = fluxoPermiteHospitais(flowDefinition);

    const log = (msg) => console.log(`[DynamicFlow:${instanciaNome}] ${msg}`);
    async function bloquearHospitalEVoltarMenu(sessionId, chatId) {
        estados.set(sessionId, { step: 'menu' });
        clearTimeout(inactivityTimers.get(sessionId));
        inactivityTimers.delete(sessionId);
        await client.sendMessage(chatId, MENSAGEM_BLOQUEIO_HOSPITAL + '\n\n' + montarMenuPrincipal());
        resetInactivityTimer(sessionId, chatId);
    }

    // Cria chamado final + notifica + salva perfil + limpa estado
    async function criarChamadoFinal(est, sessionId, contato, chatId) {
        try {
            if (dadosTemHospitalBloqueado(est.dados, permiteHospitais)) {
                await bloquearHospitalEVoltarMenu(sessionId, chatId);
                return;
            }

            // Já existe chamado em aberto para este contato? Não cria outro.
            const [ativos] = await db.query(
                `SELECT protocolo FROM chamados
                 WHERE chat_origem = ? AND status IN ('pendente', 'aberto', 'em_atendimento')
                 ORDER BY criado_em DESC LIMIT 1`,
                [sessionId]
            );
            if (ativos.length > 0) {
                log(`Chamado duplicado evitado — ${sessionId} já possui ${ativos[0].protocolo} em aberto`);
                estados.delete(sessionId);
                bloquearSessao(sessionId);
                clearTimeout(inactivityTimers.get(sessionId));
                inactivityTimers.delete(sessionId);
                await client.sendMessage(
                    chatId,
                    `ℹ️ Você já possui um chamado em aberto: *${ativos[0].protocolo}*.\n\nAguarde o atendimento — as mensagens que enviar aqui serão anexadas a ele.`
                );
                return;
            }

            const { id, protocolo } = await salvarChamado(est, sessionId, contato);
            await client.sendMessage(
                chatId,
                `✅ *Chamado criado com sucesso!*\n\n📌 Protocolo: *${protocolo}*\n📋 Categoria: ${est.categoria}\n\nNossa equipe entrará em contato em breve. Para acompanhar, guarde seu protocolo.\n\n_Envie CANCELAR a qualquer momento se precisar abrir um novo chamado._`
            );

            // Salvar/atualizar perfil do usuário
            const telefone = extrairTelefoneDoSession(sessionId);
            await salvarPerfilPorTelefone(telefone, est.dados, unidadeId);

            // Notificar técnicos
            notificarTecnicosDaUnidade({ id, protocolo, categoria: est.categoria }, est.dados).catch(() => {});

            estados.delete(sessionId);
            bloquearSessao(sessionId);
            clearTimeout(inactivityTimers.get(sessionId));
            inactivityTimers.delete(sessionId);
        } catch (e) {
            console.error('Erro ao criar chamado:', e);
            await client.sendMessage(chatId, '❌ Ocorreu um erro ao criar o chamado. Tente novamente mais tarde.');
            estados.delete(sessionId);
        }
    }

    function resetInactivityTimer(sessionId, chatId) {
        const existing = inactivityTimers.get(sessionId);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(async () => {
            try {
                const [ativos] = await db.query(
                    `SELECT protocolo FROM chamados
                     WHERE chat_origem = ? AND status IN ('pendente', 'aberto', 'em_atendimento')
                     ORDER BY criado_em DESC LIMIT 1`,
                    [sessionId]
                );
                if (ativos.length > 0) {
                    estados.delete(sessionId);
                    inactivityTimers.delete(sessionId);
                    log(`Inatividade ignorada — chamado ${ativos[0].protocolo} em andamento`);
                    return;
                }
            } catch (e) {}

            try {
                await client.sendMessage(chatId, '⏰ Sessão encerrada por inatividade. Envie qualquer mensagem para começar de novo.');
            } catch (e) {}
            estados.delete(sessionId);
            inactivityTimers.delete(sessionId);
        }, INACTIVITY_TIMEOUT);

        inactivityTimers.set(sessionId, timer);
    }

    function bloquearSessao(sessionId) {
        bloqueados.set(sessionId, Date.now() + COOLDOWN_POS_TICKET);
        setTimeout(() => bloqueados.delete(sessionId), COOLDOWN_POS_TICKET);
    }

    function montarMenuPrincipal() {
        const menu = flowDefinition.menuPrincipal;
        const linhas = [menu.titulo, ''];
        for (const opc of menu.opcoes) {
            linhas.push(`*${opc.id}* - ${opc.label}`);
        }
        linhas.push('', '_Digite o número da opção desejada ou CANCELAR para sair._');
        return linhas.join('\n');
    }

    function montarSubmenu(submenuKey) {
        const sm = flowDefinition.submenus?.[submenuKey];
        if (!sm) return null;
        const linhas = [sm.titulo, ''];
        for (const opc of sm.opcoes) {
            linhas.push(`*${opc.id}* - ${opc.label}`);
        }
        linhas.push('', '_Digite o número da opção desejada._');
        return linhas.join('\n');
    }

    function obterBloco(blocoKey) {
        return flowDefinition.blocos?.[blocoKey] || flowDefinition.blocos?.padrao;
    }

    function montarPromptCampo(campo, estado = null) {
        const obrig = campo.obrigatorio ? '' : ' _(opcional, envie - para pular)_';
        const label = labelCampoParaEstado(campo, estado);
        let prompt = `📝 *${label}*${obrig}`;

        // Texto de ajuda/dica do campo (mostrado após o label)
        if (campo.ajuda) {
            prompt += `\n\n_${campo.ajuda}_`;
        }

        // Tipo "opcoes": listar as opções e pedir o número
        if (campo.tipo === 'opcoes' && Array.isArray(campo.opcoes)) {
            prompt += '\n';
            for (const opc of campo.opcoes) {
                prompt += `\n*${opc.id}* - ${opc.label}`;
            }
            prompt += '\n\n_Digite o número da opção._';
        }

        return prompt;
    }

    // Tem campos pessoais no bloco?
    function blocoTemCamposPessoais(bloco) {
        return bloco.campos.some(c => CAMPOS_PESSOAIS.includes(c.key));
    }

    // Resumo de dados pessoais salvos
    function montarResumoPerfil(perfil, bloco) {
        const linhas = ['👋 *Olá novamente!* Já tenho seus dados pessoais salvos:', ''];
        for (const c of bloco.campos) {
            if (CAMPOS_PESSOAIS.includes(c.key) && perfil[c.key]) {
                linhas.push(`• *${c.label}:* ${perfil[c.key]}`);
            }
        }
        linhas.push('', '*1* - Confirmar e seguir');
        linhas.push('*2* - Editar meus dados');
        linhas.push('', '_Digite o número da opção._');
        return linhas.join('\n');
    }

    // Próximo passo após confirmação do perfil: pular campos pessoais e ir direto pros contextuais
    function proximoCampoApolsConfirmacao(estado) {
        const bloco = estado.bloco;
        // Procurar o primeiro campo NÃO pessoal (ou que não tenha valor preenchido)
        for (let i = 0; i < bloco.campos.length; i++) {
            const c = bloco.campos[i];
            if (estado.dados[c.key] === undefined) {
                estado.campoIdx = i;
                return c;
            }
        }
        return null; // todos preenchidos — finalizar
    }

    async function salvarChamado(estado, sessionId, contato) {
        // Buscar código da unidade para usar como prefixo do protocolo
        let prefixo = 'HGP';
        if (unidadeId) {
            try {
                const [r] = await db.query('SELECT codigo FROM unidades WHERE id = ? LIMIT 1', [unidadeId]);
                if (r.length > 0 && r[0].codigo) {
                    prefixo = String(r[0].codigo).toUpperCase();
                }
            } catch (e) {}
        }
        const protocolo = gerarProtocolo(prefixo);
        const dados = estado.dados || {};
        const categoria = estado.categoria || 'Outros';
        const subcategoria = estado.subcategoria || null;

        const descricaoFinal = subcategoria
            ? `[${subcategoria}] ${dados.descricao || ''}`
            : (dados.descricao || '');

        // Tentar resolver local_id pelo nome do campo "unidade" no formulário
        let localId = null;
        if (unidadeId && dados.unidade) {
            try {
                const [locais] = await db.query(
                    `SELECT id FROM unidade_locais WHERE unidade_id = ? AND ativo = TRUE AND (nome = ? OR codigo = ?) LIMIT 1`,
                    [unidadeId, dados.unidade.trim(), dados.unidade.trim()]
                );
                if (locais.length > 0) {
                    localId = locais[0].id;
                }
            } catch (e) {
                // Tabela pode não existir em ambientes antigos, ignorar
            }
        }

        const [result] = await db.query(
            `INSERT INTO chamados (
                protocolo, categoria, solicitante_nome, nome_whatsapp, telefone_whatsapp,
                setor, ip_maquina, cod_impressora, telefone_contato, email, cpf_solicitante, descricao, status, chat_origem,
                unidade_id, local_id, instancia_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?, ?, ?)`,
            [
                protocolo,
                categoria,
                dados.nome_completo || dados.nome || 'Não informado',
                contato?.pushname || dados.nome_completo || null,
                contato?.number || sessionId.replace(/@.*$/, ''),
                `${dados.unidade || ''} - ${dados.setor || ''}`.trim().replace(/^- |-$/, ''),
                dados.ip || null,
                dados.codigo_impressora || null,
                dados.telefone || null,
                dados.email || null,
                dados.cpf || null,
                descricaoFinal,
                sessionId,
                unidadeId,
                localId,
                instanciaId
            ]
        );

        return { id: result.insertId, protocolo };
    }

    function gerarVariacoesNumero(numeroBruto) {
        let numero = String(numeroBruto || '').replace(/\D/g, '');
        if (!numero) return [];
        if (!numero.startsWith('55')) numero = `55${numero}`;
        const variacoes = [numero];
        // 13 dígitos (com 9): tentar versão sem 9
        if (numero.length === 13) variacoes.push(numero.slice(0, 4) + numero.slice(5));
        // 12 dígitos (sem 9): tentar versão com 9
        if (numero.length === 12) variacoes.push(numero.slice(0, 4) + '9' + numero.slice(4));
        return [...new Set(variacoes)];
    }

    async function resolverIdChat(telefone) {
        const variacoes = gerarVariacoesNumero(telefone);
        for (const numero of variacoes) {
            try {
                const res = await client.getNumberId(numero);
                if (res?._serialized) return res._serialized;
            } catch (e) {
                // continua tentando outras variações
            }
        }
        return null;
    }

    async function notificarTecnicosDaUnidade(chamado, dadosForm) {
        if (!unidadeId) return;
        try {
            // Verificar se a notificação está habilitada nas configurações
            const [configRows] = await db.query(
                "SELECT setting_value FROM system_settings WHERE setting_key = 'notificar_usuarios_novo_chamado'"
            );
            const notificacaoAtiva = configRows.length === 0 || configRows[0].setting_value === 'true';
            if (!notificacaoAtiva) {
                log(`Notificação de novo chamado desativada nas configurações.`);
                return;
            }

            const agora = dayjs();
            const diaSemana = agora.day();
            const horaAtual = agora.format('HH:mm:ss');

            // Buscar técnicos vinculados à unidade QUE ESTÃO EM TURNO AGORA
            const [tecnicos] = await db.query(
                `SELECT DISTINCT a.id, a.username, a.nome_completo, a.telefone
                 FROM admins a
                 INNER JOIN admin_unidades au ON au.admin_id = a.id
                 INNER JOIN user_turnos t ON t.admin_id = a.id
                 WHERE au.unidade_id = ?
                   AND a.ativo = TRUE
                   AND a.nivel_acesso IN ('administrador', 'gerenciador', 'gestor')
                   AND a.telefone IS NOT NULL AND a.telefone != ''
                   AND t.ativo = TRUE
                   AND t.dia_semana = ?
                   AND ? BETWEEN t.hora_inicio AND t.hora_fim`,
                [unidadeId, diaSemana, horaAtual]
            );

            let listaFinal = tecnicos;

            // Se ninguém está em turno, verificar se existem turnos no sistema para essa unidade
            if (listaFinal.length === 0) {
                const [totalTurnos] = await db.query(
                    `SELECT COUNT(*) AS total FROM user_turnos t
                     INNER JOIN admin_unidades au ON au.admin_id = t.admin_id
                     WHERE t.ativo = TRUE AND au.unidade_id = ?`,
                    [unidadeId]
                );

                if (totalTurnos[0].total === 0) {
                    // Nenhum turno configurado para essa unidade — manda para todos
                    const [todos] = await db.query(
                        `SELECT a.id, a.username, a.nome_completo, a.telefone
                         FROM admins a
                         INNER JOIN admin_unidades au ON au.admin_id = a.id
                         WHERE au.unidade_id = ?
                           AND a.ativo = TRUE
                           AND a.nivel_acesso IN ('administrador', 'gerenciador', 'gestor')
                           AND a.telefone IS NOT NULL AND a.telefone != ''`,
                        [unidadeId]
                    );
                    listaFinal = todos;
                    if (listaFinal.length === 0) {
                        log(`Nenhum técnico vinculado à unidade ${unidadeId} para notificar.`);
                        return;
                    }
                    log(`Sem turnos configurados — enviando para ${listaFinal.length} técnicos da unidade.`);
                } else {
                    log(`Nenhum técnico em turno agora (dia ${diaSemana}, ${horaAtual}) — notificação não enviada.`);
                    return;
                }
            }

            const mensagem = [
                `🆕 *NOVO CHAMADO — ${chamado.protocolo}*`,
                ``,
                `📋 *Categoria:* ${chamado.categoria}`,
                `👤 *Solicitante:* ${dadosForm.nome_completo || 'N/I'}`,
                `🏢 *Unidade/Setor:* ${dadosForm.unidade || ''} - ${dadosForm.setor || ''}`,
                `📞 *Contato:* ${dadosForm.telefone || 'N/I'}`,
                dadosForm.email ? `📧 *E-mail:* ${dadosForm.email}` : null,
                dadosForm.cpf ? `🆔 *CPF:* ${dadosForm.cpf}` : null,
                dadosForm.ip ? `💻 *IP:* ${dadosForm.ip}` : null,
                dadosForm.codigo_impressora ? `🖨️ *Código:* ${dadosForm.codigo_impressora}` : null,
                dadosForm.numero_serie ? `🔢 *Nº Série:* ${dadosForm.numero_serie}` : null,
                ``,
                `📝 *Descrição:*`,
                dadosForm.descricao || 'Sem descrição',
                ``,
                `_Acesse o sistema para atender._`
            ].filter(Boolean).join('\n');

            for (const tec of listaFinal) {
                const destino = await resolverIdChat(tec.telefone);
                if (!destino) {
                    log(`Não foi possível resolver número de ${tec.nome_completo || tec.username} (${tec.telefone})`);
                    continue;
                }
                try {
                    await client.sendMessage(destino, mensagem);
                    log(`Notificação enviada para ${tec.nome_completo || tec.username}`);
                } catch (e) {
                    log(`Falha ao notificar ${tec.username}: ${e.message}`);
                }
            }
        } catch (e) {
            log(`Erro ao notificar técnicos: ${e.message}`);
        }
    }

    // ──────────────────────────────────────────────────────────────────
    // HANDLER PRINCIPAL DE MENSAGENS
    // ──────────────────────────────────────────────────────────────────
    const processarMensagem = async (msg) => {
        try {
            const sessionId = msg.from;
            if (!sessionId || sessionId === 'status@broadcast') return;
            if (sessionId.endsWith('@g.us')) return; // ignorar grupos

            // Dedup
            const msgId = msg.id?._serialized || `${msg.from}-${msg.timestamp}`;
            if (mensagensProcessadas.has(msgId)) return;
            mensagensProcessadas.set(msgId, Date.now() + 60_000);
            setTimeout(() => mensagensProcessadas.delete(msgId), 60_000);

            // Bloqueado pós-ticket
            const bloqEat = bloqueados.get(sessionId);
            if (bloqEat && Date.now() < bloqEat) return;

            const texto = String(msg.body || '').trim();
            if (!texto && !msg.hasMedia) return;

            const contato = await msg.getContact().catch(() => ({}));
            const chatId = sessionId;

            // CANCELAR
            if (texto.toUpperCase() === 'CANCELAR') {
                estados.delete(sessionId);
                clearTimeout(inactivityTimers.get(sessionId));
                inactivityTimers.delete(sessionId);
                await client.sendMessage(chatId, '✅ Atendimento cancelado. Envie qualquer mensagem para começar de novo.');
                return;
            }

            const est = estados.get(sessionId);

            const emAvaliacao = est && (est.step === 'avaliacao' || est.step === 'avaliacao_motivo');

            // Chamado em andamento: não encerrar sessão nem voltar ao menu
            if (!emAvaliacao) {
                try {
                    const [chamadosAtivos] = await db.query(
                        `SELECT id, protocolo, status FROM chamados
                         WHERE chat_origem = ? AND status IN ('pendente', 'aberto', 'em_atendimento')
                         ORDER BY criado_em DESC LIMIT 1`,
                        [sessionId]
                    );

                    const chamadoAtivo = chamadosAtivos[0];

                    if (chamadoAtivo) {
                        const tipoMsg = String(msg.type || '').toLowerCase();
                        const ehMidia = msg.hasMedia || ['audio','ptt','video','image','document','sticker'].includes(tipoMsg);

                        // Se for mídia e chamado ainda não está em atendimento, deletar
                        if (ehMidia && chamadoAtivo.status !== 'em_atendimento') {
                            try { await msg.delete(true); } catch (e) {}
                            await client.sendMessage(chatId, '🚫 *Mídia removida.* Você só poderá enviar mídia após um atendente iniciar seu chamado. Aguarde.');
                            return;
                        }

                        // Salvar a mensagem do solicitante no chat_messages
                        const contactName = contato?.pushname || contato?.name || 'Solicitante';
                        let messageType = 'text';
                        let mediaUrl = null, mediaMimeType = null, mediaFilename = null;
                        let mensagemTexto = texto;

                        if (ehMidia) {
                            messageType = tipoMidiaNormalizado(tipoMsg);
                            mensagemTexto = msg.body || `[${messageType}]`;
                            try {
                                const midiaSalva = await salvarMidiaChat(msg, chamadoAtivo.id, tipoMsg, instanciaNome);
                                if (midiaSalva) {
                                    messageType = midiaSalva.messageType;
                                    mediaUrl = midiaSalva.mediaUrl;
                                    mediaMimeType = midiaSalva.mediaMimeType;
                                    mediaFilename = midiaSalva.mediaFilename;
                                }
                            } catch (e) {
                                console.error(`[DynamicFlow:${instanciaNome}] Erro ao salvar mídia do solicitante:`, e.message);
                            }
                        }

                        await db.query(
                            `INSERT INTO chat_messages (
                                chamado_id, remetente_tipo, remetente_nome,
                                mensagem, message_type, media_url, media_mime_type, media_filename
                             ) VALUES (?, 'solicitante', ?, ?, ?, ?, ?, ?)`,
                            [chamadoAtivo.id, contactName, mensagemTexto, messageType, mediaUrl, mediaMimeType, mediaFilename]
                        );

                        console.log(`[DynamicFlow:${instanciaNome}] Mensagem do solicitante salva no chamado ${chamadoAtivo.protocolo}`);
                        estados.delete(sessionId);
                        clearTimeout(inactivityTimers.get(sessionId));
                        inactivityTimers.delete(sessionId);
                        return; // não processa como menu/fluxo
                    }
                } catch (e) {
                    console.error(`[DynamicFlow:${instanciaNome}] Erro ao processar mensagem para chamado ativo:`, e.message);
                }
            }

            // Sem estado: enviar menu
            if (!est) {
                estados.set(sessionId, { step: 'menu' });
                resetInactivityTimer(sessionId, chatId);
                await client.sendMessage(chatId, montarMenuPrincipal());
                return;
            }

            // Bloquear mídia durante fluxo
            if (msg.hasMedia || ['audio','ptt','video','image','document','sticker'].includes(String(msg.type).toLowerCase())) {
                try { await msg.delete(true); } catch (e) {}
                await client.sendMessage(chatId, '🚫 Durante o atendimento, envie somente *texto*.');
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            // ── ETAPA: MENU PRINCIPAL ──
            if (est.step === 'menu') {
                const opcao = flowDefinition.menuPrincipal.opcoes.find(o => o.id === texto);
                if (!opcao) {
                    await client.sendMessage(chatId, '❌ Opção inválida.\n\n' + montarMenuPrincipal());
                    resetInactivityTimer(sessionId, chatId);
                    return;
                }

                est.opcaoMenu = opcao;
                est.categoria = opcao.categoria;

                // Tem submenu?
                if (opcao.submenu) {
                    est.step = 'submenu';
                    est.submenuKey = opcao.submenu;
                    await client.sendMessage(chatId, montarSubmenu(opcao.submenu));
                } else {
                    // Verificar se há perfil salvo antes de iniciar preenchimento
                    const bloco = obterBloco(opcao.camposBloco);
                    est.bloco = bloco;
                    est.dados = {};

                    const telefone = extrairTelefoneDoSession(sessionId);
                    const perfil = blocoTemCamposPessoais(bloco) ? await buscarPerfilPorTelefone(telefone) : null;

                    if (perfil && Object.keys(perfil).length > 0) {
                        est.step = 'confirmar_perfil';
                        est.perfilSalvo = perfil;
                        await client.sendMessage(chatId, `📋 Categoria: *${opcao.label}*\n\n` + montarResumoPerfil(perfil, bloco));
                    } else {
                        est.step = 'preenchimento';
                        est.campoIdx = 0;
                        const primeiroCampo = bloco.campos[0];
                        await client.sendMessage(chatId, `📋 Categoria: *${opcao.label}*\n\nVamos coletar seus dados.\n\n` + montarPromptCampo(primeiroCampo, est));
                    }
                }
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            // ── ETAPA: SUBMENU ──
            if (est.step === 'submenu') {
                const sm = flowDefinition.submenus[est.submenuKey];
                const opcao = sm.opcoes.find(o => o.id === texto);
                if (!opcao) {
                    await client.sendMessage(chatId, '❌ Opção inválida.\n\n' + montarSubmenu(est.submenuKey));
                    resetInactivityTimer(sessionId, chatId);
                    return;
                }

                est.subcategoria = opcao.label;
                const bloco = obterBloco(est.opcaoMenu.camposBloco);
                est.bloco = bloco;
                est.dados = {};

                const telefone = extrairTelefoneDoSession(sessionId);
                const perfil = blocoTemCamposPessoais(bloco) ? await buscarPerfilPorTelefone(telefone) : null;

                if (perfil && Object.keys(perfil).length > 0) {
                    est.step = 'confirmar_perfil';
                    est.perfilSalvo = perfil;
                    await client.sendMessage(chatId, `📋 Sistema: *${opcao.label}*\n\n` + montarResumoPerfil(perfil, bloco));
                } else {
                    est.step = 'preenchimento';
                    est.campoIdx = 0;
                    const primeiroCampo = bloco.campos[0];
                    await client.sendMessage(chatId, `📋 Sistema selecionado: *${opcao.label}*\n\nVamos coletar seus dados.\n\n` + montarPromptCampo(primeiroCampo, est));
                }
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            // ── ETAPA: CONFIRMAR PERFIL SALVO ──
            if (est.step === 'confirmar_perfil') {
                if (texto === '1') {
                    // Reaproveitar dados do perfil
                    est.dados = { ...est.perfilSalvo };
                    est.step = 'preenchimento';
                    const proximo = proximoCampoApolsConfirmacao(est);
                    if (!proximo) {
                        // Não tem campo contextual — finalizar direto
                        await criarChamadoFinal(est, sessionId, contato, chatId);
                        return;
                    }
                    await client.sendMessage(chatId, `✅ Dados confirmados!\n\nAgora preciso só dos dados específicos do chamado.\n\n` + montarPromptCampo(proximo, est));
                    resetInactivityTimer(sessionId, chatId);
                    return;
                }
                if (texto === '2') {
                    // Editar — começar do zero
                    est.dados = {};
                    est.step = 'preenchimento';
                    est.campoIdx = 0;
                    const primeiro = est.bloco.campos[0];
                    await client.sendMessage(chatId, `✏️ Vamos editar seus dados.\n\n` + montarPromptCampo(primeiro, est));
                    resetInactivityTimer(sessionId, chatId);
                    return;
                }
                await client.sendMessage(chatId, '❌ Opção inválida. Digite *1* para confirmar ou *2* para editar.');
                resetInactivityTimer(sessionId, chatId);
                return;
            }

            // ── ETAPA: PREENCHIMENTO DOS CAMPOS ──
            if (est.step === 'preenchimento') {
                const campo = est.bloco.campos[est.campoIdx];
                const respostaPulou = texto === '-' && !campo.obrigatorio;

                if (!respostaPulou) {
                    if (!validarCampo(texto, campo.tipo, campo.opcoes)) {
                        // Mensagem de erro específica por tipo
                        let dica = '';
                        switch (campo.tipo) {
                            case 'cpf':
                                dica = '\n_O CPF deve ter 11 dígitos. Ex: 12345678901_';
                                break;
                            case 'email':
                                dica = '\n_Informe um e-mail válido. Ex: nome@exemplo.com_';
                                break;
                            case 'telefone':
                                dica = '\n_Informe o telefone com DDD. Ex: 6330274488 ou (63) 3027-4488_';
                                break;
                            case 'opcoes':
                                dica = '\n_Digite o número correspondente à opção desejada._';
                                break;
                            case 'texto_longo':
                                dica = '\n_Por favor, descreva com mais detalhes (mínimo 5 caracteres)._';
                                break;
                        }
                        await client.sendMessage(
                            chatId,
                            `❌ Valor inválido para *${labelCampoParaEstado(campo, est)}*.${dica}\n\n` + montarPromptCampo(campo, est)
                        );
                        resetInactivityTimer(sessionId, chatId);
                        return;
                    }
                    // Para tipo "opcoes", salvar o label da opção escolhida ao invés do número
                    if (campo.tipo === 'opcoes' && Array.isArray(campo.opcoes)) {
                        const escolhida = campo.opcoes.find(o => String(o.id) === texto);
                        est.dados[campo.key] = escolhida ? escolhida.label : texto;
                    } else {
                        if (!permiteHospitais && CAMPOS_BLOQUEIO_HOSPITAL.includes(campo.key) && contemHospitalBloqueado(texto)) {
                            await bloquearHospitalEVoltarMenu(sessionId, chatId);
                            return;
                        }

                        // Validação IA para campos de descrição (texto_longo ou key 'descricao')
                        if (campo.tipo === 'texto_longo' || campo.key === 'descricao') {
                            const validacao = await validarDescricao(texto, est.categoria || '');
                            if (!validacao.aprovado) {
                                await client.sendMessage(chatId, validacao.mensagem);
                                resetInactivityTimer(sessionId, chatId);
                                return; // Fica no mesmo campo esperando nova descrição
                            }
                        }
                        est.dados[campo.key] = texto;
                    }
                } else {
                    est.dados[campo.key] = null;
                }

                // Avançar para o próximo campo que ainda não tem valor
                let proximoIdx = est.campoIdx + 1;
                while (proximoIdx < est.bloco.campos.length && est.dados[est.bloco.campos[proximoIdx].key] !== undefined) {
                    proximoIdx += 1;
                }
                est.campoIdx = proximoIdx;

                // Próximo campo
                if (est.campoIdx < est.bloco.campos.length) {
                    const proximo = est.bloco.campos[est.campoIdx];
                    await client.sendMessage(chatId, montarPromptCampo(proximo, est));
                    resetInactivityTimer(sessionId, chatId);
                    return;
                }

                // Fim — criar chamado
                await criarChamadoFinal(est, sessionId, contato, chatId);
                return;
            }

            // ── ETAPA: AVALIAÇÃO ──
            if (est.step === 'avaliacao') {
                const nota = parseInt(texto, 10);
                if (nota >= 1 && nota <= 5) {
                    try {
                        const [r] = await db.query(
                            `INSERT INTO avaliacoes (chamado_id, protocolo, nota, atendente_nome, solicitante_nome, chat_origem)
                             VALUES (?, ?, ?, ?, ?, ?)`,
                            [est.chamadoId, est.protocolo, nota, est.atendenteNome, est.solicitanteNome, sessionId]
                        );
                        const emojis = ['', '😞', '😕', '😐', '😊', '🤩'];
                        await client.sendMessage(chatId, `${emojis[nota]} Obrigado pela avaliação! Sua nota: *${nota}/5*`);

                        if (nota <= 3) {
                            estados.set(sessionId, {
                                step: 'avaliacao_motivo',
                                avaliacaoId: r.insertId,
                                protocolo: est.protocolo
                            });
                            await client.sendMessage(
                                chatId,
                                '📝 Lamentamos que sua experiência não tenha sido boa. *Você gostaria de nos dizer o motivo?*\n\nDigite o motivo ou envie *NAO* para finalizar sem informar.'
                            );
                            return;
                        }
                    } catch (e) {
                        await client.sendMessage(chatId, '✓ Obrigado pelo feedback!');
                    }
                    estados.delete(sessionId);
                } else {
                    await client.sendMessage(chatId, '❌ Envie um número de 1 a 5.');
                }
                return;
            }

            // ── ETAPA: MOTIVO DA AVALIAÇÃO BAIXA ──
            if (est.step === 'avaliacao_motivo') {
                const motivo = texto.trim();
                if (motivo.toUpperCase() === 'NAO' || motivo.toUpperCase() === 'NÃO') {
                    await client.sendMessage(chatId, '✓ Tudo bem! Obrigado pelo feedback.');
                    estados.delete(sessionId);
                    return;
                }
                if (motivo.length < 3) {
                    await client.sendMessage(chatId, '⚠️ Descreva o motivo com mais detalhes ou envie *NAO* para finalizar.');
                    return;
                }
                try {
                    await db.query(`UPDATE avaliacoes SET motivo_usuario = ? WHERE id = ?`, [motivo, est.avaliacaoId]);
                    await client.sendMessage(chatId, '✅ Obrigado! Seu feedback foi registrado e será analisado pela equipe.');
                } catch (e) {
                    await client.sendMessage(chatId, '✓ Obrigado pelo feedback!');
                }
                estados.delete(sessionId);
                return;
            }
        } catch (e) {
            console.error(`[DynamicFlow:${instanciaNome}] Erro no handler:`, e);
        }
    };

    // Fila por sessão: mensagens do mesmo contato são processadas uma de cada vez.
    // Sem isso, duas mensagens enviadas enquanto a validação da descrição (IA) ainda
    // está rodando passam pelo mesmo estado e geram chamados duplicados.
    const filasPorSessao = new Map();
    const onMessage = (msg) => {
        const chave = msg.from || '';
        const anterior = filasPorSessao.get(chave) || Promise.resolve();
        const atual = anterior.then(() => processarMensagem(msg)).catch(() => {});
        filasPorSessao.set(chave, atual);
        atual.then(() => {
            if (filasPorSessao.get(chave) === atual) filasPorSessao.delete(chave);
        });
        return atual;
    };

    client.on('message', onMessage);

    const controller = {
        instanciaId,
        instanciaNome,
        liberarSessao(sessionId) {
            if (!sessionId) return;
            estados.delete(sessionId);
            bloqueados.delete(sessionId);
            clearTimeout(inactivityTimers.get(sessionId));
            inactivityTimers.delete(sessionId);
        },
        // Reabrir fluxo após encerramento (chamado pela rota /encerrar)
        async reiniciarFluxoPorEncerramento(chatOrigem, dadosChamado) {
            try {
                const chatId = chatOrigem;
                if (!chatId) return false;

                // Mensagem de encerramento
                const msgEnc = `✅ *Chamado encerrado.*\n📌 Protocolo: *${dadosChamado.protocolo}*\n👤 Atendente: ${dadosChamado.atendenteNome}\n\nObrigado por utilizar nosso atendimento.`;
                await client.sendMessage(chatId, msgEnc);

                // Se avaliação habilitada, perguntar nota
                if (flowDefinition.avaliacao?.habilitada) {
                    estados.set(chatId, {
                        step: 'avaliacao',
                        chamadoId: dadosChamado.chamadoId,
                        protocolo: dadosChamado.protocolo,
                        atendenteNome: dadosChamado.atendenteNome,
                        solicitanteNome: dadosChamado.nomeExibicao
                    });
                    // pequeno delay
                    await new Promise(r => setTimeout(r, 600));
                    const creditoSistema = '\n\n_Sistema versão 2.3 — Desenvolvido por Erick Vinicius (62) 98101-3083_';
                    const textoAvaliacao = flowDefinition.avaliacao.texto || '';
                    const msgAvaliacao = textoAvaliacao.includes('versão 2.1')
                        ? textoAvaliacao
                        : `${textoAvaliacao}${creditoSistema}`;
                    await client.sendMessage(chatId, msgAvaliacao);
                }
                return true;
            } catch (e) {
                console.error('Erro reiniciarFluxoPorEncerramento:', e);
                return false;
            }
        }
    };

    client[ATTACH_FLAG] = controller;
    return controller;
}

module.exports = { attachDynamicFlow };
