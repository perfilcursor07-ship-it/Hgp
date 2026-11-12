// ══════════════════════════════════════════════════════════════════════
// Fila centralizada com triagem — exclusivo das unidades que optarem
//
// Modelo: na unidade com triagem_centralizada = TRUE, todo chamado novo
// entra na FILA CENTRAL (status 'triagem', fila_local_id NULL). A equipe
// central valida e define a fila de destino; só então o chamado aparece
// para os técnicos daquela fila.
//
// ISOLAMENTO: a flag é por unidade e o default é FALSE. O HGP (e qualquer
// unidade futura) continua no fluxo atual — nada aqui altera o
// comportamento de quem está com a flag desligada.
// ══════════════════════════════════════════════════════════════════════

const db = require('../config/database');

const STATUS_TRIAGEM = 'triagem';
const STATUS_DEVOLVIDO = 'devolvido';

// Cache curto da flag: evita um SELECT por mensagem do bot
const TTL_CACHE_MS = 60_000;
const cacheFlag = new Map(); // unidade_id -> { valor, expiraEm }

function invalidarCacheTriagem(unidadeId = null) {
    if (unidadeId === null) cacheFlag.clear();
    else cacheFlag.delete(Number(unidadeId));
}

async function unidadeTemTriagem(unidadeId) {
    const id = Number(unidadeId);
    if (!Number.isInteger(id) || id <= 0) return false;

    const emCache = cacheFlag.get(id);
    if (emCache && emCache.expiraEm > Date.now()) return emCache.valor;

    let valor = false;
    try {
        const [rows] = await db.query(
            'SELECT triagem_centralizada FROM unidades WHERE id = ? LIMIT 1',
            [id]
        );
        valor = rows.length > 0 && Boolean(Number(rows[0].triagem_centralizada));
    } catch (e) {
        // Coluna ausente (banco anterior à migration 015): sem triagem
        valor = false;
    }

    cacheFlag.set(id, { valor, expiraEm: Date.now() + TTL_CACHE_MS });
    return valor;
}

// Status inicial do chamado conforme a unidade de origem.
// Unidade sem triagem -> 'pendente' (comportamento atual, inalterado).
async function statusInicialChamado(unidadeId) {
    return (await unidadeTemTriagem(unidadeId)) ? STATUS_TRIAGEM : 'pendente';
}

// Registra uma movimentação no histórico do chamado.
// Nunca propaga erro: auditoria não pode derrubar a operação principal.
async function registrarHistorico({
    chamadoId,
    acao,
    de = null,
    para = null,
    observacao = null,
    adminId = null,
    adminNome = null
}) {
    const id = Number(chamadoId);
    if (!Number.isInteger(id) || id <= 0 || !acao) return false;

    try {
        await db.query(
            `INSERT INTO chamado_historico
             (chamado_id, acao, de_valor, para_valor, observacao, admin_id, admin_nome)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
                String(acao).slice(0, 40),
                de === null || de === undefined ? null : String(de).slice(0, 255),
                para === null || para === undefined ? null : String(para).slice(0, 255),
                observacao || null,
                Number.isInteger(Number(adminId)) && Number(adminId) > 0 ? Number(adminId) : null,
                adminNome ? String(adminNome).slice(0, 255) : null
            ]
        );
        return true;
    } catch (e) {
        console.error(`[historico] falha ao registrar "${acao}" no chamado ${id}:`, e.message);
        return false;
    }
}

// Equipe central de triagem de uma unidade: técnicos vinculados à unidade
// que NÃO estão restritos a uma fila específica (sem vínculo em
// admin_locais). Mesma semântica de escopo já usada no painel.
async function tecnicosDaFilaCentral(unidadeId) {
    const [rows] = await db.query(
        `SELECT a.id, a.username, a.nome_completo, a.telefone
         FROM admins a
         INNER JOIN admin_unidades au ON au.admin_id = a.id
         WHERE au.unidade_id = ?
           AND a.ativo = TRUE
           AND a.nivel_acesso IN ('administrador', 'gerenciador', 'gestor')
           AND a.telefone IS NOT NULL AND a.telefone <> ''
           AND NOT EXISTS (SELECT 1 FROM admin_locais al WHERE al.admin_id = a.id)`,
        [unidadeId]
    );
    return rows;
}

// Técnicos de uma fila (local), responsável principal primeiro.
async function tecnicosDaFila(localId) {
    const [rows] = await db.query(
        `SELECT a.id, a.username, a.nome_completo, a.telefone, al.papel
         FROM admins a
         INNER JOIN admin_locais al ON al.admin_id = a.id
         WHERE al.local_id = ?
           AND a.ativo = TRUE
           AND a.nivel_acesso IN ('administrador', 'gerenciador', 'gestor')
         ORDER BY al.papel = 'responsavel' DESC, a.nome_completo`,
        [localId]
    );
    return rows;
}

module.exports = {
    STATUS_TRIAGEM,
    STATUS_DEVOLVIDO,
    unidadeTemTriagem,
    invalidarCacheTriagem,
    statusInicialChamado,
    registrarHistorico,
    tecnicosDaFilaCentral,
    tecnicosDaFila
};
