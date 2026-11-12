const { OPCOES_UNIDADE_SESAU, normalizarFluxoSesau } = require('../modules/flow-normalizer');

async function columnExists(connection, tableName, columnName) {
    const [rows] = await connection.query(
        `SELECT 1
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?
         LIMIT 1`,
        [tableName, columnName]
    );

    return rows.length > 0;
}

async function indexExists(connection, tableName, indexName) {
    const [rows] = await connection.query(
        `SELECT 1
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND INDEX_NAME = ?
         LIMIT 1`,
        [tableName, indexName]
    );

    return rows.length > 0;
}

async function foreignKeyExists(connection, tableName, constraintName) {
    const [rows] = await connection.query(
        `SELECT 1
         FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND CONSTRAINT_NAME = ?
           AND CONSTRAINT_TYPE = 'FOREIGN KEY'
         LIMIT 1`,
        [tableName, constraintName]
    );

    return rows.length > 0;
}

async function ensureColumn(connection, tableName, columnName, definition) {
    if (await columnExists(connection, tableName, columnName)) {
        return false;
    }

    await connection.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    return true;
}

async function ensureIndex(connection, tableName, indexName, definition) {
    if (await indexExists(connection, tableName, indexName)) {
        return false;
    }

    await connection.query(`ALTER TABLE ${tableName} ADD ${definition}`);
    return true;
}

async function ensureForeignKey(connection, tableName, constraintName, definition) {
    if (await foreignKeyExists(connection, tableName, constraintName)) {
        return false;
    }

    await connection.query(`ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} ${definition}`);
    return true;
}

