// Camada de acesso ao Supabase.
//
// - Login por usuário + senha (Supabase Auth com e-mail interno).
// - Funciona offline: toda gravação entra numa fila guardada no aparelho e é
//   enviada automaticamente quando houver conexão. Consultas usam um cache local
//   quando não há internet.
// - O cálculo de consumo (antigo Code.gs do Apps Script) roda aqui, com o mesmo
//   formato de resposta ({ sucesso, resumo, blocos, totalLitrosMil, ... }).
(function() {
    const cfg = window.SUPABASE_CONFIG || {};
    const sb = window.supabase.createClient(cfg.url, cfg.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: 'irrigacao-auth' }
    });

    const K = {
        usuario: 'irrigacao_usuario',
        ultimoUsuario: 'irrigacao_ultimo_usuario',
        fila: 'irrigacao_fila_sync',
        falhas: 'irrigacao_falhas_sync',
        cache: nome => 'irrigacao_cache_' + nome
    };

    // ------------------------------------------------------------
    // Utilidades
    // ------------------------------------------------------------
    function ler(chave, padrao) {
        try { const v = localStorage.getItem(chave); return v ? JSON.parse(v) : padrao; } catch (e) { return padrao; }
    }
    function gravar(chave, valor) {
        try { localStorage.setItem(chave, JSON.stringify(valor)); } catch (e) { console.error("Erro ao salvar no aparelho:", e); }
    }

    function novoId() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    // Data atual no fuso GMT-3 (mesmo fuso usado no Apps Script)
    function hojeGmt3() {
        const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dia = String(d.getUTCDate()).padStart(2, '0');
        return { iso: `${y}-${m}-${dia}`, br: `${dia}/${m}/${y}` };
    }

    // "yyyy-MM-dd" -> "dd/MM/yyyy"
    function isoParaBr(iso) {
        if (!iso) return "";
        const [y, m, d] = String(iso).split('-');
        return `${d}/${m}/${y}`;
    }

    function limparNomeBloco(nome) {
        return String(nome || "").toUpperCase().replace("BLOCO", "").trim();
    }

    // Erro do Supabase -> Error com status (status 0 = sem conexão)
    function erroSupabase(resposta) {
        const e = new Error(resposta.error.message || 'Erro desconhecido');
        e.status = resposta.status || 0;
        e.code = resposta.error.code;
        return e;
    }

    // ------------------------------------------------------------
    // Usuário / login
    // ------------------------------------------------------------
    let sessaoExpirada = false;

    function usuarioAtual() { return ler(K.usuario, null); }
    function isGestor() { const u = usuarioAtual(); return !!u && u.papel === 'gestor'; }
    // Único gestor que pode gerenciar usuários
    function isAdmin() { const u = usuarioAtual(); return isGestor() && u.administrador === true; }
    function nomeUsuario(u) { u = u || usuarioAtual(); return u ? (u.nome_curto || u.nome) : ''; }

    async function login(usuario, senha) {
        const login = String(usuario || '').trim().toLowerCase();
        const email = login.includes('@') ? login : login + '@' + (cfg.emailDominio || 'spgoasis.local');

        const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
        if (error) {
            if (!navigator.onLine || error.status === 0 || /fetch/i.test(error.message)) {
                throw new Error("Sem conexão. O primeiro acesso de cada usuário precisa de internet.");
            }
            throw new Error(/invalid/i.test(error.message) ? "Usuário ou senha incorretos." : error.message);
        }

        const resp = await sb.from('perfis').select('*').eq('id', data.user.id).maybeSingle();
        if (resp.error || !resp.data || !resp.data.ativo) {
            await sb.auth.signOut({ scope: 'local' });
            throw new Error(resp.data && !resp.data.ativo
                ? "Usuário desativado. Fale com o gestor."
                : "Usuário sem perfil cadastrado. Fale com o gestor.");
        }

        const trocouDeUsuario = localStorage.getItem(K.ultimoUsuario) !== resp.data.id;
        localStorage.setItem(K.ultimoUsuario, resp.data.id);
        gravar(K.usuario, resp.data);
        sessaoExpirada = false;
        emitir();
        agendarSync();
        return { perfil: resp.data, trocouDeUsuario };
    }

    async function logout() {
        await encerrarSessao();
        try { await sb.auth.signOut({ scope: 'local' }); } catch (e) {}
        localStorage.removeItem(K.usuario);
        sessaoExpirada = false;
        emitir();
    }

    // Atualiza papel/nome do usuário logado (pode ter sido alterado pelo gestor).
    // Devolve null se o acesso foi desativado (o perfil deixa de ser visível).
    async function atualizarPerfil() {
        const u = usuarioAtual();
        if (!u || !navigator.onLine) return u;
        const { data: sessao } = await sb.auth.getSession();
        if (!sessao.session) return u;
        const resp = await sb.from('perfis').select('*').eq('id', u.id).maybeSingle();
        if (resp.error) return u;
        if (!resp.data || !resp.data.ativo) {
            await logout();
            return null;
        }
        gravar(K.usuario, resp.data);
        emitir();
        return resp.data;
    }

    // ------------------------------------------------------------
    // Fila de sincronização (offline)
    // ------------------------------------------------------------
    let sincronizando = false;
    let opEmAndamento = null;
    let timerSync = null;
    const ouvintes = [];

    function status() {
        const u = usuarioAtual();
        const fila = ler(K.fila, []);
        return {
            online: navigator.onLine,
            sincronizando,
            sessaoExpirada,
            pendentes: u ? fila.filter(op => op.usuarioId === u.id).length : fila.length,
            falhas: ler(K.falhas, []).length
        };
    }

    function onStatus(cb) { ouvintes.push(cb); cb(status()); }
    function emitir() { const s = status(); ouvintes.forEach(cb => { try { cb(s); } catch (e) {} }); }

    function enfileirar(tabela, tipo, dados) {
        const u = usuarioAtual();
        if (!u) throw new Error("Faça login para salvar.");
        const fila = ler(K.fila, []);

        // Junta alterações seguidas do mesmo item que ainda não foram enviadas
        if (tipo === 'upsert') {
            const existente = fila.find(op => op.tabela === tabela && op.tipo === 'upsert' && op.usuarioId === u.id
                && op.dados.id === dados.id && op.opId !== opEmAndamento);
            if (existente) {
                existente.dados = Object.assign({}, existente.dados, dados);
                gravar(K.fila, fila);
                emitir();
                agendarSync();
                return;
            }
        }

        fila.push({ opId: novoId(), usuarioId: u.id, tabela, tipo, dados, criadoEm: new Date().toISOString(), tentativas: 0 });
        gravar(K.fila, fila);
        emitir();
        agendarSync();
    }

    function pendentesDe(tabela) {
        const u = usuarioAtual();
        return ler(K.fila, []).filter(op => op.tabela === tabela && (!u || op.usuarioId === u.id));
    }

    // Aplica as gravações ainda não enviadas sobre uma lista vinda do servidor/cache
    function mesclarPendentes(tabela, lista) {
        const porId = new Map((lista || []).map(item => [String(item.id), Object.assign({}, item)]));
        pendentesDe(tabela).forEach(op => {
            const id = String(op.dados.id);
            if (op.tipo === 'upsert') porId.set(id, Object.assign({}, porId.get(id) || {}, op.dados, { _pendente: true }));
            else if (op.tipo === 'update' && porId.has(id)) porId.set(id, Object.assign({}, porId.get(id), op.dados.valores, { _pendente: true }));
            else if (op.tipo === 'delete') porId.delete(id);
        });
        return Array.from(porId.values());
    }

    function removerOp(opId) {
        gravar(K.fila, ler(K.fila, []).filter(op => op.opId !== opId));
    }

    function registrarFalha(op, erro) {
        const fila = ler(K.fila, []);
        const item = fila.find(o => o.opId === op.opId);
        if (!item) return;
        item.tentativas = (item.tentativas || 0) + 1;
        item.erro = erro.message;
        if (item.tentativas >= 3) {
            // Depois de 3 recusas do servidor, tira da fila para não travar o resto
            const falhas = ler(K.falhas, []);
            falhas.push(item);
            gravar(K.falhas, falhas);
            gravar(K.fila, fila.filter(o => o.opId !== op.opId));
            console.error("Gravação recusada pelo servidor:", item);
        } else {
            gravar(K.fila, fila);
        }
    }

    async function executar(op) {
        let consulta;
        if (op.tipo === 'upsert') consulta = sb.from(op.tabela).upsert(op.dados, { onConflict: 'id' });
        else if (op.tipo === 'update') consulta = sb.from(op.tabela).update(op.dados.valores).eq('id', op.dados.id);
        else if (op.tipo === 'delete') consulta = sb.from(op.tabela).delete().eq('id', op.dados.id);
        else throw new Error("Operação desconhecida: " + op.tipo);
        const resp = await consulta;
        if (resp.error) throw erroSupabase(resp);
    }

    async function sincronizar() {
        const u = usuarioAtual();
        if (!u || sincronizando || !navigator.onLine) { emitir(); return; }

        sincronizando = true;
        emitir();
        try {
            const { data } = await sb.auth.getSession();
            if (!data.session || data.session.user.id !== u.id) {
                sessaoExpirada = true;
                return;
            }

            const fila = ler(K.fila, []).filter(op => op.usuarioId === u.id);
            for (const op of fila) {
                opEmAndamento = op.opId;
                try {
                    // Relê a operação: pode ter sido mesclada com uma alteração mais nova
                    const atual = ler(K.fila, []).find(o => o.opId === op.opId);
                    if (!atual) continue;
                    await executar(atual);
                    removerOp(op.opId);
                } catch (e) {
                    if (!e.status) break;                                       // sem conexão: tenta depois
                    if (e.status === 401) { await sb.auth.refreshSession(); break; } // token vencido
                    registrarFalha(op, e);
                } finally {
                    opEmAndamento = null;
                    emitir();
                }
            }
        } catch (e) {
            console.error("Erro na sincronização:", e);
        } finally {
            sincronizando = false;
            emitir();
        }
    }

    function agendarSync() {
        clearTimeout(timerSync);
        timerSync = setTimeout(sincronizar, 400);
    }

    window.addEventListener('online', () => { emitir(); sincronizar(); });
    window.addEventListener('offline', emitir);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sincronizar(); });
    setInterval(sincronizar, 60 * 1000);

    // ------------------------------------------------------------
    // Cache de consultas
    // ------------------------------------------------------------
    // Busca no servidor quando possível (respeitando o tempo de validade) e
    // guarda no aparelho; sem conexão, devolve a última cópia salva.
    async function buscarComCache(nome, consulta, validadeMs) {
        const cache = ler(K.cache(nome), null);
        if (cache && validadeMs && Date.now() - cache.em < validadeMs) return cache.dados;
        if (navigator.onLine && usuarioAtual()) {
            try {
                const resp = await consulta();
                if (resp.error) throw erroSupabase(resp);
                gravar(K.cache(nome), { em: Date.now(), dados: resp.data });
                return resp.data;
            } catch (e) {
                if (!cache) throw e;
                console.warn("Usando dados salvos no aparelho (" + nome + "):", e.message);
            }
        }
        if (cache) return cache.dados;
        throw new Error("Sem conexão e sem dados salvos no aparelho.");
    }

    async function listarPerfis(forcarAtualizacao) {
        return buscarComCache('perfis',
            () => sb.from('perfis').select('id,usuario,nome,nome_curto,papel,ativo,administrador').order('nome'),
            forcarAtualizacao ? 0 : 10 * 60 * 1000);
    }

    // ------------------------------------------------------------
    // Gestão de usuários (somente gestor, precisa de internet)
    // ------------------------------------------------------------
    async function chamarFuncaoUsuarios(corpo) {
        if (!navigator.onLine) throw new Error("Sem conexão com a internet.");
        const { data, error } = await sb.functions.invoke('gerenciar-usuarios', { body: corpo });
        if (error) {
            let msg = error.message;
            try { const b = await error.context.json(); if (b && b.erro) msg = b.erro; } catch (e) {}
            if (/failed to send|failed to fetch|not found/i.test(msg)) {
                msg = "Não foi possível falar com o servidor. Confira se a função 'gerenciar-usuarios' foi publicada no Supabase.";
            }
            throw new Error(msg);
        }
        if (data && data.erro) throw new Error(data.erro);
        return data;
    }

    async function atualizarUsuario(id, valores) {
        if (!navigator.onLine) throw new Error("Sem conexão com a internet.");
        const resp = await sb.from('perfis').update(valores).eq('id', id).select().maybeSingle();
        if (resp.error) throw erroSupabase(resp);
        if (!resp.data) throw new Error("Sem permissão para alterar este usuário.");
        if (id === (usuarioAtual() || {}).id) { gravar(K.usuario, resp.data); emitir(); }
        return resp.data;
    }

    // Cria o login e já ajusta nome, nome curto e papel do perfil
    async function criarUsuario(dados) {
        const r = await chamarFuncaoUsuarios({
            acao: 'criar',
            usuario: dados.usuario,
            senha: dados.senha,
            dominio: cfg.emailDominio || 'spgoasis.local'
        });
        await atualizarUsuario(r.id, { nome: dados.nome, nome_curto: dados.nome_curto || null, papel: dados.papel });
        return r.id;
    }

    function redefinirSenha(id, senha) {
        return chamarFuncaoUsuarios({ acao: 'redefinir_senha', id, senha });
    }

    // ------------------------------------------------------------
    // Dados dos blocos (base do cálculo de litros) — edição só gestor, online
    // ------------------------------------------------------------
    function listarDadosBlocos(forcarAtualizacao) {
        return buscarComCache('dados_bloco',
            () => sb.from('dados_bloco').select('*').order('id'),
            forcarAtualizacao ? 0 : 5 * 60 * 1000);
    }

    async function salvarDadoBloco(linha) {
        if (!navigator.onLine) throw new Error("Sem conexão. Alterar os dados dos blocos precisa de internet.");
        const { id, ...valores } = linha;
        const resp = id
            ? await sb.from('dados_bloco').update(valores).eq('id', id).select().maybeSingle()
            : await sb.from('dados_bloco').insert(valores).select().maybeSingle();
        if (resp.error) throw erroSupabase(resp);
        if (!resp.data) throw new Error("Sem permissão para alterar os dados dos blocos.");
        localStorage.removeItem(K.cache('dados_bloco'));
        return resp.data;
    }

    async function excluirDadoBloco(id) {
        if (!navigator.onLine) throw new Error("Sem conexão. Alterar os dados dos blocos precisa de internet.");
        const resp = await sb.from('dados_bloco').delete().eq('id', id).select();
        if (resp.error) throw erroSupabase(resp);
        if (!resp.data || resp.data.length === 0) throw new Error("Sem permissão para excluir.");
        localStorage.removeItem(K.cache('dados_bloco'));
    }

    // ------------------------------------------------------------
    // Cálculo de consumo (antigo calcularConsumo do Code.gs)
    // ------------------------------------------------------------
    async function calcularConsumo(registros, responsavel) {
        const dados = await listarDadosBlocos();
        const infoBlocos = {};

        // "yyyy-MM-dd" -> "dd/MM"
        function formatarData(iso) {
            if (!iso) return null;
            const [, m, d] = String(iso).split('-');
            return d + '/' + m;
        }

        let dataMaisRecente = null;
        let dataMaisRecenteIso = null;

        dados.forEach(linha => {
            const nomeBloco = limparNomeBloco(linha.bloco);
            if (!nomeBloco) return;

            const matchValvulas = String(linha.valvulas || "").match(/(\d+)/);
            let qtdValvulasLinha = matchValvulas ? parseInt(matchValvulas[1]) : 1;
            if (qtdValvulasLinha === 0) qtdValvulasLinha = 1;

            const tipoAspersor = String(linha.tipo_aspersor || "").trim();
            const matchVazao = tipoAspersor.match(/([\d.,]+)\s*L\/H/i);
            const vazaoLh = matchVazao ? parseFloat(matchVazao[1].replace(',', '.')) : 0;

            const qtdStringOriginal = String(linha.qtd_aspersores || "").trim();
            const qtdAspersoresLinha = parseFloat(qtdStringOriginal.replace(/\./g, '').replace(/,/g, '.')) || 0;

            const dataIso = linha.data_atualizacao;
            const dataFormatada = formatarData(dataIso);

            // Rastreia a data mais recente entre todos os blocos
            if (dataIso && (!dataMaisRecenteIso || dataIso > dataMaisRecenteIso)) {
                dataMaisRecenteIso = dataIso;
                dataMaisRecente = dataFormatada;
            }

            if (!infoBlocos[nomeBloco]) {
                infoBlocos[nomeBloco] = { vazaoTotalBlocoLh: 0, qtdTotalValvulasNoBloco: 0, qtdTotalAspersores: 0, detalhesAspersores: [], dataIso: null, dataAtualizacao: null };
            }
            const info = infoBlocos[nomeBloco];

            // Atualiza a data do bloco se esta linha for mais recente
            if (dataIso && (!info.dataIso || dataIso > info.dataIso)) {
                info.dataIso = dataIso;
                info.dataAtualizacao = dataFormatada;
            }

            info.vazaoTotalBlocoLh += qtdAspersoresLinha * vazaoLh;
            info.qtdTotalValvulasNoBloco += qtdValvulasLinha;
            info.qtdTotalAspersores += qtdAspersoresLinha;

            const tipoFormatado = tipoAspersor
                .replace(/Microaspersor/gi, 'Aspersor')
                .replace(/Microaspesor/gi, 'Aspersor')
                .replace(/Micro/gi, '')
                .trim();

            if (tipoFormatado && qtdStringOriginal) {
                const qtdFormatada = qtdAspersoresLinha > 0
                    ? Math.round(qtdAspersoresLinha).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
                    : qtdStringOriginal;
                info.detalhesAspersores.push(tipoFormatado + " = " + qtdFormatada);
            }
        });

        const dataAtualizacaoFormatada = dataMaisRecente || "Não informada";

        // Soma minutos por bloco
        const tempoPorBloco = {};
        registros.forEach(rec => {
            const blocoApp = limparNomeBloco(rec.block);
            tempoPorBloco[blocoApp] = (tempoPorBloco[blocoApp] || 0) + (rec.minutes || 0);
        });

        const textosResumo = [];
        let totalGeralLitros = 0;
        let totalBlocos = 0;
        let totalGeralMinutos = 0;
        const blocosEstruturado = {};

        for (const bloco in tempoPorBloco) {
            const minutos = tempoPorBloco[bloco];
            totalGeralMinutos += minutos;

            const horasDecimal = minutos / 60;
            const hFormat = Math.floor(minutos / 60);
            const mFormat = minutos % 60;
            const tempoTexto = ((hFormat > 0 ? hFormat + "h " : "") + (mFormat > 0 || hFormat === 0 ? mFormat + "min" : "")).trim();

            const infos = infoBlocos[bloco];
            if (infos) {
                const vazaoMediaUmaValvula = infos.qtdTotalValvulasNoBloco > 0
                    ? infos.vazaoTotalBlocoLh / infos.qtdTotalValvulasNoBloco
                    : 0;
                const litrosTotais = vazaoMediaUmaValvula * horasDecimal;
                totalGeralLitros += litrosTotais;
                totalBlocos++;

                const litrosMil = (litrosTotais / 1000).toFixed(3).replace('.', ',');

                const aspersoresTexto = infos.detalhesAspersores.map((detalhe, idx) => {
                    const txt = idx > 0 ? detalhe.replace(/Aspersor/gi, '').trim() : detalhe;
                    return "(" + txt + ")";
                }).join(" - ");

                blocosEstruturado[bloco] = {
                    litrosMil: litrosMil,
                    aspersoresTexto: aspersoresTexto,
                    totalAspersores: Math.round(infos.qtdTotalAspersores),
                    dataAtualizacao: infos.dataAtualizacao || dataAtualizacaoFormatada
                };

                textosResumo.push(
                    "• (Bloco " + bloco + ") - " + litrosMil + " mil litros (" + tempoTexto + ")\n\n" +
                    "   `" + aspersoresTexto + " - Atualizado: " + dataAtualizacaoFormatada + "`"
                );
            } else {
                blocosEstruturado[bloco] = null;
                textosResumo.push("• (Bloco " + bloco + ") - (Dados não encontrados na planilha)");
            }
        }

        const totalEmMilhares = (totalGeralLitros / 1000).toFixed(3).replace('.', ',');

        const hTotalFormat = Math.floor(totalGeralMinutos / 60);
        const mTotalFormat = totalGeralMinutos % 60;
        const tempoTotalTexto = ((hTotalFormat > 0 ? hTotalFormat + "h " : "") +
            (mTotalFormat > 0 || hTotalFormat === 0 ? mTotalFormat + "min" : "")).trim() +
            " - (" + totalGeralMinutos + " minutos)";

        let textoFinal = "`Relatório de Irrigação (" + hojeGmt3().br + ")`\n\n";
        textoFinal += textosResumo.join("\n\n");
        textoFinal += "\n\n\n *RESUMO GERAL*\n";
        textoFinal += "• Volume Total: " + totalEmMilhares + " mil Litros\n";
        textoFinal += "• Tempo Total: " + tempoTotalTexto + "\n";
        textoFinal += "• Blocos Irrigados: " + totalBlocos + "\n\n";
        textoFinal += "*Responsável:* " + responsavel;

        return {
            resumoTexto: textoFinal,
            blocos: blocosEstruturado,
            totalLitrosMil: totalEmMilhares,
            dataAtualizacao: dataAtualizacaoFormatada
        };
    }

    // ------------------------------------------------------------
    // Programação semanal
    // ------------------------------------------------------------
    function linhaProgramacao(item, responsavel) {
        return {
            id: String(item.id),
            data_envio: hojeGmt3().iso,
            dia: item.dia || "",
            bloco: limparNomeBloco(item.block),
            minutos: Number(item.minutes) || 0,
            turno: item.turno || "",
            observacao: item.observation || "",
            responsavel: responsavel,
            excluido_em: null
        };
    }

    // Grava os itens enviados no relatório, com os litros estimados rateados
    // proporcionalmente ao tempo de cada item dentro do bloco.
    function salvarProgramacao(itens, responsavel, blocosInfo) {
        const minutosPorBloco = {};
        itens.forEach(item => {
            const bloco = limparNomeBloco(item.block);
            minutosPorBloco[bloco] = (minutosPorBloco[bloco] || 0) + (Number(item.minutes) || 0);
        });

        itens.forEach(item => {
            const linha = linhaProgramacao(item, responsavel);
            const info = blocosInfo ? blocosInfo[linha.bloco] : null;

            linha.tipo_aspersor = info && info.aspersoresTexto ? info.aspersoresTexto : null;
            linha.qtd_aspersores = info && info.totalAspersores ? info.totalAspersores : null;
            linha.litros_estimados = null;
            if (info && info.litrosMil) {
                const litrosMilBloco = parseFloat(String(info.litrosMil).replace(",", "."));
                const totalBlocoMin = minutosPorBloco[linha.bloco] || 0;
                linha.litros_estimados = totalBlocoMin > 0
                    ? Number((litrosMilBloco * linha.minutos / totalBlocoMin).toFixed(3))
                    : litrosMilBloco;
            }
            enfileirar('programacoes', 'upsert', linha);
        });
    }

    // Grava na hora um item adicionado/editado na programação
    function salvarProgramacaoItem(item, responsavel) {
        enfileirar('programacoes', 'upsert', linhaProgramacao(item, responsavel));
    }

    // Exclusão lógica: some da programação atual, mas continua no histórico
    function excluirProgramacaoItem(id) {
        enfileirar('programacoes', 'update', { id: String(id), valores: { excluido_em: new Date().toISOString() } });
    }

    // Equivale ao doPost do Apps Script: calcula o consumo e, se vierem itens
    // de programação, grava-os (pela fila, funciona offline).
    async function enviar(payload) {
        try {
            const registros = payload.registros || [];
            const responsavel = payload.responsavel || "Não informado";

            const resultado = await calcularConsumo(registros, responsavel);

            if (payload.programacao && payload.programacao.length > 0) {
                salvarProgramacao(payload.programacao, responsavel, resultado.blocos);
            }

            return {
                sucesso: true,
                resumo: resultado.resumoTexto,
                blocos: resultado.blocos,
                totalLitrosMil: resultado.totalLitrosMil,
                dataAtualizacao: resultado.dataAtualizacao
            };
        } catch (erro) {
            return { sucesso: false, erro: erro.message };
        }
    }

    // Equivale ao doGet?action=historico (precisa de internet)
    async function historico() {
        try {
            if (!navigator.onLine) throw new Error("Sem conexão com a internet.");
            await sincronizar();
            const resp = await sb.from('programacoes').select('*').order('created_at', { ascending: false }).limit(2000);
            if (resp.error) throw erroSupabase(resp);
            const dados = resp.data.reverse(); // ordem de inserção

            // Agrupa por dia de envio + responsável (vários lotes no mesmo dia viram um item só)
            const grupos = {};
            const ordem = [];
            dados.forEach(linha => {
                const dataEnvio = isoParaBr(linha.data_envio);
                if (!dataEnvio) return;

                const chave = dataEnvio + "|" + (linha.responsavel || "");
                if (!grupos[chave]) {
                    grupos[chave] = { dataEnvio: dataEnvio, responsavel: linha.responsavel || "", itens: [] };
                    ordem.push(chave);
                }
                grupos[chave].itens.push({
                    dia: linha.dia || "",
                    block: linha.bloco || "",
                    tipoAspersor: linha.tipo_aspersor || "",
                    qtdAspersores: linha.qtd_aspersores || "",
                    minutes: Number(linha.minutos) || 0,
                    turno: linha.turno || "",
                    litrosEstimados: linha.litros_estimados != null
                        ? Number(linha.litros_estimados).toFixed(3).replace('.', ',')
                        : "",
                    observation: linha.observacao || ""
                });
            });

            // Mais recentes primeiro, limitado aos últimos 20 envios
            const resultado = ordem.reverse().map(chave => grupos[chave]).slice(0, 20);
            return { sucesso: true, historico: resultado };
        } catch (erro) {
            return { sucesso: false, erro: erro.message };
        }
    }

    // Equivale ao doGet?action=programacaoAtual
    async function programacaoAtual() {
        try {
            await sincronizar();
            // Ignora excluídos e linhas antigas migradas da planilha sem ID ("legado-")
            const linhas = await buscarComCache('programacoes', () => sb.from('programacoes')
                .select('id,dia,bloco,minutos,turno,observacao,excluido_em,created_at')
                .is('excluido_em', null)
                .not('id', 'like', 'legado-%')
                .order('created_at', { ascending: true }), 0);

            const programacao = mesclarPendentes('programacoes', linhas)
                .filter(linha => !linha.excluido_em)
                .map(linha => ({
                    id: /^\d+$/.test(linha.id) ? Number(linha.id) : linha.id,
                    dia: linha.dia || "",
                    block: linha.bloco || "",
                    minutes: Number(linha.minutos) || 0,
                    turno: linha.turno || "",
                    observation: linha.observacao || ""
                }));
            return { sucesso: true, programacao: programacao };
        } catch (erro) {
            return { sucesso: false, erro: erro.message };
        }
    }

    // ------------------------------------------------------------
    // Registros diários de irrigação
    // ------------------------------------------------------------
    // O id local (Date.now()) ganha o prefixo do usuário para nunca colidir
    // com registros de outro aparelho.
    function idRegistro(localId) {
        const u = usuarioAtual();
        return (u ? u.id.slice(0, 8) : 'anon') + '-' + localId;
    }

    function salvarRegistro(rec) {
        enfileirar('registros_irrigacao', 'upsert', {
            id: idRegistro(rec.id),
            data: rec.date,
            bloco: limparNomeBloco(rec.block),
            minutos: Number(rec.minutes) || 0,
            turno: rec.turno || "",
            observacao: rec.observation || "",
            responsavel: nomeUsuario(),
            registrado_em: rec.registradoEm || new Date().toISOString()
        });
    }

    function excluirRegistro(localId) {
        enfileirar('registros_irrigacao', 'delete', { id: idRegistro(localId) });
    }

    // Gestor corrigindo o registro de outro irrigador (pelo id do banco).
    // O responsável continua sendo quem irrigou; o log guarda quem alterou.
    function atualizarRegistroEquipe(id, rec) {
        enfileirar('registros_irrigacao', 'update', { id: String(id), valores: {
            data: rec.date,
            bloco: limparNomeBloco(rec.block),
            minutos: Number(rec.minutes) || 0,
            turno: rec.turno || "",
            observacao: rec.observation || ""
        } });
    }

    function excluirRegistroEquipe(id) {
        enfileirar('registros_irrigacao', 'delete', { id: String(id) });
    }

    function salvarMotor(data, ligado, desligado) {
        const u = usuarioAtual();
        if (!u || !data) return;
        enfileirar('motor_diario', 'upsert', {
            id: u.id + '_' + data,
            data: data,
            responsavel: nomeUsuario(),
            motor_ligado: ligado || null,
            motor_desligado: desligado || null
        });
    }

    // Log de cada relatório enviado (tipo: 'irrigacao' | 'programacao')
    function registrarEnvio(envio) {
        enfileirar('envios_relatorio', 'upsert', Object.assign({
            id: novoId(),
            responsavel: nomeUsuario(),
            registrado_em: new Date().toISOString()
        }, envio));
    }

    // ------------------------------------------------------------
    // Poços e reservatórios
    // ------------------------------------------------------------
    function ordenarPorNumero(a, b) {
        return String(a.numero || a.nome || '').localeCompare(String(b.numero || b.nome || ''), undefined, { numeric: true });
    }

    async function listarPocos() {
        const lista = await buscarComCache('pocos', () => sb.from('pocos').select('*'), 0).catch(() => []);
        return mesclarPendentes('pocos', lista).sort(ordenarPorNumero);
    }

    function salvarPoco(poco) {
        const linha = Object.assign({ id: novoId(), ativo: true }, poco);
        enfileirar('pocos', 'upsert', linha);
        return linha;
    }

    async function listarLeiturasPocos() {
        const lista = await buscarComCache('leituras_poco', () => sb.from('leituras_poco')
            .select('*').order('data_hora', { ascending: false }).limit(500), 0).catch(() => []);
        return mesclarPendentes('leituras_poco', lista).sort((a, b) => String(b.data_hora).localeCompare(String(a.data_hora)));
    }

    // Histórico completo de um poço (para o PDF da ficha), da leitura mais recente para a mais antiga
    async function listarLeiturasDoPoco(pocoId) {
        const lista = await buscarComCache(`leituras_poco_${pocoId}`, () => sb.from('leituras_poco')
            .select('*').eq('poco_id', pocoId).order('data_hora', { ascending: false }).limit(5000), 0).catch(() => []);
        return mesclarPendentes('leituras_poco', lista).filter(l => l.poco_id === pocoId)
            .sort((a, b) => String(b.data_hora).localeCompare(String(a.data_hora)));
    }

    function salvarLeituraPoco(leitura) {
        enfileirar('leituras_poco', 'upsert', Object.assign({ id: novoId(), responsavel: nomeUsuario() }, leitura));
    }

    function excluirLeituraPoco(id) {
        enfileirar('leituras_poco', 'delete', { id });
    }

    async function listarReservatorios() {
        const lista = await buscarComCache('reservatorios', () => sb.from('reservatorios').select('*'), 0).catch(() => []);
        return mesclarPendentes('reservatorios', lista).sort(ordenarPorNumero);
    }

    function salvarReservatorio(reservatorio) {
        const linha = Object.assign({ id: novoId(), ativo: true }, reservatorio);
        enfileirar('reservatorios', 'upsert', linha);
        return linha;
    }

    // Manutenções dos poços (qualquer usuário registra; funciona offline)
    async function listarManutencoes() {
        const lista = await buscarComCache('manutencoes_poco', () => sb.from('manutencoes_poco')
            .select('*').order('data', { ascending: false }).limit(1000), 0).catch(() => []);
        return mesclarPendentes('manutencoes_poco', lista)
            .sort((a, b) => String(b.data).localeCompare(String(a.data)) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
    }

    function salvarManutencao(manutencao) {
        enfileirar('manutencoes_poco', 'upsert', Object.assign({ id: novoId(), responsavel: nomeUsuario() }, manutencao));
    }

    function excluirManutencao(id) {
        enfileirar('manutencoes_poco', 'delete', { id });
    }

    // Exclui um poço ou reservatório (somente gestor, precisa de internet).
    // Se já tiver leituras, o banco recusa (erro 23503) para preservar o histórico.
    async function excluirCadastro(tabela, id) {
        if (!navigator.onLine) throw new Error("Sem conexão. Excluir cadastros precisa de internet.");
        await sincronizar(); // envia antes o que estiver na fila (ex.: o próprio cadastro recém-criado)
        const resp = await sb.from(tabela).delete().eq('id', id).select();
        if (resp.error) {
            const e = erroSupabase(resp);
            if (e.code === '23503') e.message = 'possui leituras registradas';
            throw e;
        }
        if (!resp.data || resp.data.length === 0) throw new Error("Sem permissão para excluir (ou já foi excluído).");
        localStorage.removeItem(K.cache(tabela));
    }

    async function listarLeiturasReservatorios() {
        const lista = await buscarComCache('leituras_reservatorio', () => sb.from('leituras_reservatorio')
            .select('*').order('data_hora', { ascending: false }).limit(500), 0).catch(() => []);
        return mesclarPendentes('leituras_reservatorio', lista).sort((a, b) => String(b.data_hora).localeCompare(String(a.data_hora)));
    }

    // Leituras de reservatório no período (dias no horário local do aparelho)
    async function listarLeiturasReservPeriodo(de, ate) {
        const inicio = new Date(de + 'T00:00:00');
        const fim = new Date(new Date(ate + 'T00:00:00').getTime() + 24 * 3600 * 1000);
        const lista = await buscarComCache(`leituras_reserv_${de}_${ate}`, () => sb.from('leituras_reservatorio').select('*')
            .gte('data_hora', inicio.toISOString()).lt('data_hora', fim.toISOString()).limit(5000), 0).catch(() => []);
        return mesclarPendentes('leituras_reservatorio', lista)
            .filter(l => { const t = new Date(l.data_hora); return t >= inicio && t < fim; })
            .sort((a, b) => String(b.data_hora).localeCompare(String(a.data_hora)));
    }

    function salvarLeituraReservatorio(leitura) {
        enfileirar('leituras_reservatorio', 'upsert', Object.assign({ id: novoId(), responsavel: nomeUsuario() }, leitura));
    }

    // Corrige uma leitura já registrada (o dono ou o gestor); quem registrou continua o mesmo
    function atualizarLeituraReservatorio(id, valores) {
        enfileirar('leituras_reservatorio', 'update', { id: String(id), valores });
    }

    function excluirLeituraReservatorio(id) {
        enfileirar('leituras_reservatorio', 'delete', { id });
    }

    // ------------------------------------------------------------
    // Balanço de água: horas ligado, configurações e registros do dia
    // ------------------------------------------------------------
    async function lerConfiguracao(chave, padrao) {
        try {
            const lista = await buscarComCache('configuracoes', () => sb.from('configuracoes').select('chave,valor'), 10 * 60 * 1000);
            const item = (lista || []).find(c => c.chave === chave);
            return item ? item.valor : padrao;
        } catch (e) {
            return padrao;
        }
    }

    // Somente gestor, precisa de internet
    async function salvarConfiguracao(chave, valor) {
        if (!navigator.onLine) throw new Error("Sem conexão. Alterar configurações precisa de internet.");
        const resp = await sb.from('configuracoes').upsert({ chave, valor }, { onConflict: 'chave' }).select().maybeSingle();
        if (resp.error) throw erroSupabase(resp);
        if (!resp.data) throw new Error("Sem permissão para alterar configurações.");
        localStorage.removeItem(K.cache('configuracoes'));
    }

    // Horas ligado por poço/dia no período (datas yyyy-MM-dd, inclusivas)
    async function listarHorasPocoPeriodo(de, ate) {
        const lista = await buscarComCache(`horas_poco_${de}_${ate}`,
            () => sb.from('horas_poco_dia').select('*').gte('data', de).lte('data', ate), 0).catch(() => []);
        return mesclarPendentes('horas_poco_dia', lista).filter(h => h.data >= de && h.data <= ate);
    }

    // Leituras de poço no período (dias no horário local do aparelho)
    async function listarLeiturasPocoPeriodo(de, ate) {
        const inicio = new Date(de + 'T00:00:00');
        const fim = new Date(new Date(ate + 'T00:00:00').getTime() + 24 * 3600 * 1000);
        const lista = await buscarComCache(`leituras_poco_${de}_${ate}`, () => sb.from('leituras_poco').select('*')
            .gte('data_hora', inicio.toISOString()).lt('data_hora', fim.toISOString()).limit(5000), 0).catch(() => []);
        return mesclarPendentes('leituras_poco', lista)
            .filter(l => { const t = new Date(l.data_hora); return t >= inicio && t < fim; });
    }

    // Cultura de cada bloco (legenda do gráfico de saída)
    async function listarCulturas() {
        return buscarComCache('culturas_bloco', () => sb.from('culturas_bloco').select('id,cultura'), 10 * 60 * 1000).catch(() => []);
    }

    // Somente gestor, precisa de internet
    async function salvarCultura(bloco, cultura) {
        if (!navigator.onLine) throw new Error("Sem conexão. Alterar a cultura precisa de internet.");
        const resp = await sb.from('culturas_bloco').upsert({ id: String(bloco), cultura: cultura || null }, { onConflict: 'id' }).select().maybeSingle();
        if (resp.error) throw erroSupabase(resp);
        if (!resp.data) throw new Error("Sem permissão para alterar a cultura.");
        localStorage.removeItem(K.cache('culturas_bloco'));
    }

    function salvarHorasPoco(pocoId, data, horas) {
        enfileirar('horas_poco_dia', 'upsert', { id: pocoId + '_' + data, poco_id: pocoId, data, horas });
    }

    // Registros de irrigação do período, de todos os irrigadores (saída de água)
    async function listarRegistrosPeriodo(de, ate) {
        const lista = await buscarComCache(`registros_${de}_${ate}`,
            () => sb.from('registros_irrigacao').select('id,data,bloco,minutos').gte('data', de).lte('data', ate).limit(10000), 0).catch(() => []);
        return mesclarPendentes('registros_irrigacao', lista).filter(r => r.data >= de && r.data <= ate);
    }

    // ------------------------------------------------------------
    // Tempo real: registros de irrigação dos outros irrigadores
    // ------------------------------------------------------------
    const CAMPOS_REGISTRO_EQUIPE = 'id,data,bloco,minutos,turno,observacao,responsavel,registrado_em,criado_por';

    // Registros do dia feitos por outros usuários (sem conexão, usa a última cópia salva)
    async function listarRegistrosEquipe(data) {
        const u = usuarioAtual();
        const prefixo = u ? u.id.slice(0, 8) + '-' : null;
        const lista = await buscarComCache(`registros_equipe_${data}`,
            () => sb.from('registros_irrigacao').select(CAMPOS_REGISTRO_EQUIPE).eq('data', data).limit(2000), 0).catch(() => []);
        // Aplica as correções do gestor ainda na fila; tira os do próprio usuário
        return mesclarPendentes('registros_irrigacao', lista)
            .filter(r => r.data === data && (!u || (r.criado_por !== u.id && !String(r.id).startsWith(prefixo))));
    }

    // Todos os registros de um dia (de todos os irrigadores, inclusive os do próprio
    // usuário), com as alterações ainda na fila já aplicadas. Usado ao consultar dias anteriores.
    async function listarRegistrosDia(data) {
        const lista = await buscarComCache(`registros_dia_${data}`,
            () => sb.from('registros_irrigacao').select(CAMPOS_REGISTRO_EQUIPE).eq('data', data).limit(2000), 0).catch(() => []);
        return mesclarPendentes('registros_irrigacao', lista).filter(r => r.data === data);
    }

    let canalRegistros = null;

    // Avisa a cada registro de irrigação criado, alterado ou excluído.
    // cb({ tipo: 'INSERT'|'UPDATE'|'DELETE', registro, id, proprio, idLocal })
    // "proprio" = registro do usuário logado (ex.: restaurado ou alterado pelo gestor);
    // nesse caso "idLocal" é o id usado na lista do aparelho.
    function assinarRegistros(cb) {
        if (canalRegistros) sb.removeChannel(canalRegistros);
        canalRegistros = sb.channel('registros-irrigacao')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'registros_irrigacao' }, payload => {
                const u = usuarioAtual();
                const registro = payload.new && payload.new.id ? payload.new : null;
                const id = String((registro || payload.old || {}).id || '');
                const prefixo = u ? u.id.slice(0, 8) + '-' : null;
                const proprio = !!prefixo && id.startsWith(prefixo);
                // Eco de uma gravação deste aparelho ainda em andamento: ignora
                if (proprio && pendentesDe('registros_irrigacao').some(op => String(op.dados.id) === id)) return;
                const idLocal = proprio && /^\d+$/.test(id.slice(prefixo.length)) ? Number(id.slice(prefixo.length)) : null;
                cb({ tipo: payload.eventType, registro, id, proprio, idLocal });
            })
            .subscribe();
    }

    function cancelarAssinaturaRegistros() {
        if (canalRegistros) sb.removeChannel(canalRegistros);
        canalRegistros = null;
    }

    // ------------------------------------------------------------
    // Log de auditoria (somente gestor, precisa de internet)
    // ------------------------------------------------------------
    async function listarAuditoria(limite) {
        if (!navigator.onLine) throw new Error("Sem conexão com a internet.");
        const resp = await sb.from('auditoria').select('*').order('criado_em', { ascending: false }).limit(limite || 100);
        if (resp.error) throw erroSupabase(resp);
        return resp.data;
    }

    // Backup: volta o item ao valor que tinha antes da ação registrada no log
    // (ou desfaz um registro novo). Somente gestor, precisa de internet.
    async function restaurarAuditoria(idAuditoria) {
        if (!navigator.onLine) throw new Error("Sem conexão com a internet.");
        await sincronizar(); // envia antes o que estiver na fila, para não sobrescrever depois
        const resp = await sb.rpc('restaurar_auditoria', { p_id: idAuditoria });
        if (resp.error) {
            if (/function .*restaurar_auditoria|could not find/i.test(resp.error.message)) {
                throw new Error("Rode o arquivo supabase/backup.sql no SQL Editor do Supabase para ativar a restauração.");
            }
            throw erroSupabase(resp);
        }
        // Os dados mudaram no banco: descarta as cópias salvas no aparelho
        Object.keys(localStorage).filter(k => k.startsWith('irrigacao_cache_') && !k.endsWith('perfis'))
            .forEach(k => localStorage.removeItem(k));
        return resp.data;
    }

    // ------------------------------------------------------------
    // Sessões: quem está online e o que fez em cada sessão
    // ------------------------------------------------------------
    let sessaoId = null;
    let sessaoAba = '';
    let timerSinal = null;

    function descreverDispositivo() {
        const ua = navigator.userAgent || '';
        const so = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iPhone/iPad'
                 : /Windows/i.test(ua) ? 'Windows' : /Macintosh|Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Outro';
        const nav = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/i.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome'
                  : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
        const app = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches ? ' (app instalado)' : '';
        return `${so}${nav ? ' · ' + nav : ''}${app}`;
    }

    // Envia o "estou online". Sem internet ou sem sessão válida, simplesmente não envia.
    async function enviarSinal() {
        const u = usuarioAtual();
        if (!u || !sessaoId || !navigator.onLine || document.visibilityState === 'hidden') return;
        lembrarSessao();
        try {
            const { data } = await sb.auth.getSession();
            if (!data.session) return;
            await sb.from('sessoes').upsert({
                id: sessaoId, usuario_id: u.id, usuario_nome: nomeUsuario(u),
                ultimo_sinal: new Date().toISOString(), dispositivo: descreverDispositivo(), aba: sessaoAba, fim: null
            }, { onConflict: 'id' });
        } catch (e) { /* sinal é opcional: nunca atrapalha o uso do app */ }
    }

    // Sessão guardada no aparelho: recarregar a página (ou reabrir o app logo em
    // seguida) continua a mesma sessão, em vez de aparecer como uma conexão nova
    const SESSAO_REUSO_MS = 5 * 60 * 1000;
    const K_SESSAO = 'irrigacao_sessao_atual';

    function lembrarSessao() {
        const u = usuarioAtual();
        if (u && sessaoId) gravar(K_SESSAO, { id: sessaoId, usuarioId: u.id, em: Date.now() });
    }

    // Abre uma sessão (ao entrar no app ou fazer login), reaproveitando a anterior se ainda estiver valendo
    function iniciarSessao(aba) {
        const u = usuarioAtual();
        const anterior = ler(K_SESSAO, null);
        sessaoId = anterior && u && anterior.usuarioId === u.id && Date.now() - anterior.em < SESSAO_REUSO_MS
            ? anterior.id : novoId();
        lembrarSessao();
        sessaoAba = aba || '';
        clearInterval(timerSinal);
        timerSinal = setInterval(enviarSinal, 60 * 1000);
        enviarSinal();
    }

    function informarAbaSessao(aba) {
        if (aba === sessaoAba) return;
        sessaoAba = aba;
        enviarSinal();
    }

    async function encerrarSessao() {
        clearInterval(timerSinal);
        if (sessaoId && navigator.onLine) {
            try { await sb.from('sessoes').update({ fim: new Date().toISOString() }).eq('id', sessaoId); } catch (e) {}
        }
        localStorage.removeItem(K_SESSAO);
        sessaoId = null;
    }

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') enviarSinal(); });
    window.addEventListener('online', enviarSinal);
    window.addEventListener('pagehide', lembrarSessao);

    // Sessões com sinal a partir de "desde" (somente gestor, precisa de internet)
    async function listarSessoes(desdeIso) {
        if (!navigator.onLine) throw new Error("Sem conexão com a internet.");
        const resp = await sb.from('sessoes').select('*').gte('ultimo_sinal', desdeIso).order('ultimo_sinal', { ascending: false }).limit(300);
        if (resp.error) throw erroSupabase(resp);
        return resp.data;
    }

    // Tudo o que o usuário registrou/alterou entre o início e o fim da sessão
    async function atividadesDaSessao(usuarioId, inicioIso, fimIso) {
        if (!navigator.onLine) throw new Error("Sem conexão com a internet.");
        const resp = await sb.from('auditoria').select('*').eq('usuario_id', usuarioId)
            .gte('criado_em', inicioIso).lte('criado_em', fimIso)
            .order('criado_em', { ascending: false }).limit(300);
        if (resp.error) throw erroSupabase(resp);
        return resp.data;
    }

    function falhasSync() { return ler(K.falhas, []); }
    function limparFalhasSync() { gravar(K.falhas, []); emitir(); }

    window.IrrigacaoAPI = {
        // login
        login, logout, usuarioAtual, isGestor, isAdmin, nomeUsuario, atualizarPerfil, listarPerfis,
        // gestão de usuários
        criarUsuario, atualizarUsuario, redefinirSenha,
        // sincronização
        sincronizar, onStatus, status, falhasSync, limparFalhasSync,
        // irrigação e programação
        enviar, historico, programacaoAtual, salvarProgramacaoItem, excluirProgramacaoItem,
        salvarRegistro, excluirRegistro, atualizarRegistroEquipe, excluirRegistroEquipe, salvarMotor, registrarEnvio,
        // dados dos blocos
        listarDadosBlocos, salvarDadoBloco, excluirDadoBloco,
        // água
        listarPocos, salvarPoco, listarLeiturasPocos, listarLeiturasDoPoco, salvarLeituraPoco, excluirLeituraPoco,
        listarReservatorios, salvarReservatorio, listarLeiturasReservatorios, listarLeiturasReservPeriodo, salvarLeituraReservatorio, atualizarLeituraReservatorio, excluirLeituraReservatorio,
        excluirCadastro, listarManutencoes, salvarManutencao, excluirManutencao,
        // balanço de água
        lerConfiguracao, salvarConfiguracao, listarHorasPocoPeriodo, salvarHorasPoco, listarRegistrosPeriodo, listarLeiturasPocoPeriodo,
        listarCulturas, salvarCultura,
        // tempo real (registros dos outros irrigadores)
        listarRegistrosEquipe, listarRegistrosDia, assinarRegistros, cancelarAssinaturaRegistros,
        // auditoria e sessões
        listarAuditoria, restaurarAuditoria, iniciarSessao, informarAbaSessao, encerrarSessao, listarSessoes, atividadesDaSessao
    };
})();
