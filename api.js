/* =========================================================
   CAMADA DE DADOS (CRUD)
   ---------------------------------------------------------
   Todos os registros (loja, usuários, clientes e lançamentos)
   ficam numa única aba do Google Sheets chamada "registros":

     id | tabela | dados (JSON do registro) | atualizado_em

   Modos (escolha em js/config.js):
     'local'  -> salva no navegador (para testar)
     'sheets' -> Google Planilhas via Apps Script (um único link /exec)
     'make'   -> um cenário do Make por operação:
                 Create -> CRUD-Create-Registro  (Add a Row)
                 Read   -> CRUD-Read-Registros   (Search Rows + Text Aggregator)
                 Update -> CRUD-Update-Registro  (Search Rows + Update a Row)
                 Delete -> CRUD-Delete-Registro  (Search Rows + Delete a Row)
   ========================================================= */
const API = (() => {
  const CHAVE_LOCAL = 'caderneta_db_v1';
  let registros = [];          // cópia em memória de tudo que veio do banco
  let ultimaLeitura = 0;
  let lojaAtual = null;        // várias lojas no mesmo banco: o app só enxerga a loja de quem entrou

  // Dados antigos (de quando havia uma loja só) não têm loja_id: passam a ser da loja antiga
  function completarLojaId() {
    const semLoja = registros.filter(r => !r.loja_id);
    if (!semLoja.length) return;
    const lojaAntiga = registros.find(r => r.tabela === 'loja' && (!r.loja_id || r.loja_id === r.id));
    if (lojaAntiga) semLoja.forEach(r => { r.loja_id = r.tabela === 'loja' ? r.id : lojaAntiga.id; });
  }

  const modoMake = () => CONFIG.MODO === 'make';
  const modoSheets = () => CONFIG.MODO === 'sheets';
  const remoto = () => modoMake() || modoSheets();

  function gerarId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------- Modo local (localStorage) ---------- */
  function lerLocal() {
    try { return JSON.parse(localStorage.getItem(CHAVE_LOCAL)) || []; }
    catch { return []; }
  }
  function salvarLocal() {
    try { localStorage.setItem(CHAVE_LOCAL, JSON.stringify(registros)); }
    catch (e) { console.warn('Não foi possível salvar localmente', e); }
  }

  /* ---------- Modo Make (webhooks) ---------- */
  // Envia como formulário (application/x-www-form-urlencoded):
  // é uma "requisição simples", então o navegador não faz preflight CORS.
  async function chamarMake(operacao, campos) {
    const url = CONFIG.WEBHOOKS[operacao];
    if (!url || url.includes('COLE_AQUI')) {
      throw new Error(`Webhook "${operacao}" não configurado no arquivo config.js`);
    }
    let resposta;
    try {
      resposta = await fetch(url, { method: 'POST', body: new URLSearchParams(campos) });
    } catch {
      throw new Error('Sem conexão com o Make. Verifique a internet e se o cenário está ativo.');
    }
    if (!resposta.ok) throw new Error(`O Make respondeu com erro (${resposta.status}) na operação ${operacao}.`);
    return resposta.text();
  }

  /* ---------- Modo Google Planilhas (Apps Script) ---------- */
  // Um único link (/exec). A operação vai no campo "operacao".
  async function chamarSheets(operacao, campos) {
    const url = CONFIG.URL_APPS_SCRIPT;
    if (!url || url.includes('COLE_AQUI')) throw new Error('Link do Apps Script não configurado no arquivo config.js');
    let resposta;
    try {
      resposta = await fetch(url, { method: 'POST', body: new URLSearchParams({ operacao, ...campos }) });
    } catch {
      throw new Error('Sem conexão com a planilha. Verifique a internet e se o Apps Script foi implantado para "Qualquer pessoa".');
    }
    if (!resposta.ok) throw new Error(`A planilha respondeu com erro (${resposta.status}) na operação ${operacao}.`);
    const texto = await resposta.text();
    let json;
    try { json = JSON.parse(texto); }
    catch { throw new Error('O link do Apps Script não respondeu como esperado. Confira se é o link que termina em /exec.'); }
    if (json && json.ok === false) throw new Error(`Erro na planilha: ${json.erro || 'desconhecido'}`);
    return texto;
  }

  const chamar = (operacao, campos) => (modoSheets() ? chamarSheets(operacao, campos) : chamarMake(operacao, campos));

  /* ---------- READ ---------- */
  async function carregar() {
    if (remoto()) {
      const texto = await chamar('read', { operacao: 'read' });
      let lista = [];
      try { lista = JSON.parse(texto); } catch { lista = []; }
      registros = (Array.isArray(lista) ? lista : [])
        .filter(r => r && r.id && r.tabela && !String(r.tabela).startsWith('_'));
    } else {
      registros = lerLocal();
    }
    completarLojaId();
    ultimaLeitura = Date.now();
    return registros;
  }

  const daLoja = r => r.loja_id === lojaAtual;
  // listar/obter: só a loja de quem está logado. listarTodos/obterQualquer: todas (login e cadastro).
  const listar = tabela => registros.filter(r => r.tabela === tabela && daLoja(r));
  const obter = id => registros.find(r => r.id === id && daLoja(r)) || null;
  const listarTodos = tabela => registros.filter(r => r.tabela === tabela);
  const obterQualquer = id => registros.find(r => r.id === id) || null;
  const definirLoja = id => { lojaAtual = id || null; };

  /* ---------- CREATE ---------- */
  async function criar(tabela, dados) {
    const agora = new Date().toISOString();
    const id = gerarId();
    const loja_id = tabela === 'loja' ? id : (dados.loja_id || lojaAtual);
    if (!loja_id) throw new Error('Nenhuma loja selecionada.');
    const registro = { ...dados, id, tabela, loja_id, criado_em: agora, atualizado_em: agora };
    if (remoto()) {
      await chamar('create', { id: registro.id, tabela, dados: JSON.stringify(registro) });
    }
    registros.push(registro);
    if (!remoto()) salvarLocal();
    return registro;
  }

  /* ---------- UPDATE ---------- */
  async function atualizar(id, mudancas) {
    const atual = obterQualquer(id);
    if (!atual) throw new Error('Registro não encontrado. Toque em atualizar e tente de novo.');
    const registro = { ...atual, ...mudancas, id, tabela: atual.tabela, atualizado_em: new Date().toISOString() };
    if (remoto()) {
      await chamar('update', { id, tabela: registro.tabela, dados: JSON.stringify(registro) });
    }
    registros = registros.map(r => (r.id === id ? registro : r));
    if (!remoto()) salvarLocal();
    return registro;
  }

  /* ---------- DELETE ---------- */
  async function excluir(id) {
    if (remoto()) await chamar('delete', { id });
    registros = registros.filter(r => r.id !== id);
    if (!remoto()) salvarLocal();
  }

  return {
    carregar, listar, obter, listarTodos, obterQualquer, definirLoja, criar, atualizar, excluir,
    get lojaAtual() { return lojaAtual; },
    get ultimaLeitura() { return ultimaLeitura; },
    // "Impressão digital" dos dados: muda quando algo é criado, editado ou excluído
    assinatura: () => registros.map(r => `${r.id}:${r.atualizado_em}`).sort().join('|'),
    CHAVE_LOCAL,
    get modo() { return modoSheets() ? 'Google Planilhas (Apps Script)' : modoMake() ? 'Make + Google Sheets' : 'Local (navegador)'; }
  };
})();