function codigoLocalSesau(label) {
    return String(label || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

async function ensureFluxoSesauHospitais(connection) {
    const changes = [];
    const [flows] = await connection.query(`
        SELECT
            f.id,
            f.nome,
            f.definicao_json,
            GROUP_CONCAT(DISTINCT u.codigo SEPARATOR ',') AS unidade_codigos,
            GROUP_CONCAT(DISTINCT u.nome SEPARATOR ',') AS unidade_nomes
        FROM bot_flows_v2 f
        LEFT JOIN instancias i ON i.flow_id = f.id
        LEFT JOIN unidades u ON u.id = i.unidade_id
        WHERE f.ativo = TRUE
        GROUP BY f.id, f.nome, f.definicao_json
    `);

    for (const row of flows) {
        const unidadeCodigos = String(row.unidade_codigos || '').split(',').filter(Boolean);
        const unidadeNomes = String(row.unidade_nomes || '').split(',').filter(Boolean);
        let flow;

        try {
            flow = typeof row.definicao_json === 'string'
                ? JSON.parse(row.definicao_json)
                : row.definicao_json;
        } catch (e) {
            continue;
        }

        const antes = JSON.stringify(flow);
        normalizarFluxoSesau(flow, {
            flowNome: row.nome,
            unidadeCodigos,
            unidadeNomes
        });

        const depois = JSON.stringify(flow);
        if (depois !== antes) {
            await connection.query(
                'UPDATE bot_flows_v2 SET definicao_json = ? WHERE id = ?',
                [depois, row.id]
            );
            changes.push(`bot_flows_v2.${row.id}.sesau_hospitais`);
        }
    }

    const [unidadesSesau] = await connection.query(`
        SELECT id
        FROM unidades
        WHERE ativo = TRUE
          AND (UPPER(codigo) = 'SESAU' OR LOWER(nome) LIKE '%sesau%')
    `);

    for (const unidade of unidadesSesau) {
        for (const opcao of OPCOES_UNIDADE_SESAU) {
            await connection.query(
                `INSERT INTO unidade_locais (unidade_id, nome, codigo, ativo)
                 VALUES (?, ?, ?, TRUE)
                 ON DUPLICATE KEY UPDATE codigo = VALUES(codigo), ativo = TRUE`,
                [unidade.id, opcao.label, codigoLocalSesau(opcao.label)]
            );
        }
    }

    if (unidadesSesau.length > 0) {
        changes.push('unidade_locais.sesau_hospitais');
    }

    return changes;
}

const DEFAULT_CHATBOT_FLOW = {
    name: 'Fluxo Padrão chatbot.js',
    slug: 'chatbot-js-padrao',
    description: 'Representação visual do fluxo atual do chatbot que já está em produção.',
    source_file: 'chatbot.js',
    steps: [
        {
            step_key: 'start',
            title: 'Boas-vindas e menu',
            prompt_text: 'Apresenta a saudação inicial e mostra as opções 1 a 6 com possibilidade de CANCELAR.',
            field_key: 'opcao',
            validation_type: 'menu',
            next_step: '0.5',
            error_message: 'Ignora entradas fora do menu até o usuário escolher uma opção válida.',
            conditions_text: 'Se a mensagem inicial for o gatilho de teste, marca o estado como teste antes de iniciar.',
            action_summary: 'Envia o menu principal com categorias e opção de ramais.',
            sort_order: 1,
            is_terminal: false
        },
        {
            step_key: '0.5',
            title: 'Escolha da categoria',
            prompt_text: 'Recebe a opção escolhida pelo usuário.',
            field_key: 'opcao',
            validation_type: 'categoria',
            next_step: '1',
            error_message: 'Se a opção não existir, o fluxo aguarda nova resposta.',
            conditions_text: 'Se a opção for 6, envia o PDF de ramais e encerra o estado.',
            action_summary: 'Quando a categoria é válida, avança para coleta do nome completo.',
            sort_order: 2,
            is_terminal: false
        },
        {
            step_key: '1',
            title: 'Nome completo',
            prompt_text: '👤 Seu *Nome Completo*:',
            field_key: 'nome',
            validation_type: 'texto',
            next_step: '2',
            error_message: '',
            conditions_text: '',
            action_summary: 'Salva o nome do solicitante e solicita o setor e ala.',
            sort_order: 3,
            is_terminal: false
        },
        {
            step_key: '2',
            title: 'Setor e ala',
            prompt_text: '🏢 Seu *Setor e Ala*:',
            field_key: 'setor',
            validation_type: 'texto',
            next_step: '3',
            error_message: '',
            conditions_text: '',
            action_summary: 'Salva setor/ala e solicita o IP da máquina.',
            sort_order: 4,
            is_terminal: false
        },
        {
            step_key: '3',
            title: 'IP da máquina',
            prompt_text: '💻 *IP da Máquina*:',
            field_key: 'ip',
            validation_type: 'ip',
            next_step: '4',
            error_message: '❌ IP inválido. Tente novamente:',
            conditions_text: 'Se a categoria escolhida for Impressora (2), o próximo passo vira 3.5 para pedir o código da impressora.',
            action_summary: 'Valida o IP e decide se o fluxo segue para o código da impressora ou telefone.',
            sort_order: 5,
            is_terminal: false
        },
        {
            step_key: '3.5',
            title: 'Código da impressora',
            prompt_text: '🖨️ Qual é o *código da impressora*? (Ex: TC1020)',
            field_key: 'codImpressora',
            validation_type: 'texto',
            next_step: '4',
            error_message: '',
            conditions_text: 'Executado somente quando a categoria for Impressora.',
            action_summary: 'Salva o código da impressora e segue para o telefone de contato.',
            sort_order: 6,
            is_terminal: false
        },
        {
            step_key: '4',
            title: 'Telefone de contato',
            prompt_text: '📱 *Telefone* de contato:',
            field_key: 'tel',
            validation_type: 'telefone',
            next_step: '5',
            error_message: '',
            conditions_text: '',
            action_summary: 'Salva o telefone informado e pede a descrição do problema.',
            sort_order: 7,
            is_terminal: false
        },
        {
            step_key: '5',
            title: 'Descrição e fechamento',
            prompt_text: '📝 Descreva o *Problema*:',
            field_key: 'desc',
            validation_type: 'texto-livre',
            next_step: '',
            error_message: '',
            conditions_text: 'Monta o relatório, salva chamado, envia ao técnico da escala e dispara o webhook histórico.',
            action_summary: 'Conclui o fluxo do chamado e limpa o estado do usuário.',
            sort_order: 8,
            is_terminal: true
        }
    ]
};

async function ensureDefaultChatbotFlow(connection) {
    const [existingFlows] = await connection.query(
        'SELECT id FROM chatbot_flows WHERE slug = ? LIMIT 1',
        [DEFAULT_CHATBOT_FLOW.slug]
    );

    let flowId = existingFlows[0]?.id;

    if (!flowId) {
        const [result] = await connection.query(
            `INSERT INTO chatbot_flows (name, slug, description, is_default, is_active, source_file)
             VALUES (?, ?, ?, TRUE, TRUE, ?)`,
            [
                DEFAULT_CHATBOT_FLOW.name,
                DEFAULT_CHATBOT_FLOW.slug,
                DEFAULT_CHATBOT_FLOW.description,
                DEFAULT_CHATBOT_FLOW.source_file
            ]
        );

        flowId = result.insertId;
    }

    const [stepCountRows] = await connection.query(
        'SELECT COUNT(*) AS total FROM chatbot_flow_steps WHERE flow_id = ?',
        [flowId]
    );

    if (stepCountRows[0].total > 0) {
        return false;
    }

    for (const step of DEFAULT_CHATBOT_FLOW.steps) {
        await connection.query(
            `INSERT INTO chatbot_flow_steps (
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
                is_terminal
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                flowId,
                step.step_key,
                step.title,
                step.prompt_text,
                step.field_key,
                step.validation_type,
                step.next_step,
                step.error_message,
                step.conditions_text,
                step.action_summary,
                step.sort_order,
                step.is_terminal
            ]
        );
    }

    return true;
}

async function ensureSchema(connection) {
    const changes = [];

    await connection.query(`
        CREATE TABLE IF NOT EXISTS admins (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            nome_completo VARCHAR(150) NULL,
            cpf VARCHAR(20) UNIQUE NULL,
            telefone VARCHAR(30) NULL,
            nivel_acesso VARCHAR(20) NOT NULL DEFAULT 'administrador',
            password VARCHAR(255) NOT NULL,
            ativo BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_sessions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            session_name VARCHAR(100) UNIQUE NOT NULL,
            is_connected BOOLEAN DEFAULT FALSE,
            qr_code TEXT,
            last_connected TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            session_id INT NOT NULL,
            from_number VARCHAR(50) NOT NULL,
            to_number VARCHAR(50) NOT NULL,
            message_body TEXT,
            message_type VARCHAR(100) DEFAULT 'text',
            is_from_me BOOLEAN DEFAULT FALSE,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_session (session_id),
            INDEX idx_from (from_number),
            INDEX idx_timestamp (timestamp)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS chamados (
            id INT AUTO_INCREMENT PRIMARY KEY,
            protocolo VARCHAR(50) UNIQUE NOT NULL,
            categoria VARCHAR(100) NOT NULL,
            solicitante_nome VARCHAR(150) NOT NULL,
            nome_whatsapp VARCHAR(150) NULL,
            telefone_whatsapp VARCHAR(50) NULL,
            setor VARCHAR(150) NOT NULL,
            ip_maquina VARCHAR(50) NULL,
            telefone_contato VARCHAR(50) NULL,
            descricao TEXT NOT NULL,
            status VARCHAR(20) DEFAULT 'pendente',
            tecnico_nome VARCHAR(150) NULL,
            tecnico_telefone VARCHAR(50) NULL,
            atendente_id INT NULL,
            atendente_nome VARCHAR(255) NULL,
            chat_origem VARCHAR(100) NULL,
            atribuido_em DATETIME NULL,
            iniciado_em TIMESTAMP NULL,
            encerrado_em TIMESTAMP NULL,
            observacoes TEXT NULL,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_chamados_status (status),
            INDEX idx_chamados_tecnico (tecnico_nome),
            INDEX idx_chamados_criado_em (criado_em)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    // Adicionar colunas email e cpf_solicitante se não existirem
    try {
        await connection.query(`ALTER TABLE chamados ADD COLUMN email VARCHAR(150) NULL AFTER telefone_contato`);
    } catch (e) { /* coluna já existe */ }
    try {
        await connection.query(`ALTER TABLE chamados ADD COLUMN cpf_solicitante VARCHAR(20) NULL AFTER email`);
    } catch (e) { /* coluna já existe */ }

    await connection.query(`
        CREATE TABLE IF NOT EXISTS contacts (
            id INT AUTO_INCREMENT PRIMARY KEY,
            phone_number VARCHAR(50) UNIQUE NOT NULL,
            contact_name VARCHAR(255),
            first_message_at TIMESTAMP NULL,
            last_message_at TIMESTAMP NULL,
            message_count INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_phone (phone_number),
            INDEX idx_last_message (last_message_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS escalas (
            id INT AUTO_INCREMENT PRIMARY KEY,
            data_escala DATE NOT NULL,
            admin_id INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_escalas_data_admin (data_escala, admin_id),
            INDEX idx_escalas_admin_id (admin_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS chatbot_flows (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(150) NOT NULL,
            slug VARCHAR(160) NOT NULL,
            description TEXT NULL,
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            source_file VARCHAR(120) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_chatbot_flows_slug (slug)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS chatbot_flow_steps (
            id INT AUTO_INCREMENT PRIMARY KEY,
            flow_id INT NOT NULL,
            step_key VARCHAR(20) NOT NULL,
            title VARCHAR(150) NOT NULL,
            prompt_text TEXT NULL,
            field_key VARCHAR(80) NULL,
            validation_type VARCHAR(50) NULL,
            next_step VARCHAR(20) NULL,
            error_message TEXT NULL,
            conditions_text TEXT NULL,
            action_summary TEXT NULL,
            sort_order INT NOT NULL DEFAULT 0,
            is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_chatbot_flow_step (flow_id, step_key),
            INDEX idx_chatbot_flow_steps_flow_id (flow_id),
            INDEX idx_chatbot_flow_steps_order (flow_id, sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            chamado_id INT NOT NULL,
            remetente_tipo ENUM('solicitante', 'tecnico', 'sistema') NOT NULL,
            remetente_nome VARCHAR(255),
            mensagem TEXT NOT NULL,
            enviada_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            lida BOOLEAN DEFAULT FALSE,
            INDEX idx_chamado (chamado_id),
            INDEX idx_enviada (enviada_em)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    const adminColumns = [
        ['nome_completo', 'VARCHAR(150) NULL AFTER username'],
        ['cpf', 'VARCHAR(20) NULL AFTER nome_completo'],
        ['telefone', 'VARCHAR(30) NULL AFTER cpf'],
        ['nivel_acesso', `VARCHAR(20) NOT NULL DEFAULT 'administrador' AFTER telefone`],
        ['ativo', 'BOOLEAN NOT NULL DEFAULT TRUE AFTER password']
    ];

    for (const [columnName, definition] of adminColumns) {
        if (await ensureColumn(connection, 'admins', columnName, definition)) {
            changes.push(`admins.${columnName}`);
        }
    }

    const chamadoColumns = [
        ['telefone_whatsapp', 'VARCHAR(50) NULL AFTER nome_whatsapp'],
        ['cod_impressora', 'VARCHAR(100) NULL AFTER ip_maquina'],
        ['atendente_id', 'INT NULL AFTER tecnico_telefone'],
        ['atendente_nome', 'VARCHAR(255) NULL AFTER atendente_id'],
        ['iniciado_em', 'TIMESTAMP NULL AFTER atribuido_em'],
        ['encerrado_em', 'TIMESTAMP NULL AFTER iniciado_em'],
        ['observacoes', 'TEXT NULL AFTER encerrado_em']
    ];

    for (const [columnName, definition] of chamadoColumns) {
        if (await ensureColumn(connection, 'chamados', columnName, definition)) {
            changes.push(`chamados.${columnName}`);
        }
    }

    const chatMessageColumns = [
        ['message_type', `VARCHAR(50) NOT NULL DEFAULT 'text' AFTER mensagem`],
        ['media_url', 'VARCHAR(255) NULL AFTER message_type'],
        ['media_mime_type', 'VARCHAR(120) NULL AFTER media_url'],
        ['media_filename', 'VARCHAR(255) NULL AFTER media_mime_type']
    ];

    for (const [columnName, definition] of chatMessageColumns) {
        if (await ensureColumn(connection, 'chat_messages', columnName, definition)) {
            changes.push(`chat_messages.${columnName}`);
        }
    }

    if (await ensureIndex(connection, 'admins', 'idx_admins_cpf', 'UNIQUE INDEX idx_admins_cpf (cpf)')) {
        changes.push('admins.idx_admins_cpf');
    }

    if (await ensureForeignKey(connection, 'messages', 'messages_ibfk_1', 'FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(id) ON DELETE CASCADE')) {
        changes.push('messages.messages_ibfk_1');
    }

    if (await ensureForeignKey(connection, 'chamados', 'chamados_ibfk_2', 'FOREIGN KEY (atendente_id) REFERENCES admins(id) ON DELETE SET NULL')) {
        changes.push('chamados.chamados_ibfk_2');
    }

    if (await ensureForeignKey(connection, 'chat_messages', 'fk_chat_chamado', 'FOREIGN KEY (chamado_id) REFERENCES chamados(id) ON DELETE CASCADE')) {
        changes.push('chat_messages.fk_chat_chamado');
    }

    if (await ensureForeignKey(connection, 'escalas', 'fk_escalas_admin', 'FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE')) {
        changes.push('escalas.fk_escalas_admin');
    }

    if (await ensureForeignKey(connection, 'chatbot_flow_steps', 'fk_chatbot_flow_steps_flow', 'FOREIGN KEY (flow_id) REFERENCES chatbot_flows(id) ON DELETE CASCADE')) {
        changes.push('chatbot_flow_steps.fk_chatbot_flow_steps_flow');
    }

    if (await ensureDefaultChatbotFlow(connection)) {
        changes.push('chatbot_flows.default_seed');
    }

    await connection.query(`
        ALTER TABLE messages
        MODIFY COLUMN message_type VARCHAR(100) DEFAULT 'text'
    `);

    // 'triagem' e 'devolvido' atendem a fila centralizada (ver migration 015).
    // Só são usados por unidades com triagem_centralizada = TRUE.
    await connection.query(`
        ALTER TABLE chamados
        MODIFY COLUMN status ENUM('triagem', 'pendente', 'aberto', 'em_atendimento', 'finalizado', 'devolvido') DEFAULT 'pendente'
    `);

    await connection.query(`
        UPDATE admins
        SET nome_completo = COALESCE(NULLIF(nome_completo, ''), 'Administrador'),
            nivel_acesso = COALESCE(NULLIF(nivel_acesso, ''), 'administrador'),
            ativo = COALESCE(ativo, TRUE)
        WHERE username = 'admin'
    `);

    // ── Tabelas multi-instância (unidades, fluxos, instâncias) ──
    await connection.query(`
        CREATE TABLE IF NOT EXISTS unidades (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nome VARCHAR(150) NOT NULL,
            codigo VARCHAR(50) NOT NULL UNIQUE,
            descricao TEXT NULL,
            cor VARCHAR(20) DEFAULT '#25d366',
            ativo BOOLEAN DEFAULT TRUE,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_unidades_codigo (codigo),
            INDEX idx_unidades_ativo (ativo)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS bot_flows_v2 (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nome VARCHAR(150) NOT NULL,
            descricao TEXT NULL,
            definicao_json LONGTEXT NOT NULL,
            is_default BOOLEAN DEFAULT FALSE,
            ativo BOOLEAN DEFAULT TRUE,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_flows_v2_ativo (ativo)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS instancias (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nome VARCHAR(150) NOT NULL,
            session_name VARCHAR(100) NOT NULL UNIQUE,
            unidade_id INT NULL,
            flow_id INT NULL,
            status ENUM('disconnected','connecting','qr_ready','connected','error') DEFAULT 'disconnected',
            qr_code TEXT NULL,
            last_error TEXT NULL,
            last_connected TIMESTAMP NULL,
            is_legacy BOOLEAN DEFAULT FALSE,
            ativo BOOLEAN DEFAULT TRUE,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (unidade_id) REFERENCES unidades(id) ON DELETE SET NULL,
            FOREIGN KEY (flow_id) REFERENCES bot_flows_v2(id) ON DELETE SET NULL,
            INDEX idx_instancias_status (status),
            INDEX idx_instancias_session (session_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS admin_unidades (
            admin_id INT NOT NULL,
            unidade_id INT NOT NULL,
            PRIMARY KEY (admin_id, unidade_id),
            FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
            FOREIGN KEY (unidade_id) REFERENCES unidades(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS system_settings (
            setting_key VARCHAR(100) PRIMARY KEY,
            setting_value TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    await connection.query(`
        INSERT IGNORE INTO system_settings (setting_key, setting_value)
        VALUES ('notificar_usuarios_novo_chamado', 'true')
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS user_turnos (
            id INT AUTO_INCREMENT PRIMARY KEY,
            admin_id INT NOT NULL,
            dia_semana TINYINT NOT NULL COMMENT '0=Dom, 1=Seg, 2=Ter, 3=Qua, 4=Qui, 5=Sex, 6=Sab',
            hora_inicio TIME NOT NULL DEFAULT '07:00:00',
            hora_fim TIME NOT NULL DEFAULT '19:00:00',
            ativo BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_admin_dia (admin_id, dia_semana),
            FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    // Tabela de presets de turnos por unidade (cada unidade pode ter seus próprios horários)
    await connection.query(`
        CREATE TABLE IF NOT EXISTS unidade_turnos_presets (
            id INT AUTO_INCREMENT PRIMARY KEY,
            unidade_id INT NOT NULL,
            chave VARCHAR(50) NOT NULL,
            label VARCHAR(100) NOT NULL,
            icone VARCHAR(20) DEFAULT '🕐',
            hora_inicio TIME NOT NULL,
            hora_fim TIME NOT NULL,
            ordem INT DEFAULT 0,
            ativo BOOLEAN DEFAULT TRUE,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_unidade_chave (unidade_id, chave),
            INDEX idx_presets_unidade (unidade_id),
            FOREIGN KEY (unidade_id) REFERENCES unidades(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    // Popular presets default para unidades existentes que ainda não têm
    try {
        const [unidades] = await connection.query('SELECT id, codigo FROM unidades');
        for (const u of unidades) {
            const [existing] = await connection.query(
                'SELECT COUNT(*) as total FROM unidade_turnos_presets WHERE unidade_id = ?',
                [u.id]
            );
            if (existing[0].total > 0) continue;

            const codigo = String(u.codigo || '').toUpperCase();
            let presets;

            if (codigo === 'SESAU') {
                presets = [
                    { chave: 'manha',    label: 'Manhã (08:00-14:00)',    icone: '☀️', hora_inicio: '08:00:00', hora_fim: '14:00:00', ordem: 1 },
                    { chave: 'tarde',    label: 'Tarde (13:00-18:00)',    icone: '🌤️', hora_inicio: '13:00:00', hora_fim: '18:00:00', ordem: 2 },
                    { chave: 'integral', label: 'Integral (08:00-18:00)', icone: '🌅', hora_inicio: '08:00:00', hora_fim: '18:00:00', ordem: 3 }
                ];
            } else {
                // Default (HGP e demais)
                presets = [
                    { chave: 'dia',   label: 'Dia (07:00-19:00)',     icone: '🌅', hora_inicio: '07:00:00', hora_fim: '19:00:00', ordem: 1 },
                    { chave: 'manha', label: 'Manhã (07:00-11:59)',   icone: '☀️', hora_inicio: '07:00:00', hora_fim: '11:59:00', ordem: 2 },
                    { chave: 'tarde', label: 'Tarde (12:00-18:00)',   icone: '🌤️', hora_inicio: '12:00:00', hora_fim: '18:00:00', ordem: 3 },
                    { chave: 'noite', label: 'Noite (18:01-23:00)',   icone: '🌙', hora_inicio: '18:01:00', hora_fim: '23:00:00', ordem: 4 }
                ];
            }

            for (const p of presets) {
                await connection.query(
                    `INSERT IGNORE INTO unidade_turnos_presets
                     (unidade_id, chave, label, icone, hora_inicio, hora_fim, ordem, ativo)
                     VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
                    [u.id, p.chave, p.label, p.icone, p.hora_inicio, p.hora_fim, p.ordem]
                );
            }
        }
    } catch (err) {
        console.error('Erro ao popular presets de turnos:', err.message);
    }

    await connection.query(`
        CREATE TABLE IF NOT EXISTS avaliacoes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            chamado_id INT NOT NULL,
            protocolo VARCHAR(50) NOT NULL,
            nota TINYINT NOT NULL COMMENT '1 a 5',
            motivo_usuario TEXT NULL,
            resposta_tecnico TEXT NULL,
            atendente_nome VARCHAR(255) NULL,
            solicitante_nome VARCHAR(150) NULL,
            chat_origem VARCHAR(100) NULL,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_avaliacoes_chamado (chamado_id),
            INDEX idx_avaliacoes_nota (nota),
            FOREIGN KEY (chamado_id) REFERENCES chamados(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

    // Garantir colunas de motivo/resposta nas avaliações (tabelas existentes)
    if (await ensureColumn(connection, 'avaliacoes', 'motivo_usuario', 'TEXT NULL AFTER nota')) {
        changes.push('avaliacoes.motivo_usuario');
    }
    if (await ensureColumn(connection, 'avaliacoes', 'resposta_tecnico', 'TEXT NULL AFTER motivo_usuario')) {
        changes.push('avaliacoes.resposta_tecnico');
    }

    // Tabela de locais (sub-unidades) por unidade
    await connection.query(`
        CREATE TABLE IF NOT EXISTS unidade_locais (
            id INT AUTO_INCREMENT PRIMARY KEY,
            unidade_id INT NOT NULL,
            nome VARCHAR(150) NOT NULL,
            codigo VARCHAR(50) NULL,
            ativo BOOLEAN DEFAULT TRUE,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uk_unidade_local (unidade_id, nome),
            INDEX idx_locais_unidade (unidade_id),
            FOREIGN KEY (unidade_id) REFERENCES unidades(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Vínculo admin <-> locais
    await connection.query(`
        CREATE TABLE IF NOT EXISTS admin_locais (
            admin_id INT NOT NULL,
            local_id INT NOT NULL,
            PRIMARY KEY (admin_id, local_id),
            FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
            FOREIGN KEY (local_id) REFERENCES unidade_locais(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Adicionar local_id na tabela chamados
    try {
        await connection.query(`ALTER TABLE chamados ADD COLUMN local_id INT NULL AFTER unidade_id, ADD INDEX idx_chamados_local (local_id)`);
    } catch (e) { /* coluna já existe */ }

    // ── Fila centralizada com triagem (migration 015) ──
    // Ligada por unidade. Default FALSE: unidades existentes (HGP) seguem
    // o fluxo atual, sem triagem.
    if (await ensureColumn(connection, 'unidades', 'triagem_centralizada',
        'BOOLEAN NOT NULL DEFAULT FALSE AFTER ativo')) {
        changes.push('unidades.triagem_centralizada');
    }

    // local_id = local de origem (preenchido pelo bot)
    // fila_local_id = fila de destino, definida na triagem
    if (await ensureColumn(connection, 'chamados', 'fila_local_id', 'INT NULL AFTER local_id')) {
        changes.push('chamados.fila_local_id');
        // Chamados anteriores à triagem: a fila atual é o próprio local de origem
        await connection.query('UPDATE chamados SET fila_local_id = local_id WHERE local_id IS NOT NULL');
    }
    if (await ensureIndex(connection, 'chamados', 'idx_chamados_fila', 'INDEX idx_chamados_fila (fila_local_id)')) {
        changes.push('chamados.idx_chamados_fila');
    }

    for (const [coluna, definicao] of [
        ['validado_em', 'DATETIME NULL AFTER fila_local_id'],
        ['validado_por', 'INT NULL AFTER validado_em'],
        ['validado_por_nome', 'VARCHAR(255) NULL AFTER validado_por'],
        ['motivo_devolucao', 'TEXT NULL AFTER validado_por_nome']
    ]) {
        if (await ensureColumn(connection, 'chamados', coluna, definicao)) {
            changes.push(`chamados.${coluna}`);
        }
    }

    // Técnico responsável principal x apoio dentro da fila
    if (await ensureColumn(connection, 'admin_locais', 'papel',
        `ENUM('responsavel','apoio') NOT NULL DEFAULT 'apoio'`)) {
        changes.push('admin_locais.papel');
    }

    await connection.query(`
        CREATE TABLE IF NOT EXISTS chamado_historico (
            id INT AUTO_INCREMENT PRIMARY KEY,
            chamado_id INT NOT NULL,
            acao VARCHAR(40) NOT NULL,
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS hgp_terceirizados (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nome VARCHAR(150) NOT NULL,
            telefone VARCHAR(20) NOT NULL,
            observacao VARCHAR(255) NULL,
            ativo BOOLEAN DEFAULT TRUE,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_hgp_terc_tel (telefone)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS hgp_terceirizado_mensagens (
            id INT AUTO_INCREMENT PRIMARY KEY,
            terceirizado_id INT NOT NULL,
            direcao ENUM('entrada', 'saida') NOT NULL,
            mensagem TEXT NULL,
            message_type VARCHAR(30) DEFAULT 'text',
            media_url VARCHAR(255) NULL,
            media_mime_type VARCHAR(120) NULL,
            media_filename VARCHAR(255) NULL,
            lida BOOLEAN DEFAULT FALSE,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_hgp_terc_msg (terceirizado_id, id),
            FOREIGN KEY (terceirizado_id) REFERENCES hgp_terceirizados(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await connection.query(`
        INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES
        ('hgp_boas_vindas_ativa', 'false'),
        ('hgp_boas_vindas_arquivo', ''),
        ('hgp_boas_vindas_legenda', '')
    `);

    try {
        changes.push(...await ensureFluxoSesauHospitais(connection));
    } catch (e) {
        console.error('Erro ao atualizar Fluxo SESAU para hospitais:', e.message);
    }

    return changes;
}

module.exports = { ensureSchema };
