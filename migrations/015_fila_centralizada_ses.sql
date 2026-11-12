-- ═══════════════════════════════════════════════════════════════════
-- Migration 015: Fila centralizada com triagem (exclusivo SES)
--
-- Modelo: todo chamado da unidade com triagem_centralizada entra na
-- fila central (status 'triagem', fila_local_id NULL). A equipe central
-- valida e atribui a fila de destino (fila_local_id), só então o
-- chamado fica visível para os técnicos daquela fila.
--
-- ISOLAMENTO: o comportamento é ligado por unidade via
-- unidades.triagem_centralizada (default FALSE). O HGP continua no
-- fluxo atual sem nenhuma alteração de estado.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Flag de ativação por unidade ──────────────────────────────
SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'unidades' AND COLUMN_NAME = 'triagem_centralizada');
SET @sql = IF(@col = 0,
    'ALTER TABLE unidades ADD COLUMN triagem_centralizada BOOLEAN NOT NULL DEFAULT FALSE COMMENT "Chamados entram na fila central antes de ir para as filas de destino" AFTER ativo',
    'SELECT "unidades.triagem_centralizada ja existe"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2. Novos status: triagem (aguardando validacao) e devolvido ──
ALTER TABLE chamados
MODIFY COLUMN status ENUM('triagem','pendente','aberto','em_atendimento','finalizado','devolvido')
DEFAULT 'pendente';

-- ── 3. Fila atual (destino) — separada do local de origem ────────
-- local_id      = onde o solicitante esta (preenchido pelo bot)
-- fila_local_id = fila responsavel pelo atendimento (definida na triagem)
SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chamados' AND COLUMN_NAME = 'fila_local_id');
SET @sql = IF(@col = 0,
    'ALTER TABLE chamados ADD COLUMN fila_local_id INT NULL COMMENT "Fila de destino definida na triagem" AFTER local_id, ADD INDEX idx_chamados_fila (fila_local_id)',
    'SELECT "chamados.fila_local_id ja existe"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 4. Rastro da validacao ───────────────────────────────────────
SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chamados' AND COLUMN_NAME = 'validado_em');
SET @sql = IF(@col = 0,
    'ALTER TABLE chamados ADD COLUMN validado_em DATETIME NULL AFTER fila_local_id, ADD COLUMN validado_por INT NULL AFTER validado_em, ADD COLUMN validado_por_nome VARCHAR(255) NULL AFTER validado_por, ADD COLUMN motivo_devolucao TEXT NULL AFTER validado_por_nome',
    'SELECT "chamados.validado_em ja existe"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 5. Papel do tecnico na fila (responsavel principal x apoio) ──
SET @col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_locais' AND COLUMN_NAME = 'papel');
SET @sql = IF(@col = 0,
    'ALTER TABLE admin_locais ADD COLUMN papel ENUM("responsavel","apoio") NOT NULL DEFAULT "apoio" COMMENT "responsavel = tecnico principal da fila"',
    'SELECT "admin_locais.papel ja existe"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 6. Historico/auditoria de movimentacoes ──────────────────────
CREATE TABLE IF NOT EXISTS chamado_historico (
    id INT AUTO_INCREMENT PRIMARY KEY,
    chamado_id INT NOT NULL,
    acao VARCHAR(40) NOT NULL COMMENT 'criado|validado|devolvido|fila_alterada|atribuido|transferido|status_alterado|encerrado|reaberto',
    de_valor VARCHAR(255) NULL,
    para_valor VARCHAR(255) NULL,
    observacao TEXT NULL,
    admin_id INT NULL,
    admin_nome VARCHAR(255) NULL,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_hist_chamado (chamado_id),
    INDEX idx_hist_acao (acao),
    INDEX idx_hist_criado (criado_em),
    FOREIGN KEY (chamado_id) REFERENCES chamados(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 7. Backfill: chamados que ja existem nao entram em triagem ───
-- Mantem a operacao atual intacta (HGP e os 4 chamados SES ja criados):
-- a fila atual passa a ser o proprio local de origem.
UPDATE chamados SET fila_local_id = local_id
WHERE fila_local_id IS NULL AND local_id IS NOT NULL;

-- ── 8. Ligar a triagem centralizada SOMENTE na SES ───────────────
UPDATE unidades SET triagem_centralizada = TRUE WHERE codigo = 'SESAU';
