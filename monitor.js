const FICHA_URL = process.env.FICHA_URL || 'https://doe.monitorlegislativo.com.br/ficha';

function fichaEmailButtonHtml() {
  return '<div style="background:#eef6ff;border:1px solid #c7ddf2;border-radius:6px;padding:11px 13px;margin:12px 0;color:#173d63;font-size:13px;line-height:1.45">' +
    '<strong>Ficha</strong><br>' +
    '<span>Cole o link oficial de uma proposição para criar ficha e acelerar a revisão/cadastro.</span><br>' +
    '<a href="' + FICHA_URL + '" style="display:inline-block;background:#0f3d5c;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-weight:bold;margin-top:8px">Criar ficha</a>' +
    '</div>';
}

const fs = require('fs');
const nodemailer = require('nodemailer');
let promoverInteresseClienteProposicao = (_item, atuais) => Array.isArray(atuais) ? atuais : [];
try {
  try {
    ({ promoverInteresseClienteProposicao } = require('./client_interest_matcher_js'));
  } catch (_localErr) {
    ({ promoverInteresseClienteProposicao } = require('../../agents/pautas/client_interest_matcher_js'));
  }
} catch (err) {
  console.warn('⚠️ Matcher cliente/palavra comum indisponível; usando destaque legado: ' + err.message);
}

function mlClientInterestContext() {
  return {
    uf: typeof CLIENT_INTEREST_UF !== 'undefined' ? CLIENT_INTEREST_UF : (process.env.CLIENT_INTEREST_UF || process.env.UF || ''),
    municipio: typeof CLIENT_INTEREST_MUNICIPIO !== 'undefined' ? CLIENT_INTEREST_MUNICIPIO : (process.env.CLIENT_INTEREST_MUNICIPIO || process.env.MUNICIPIO || ''),
    casa: typeof CASA_RADAR03 !== 'undefined' ? CASA_RADAR03 : (process.env.CASA_RADAR03 || process.env.CASA || ''),
  };
}


const EMAIL_DESTINO = process.env.EMAIL_DESTINO || 'tramitacao@monitorlegislativo.com.br';
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE || 'flavia@monitorlegislativo.com.br';
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const CONTROLE03_FORCE_LATEST = String(process.env.CONTROLE03_FORCE_LATEST || '').trim() === '1';
const ARQUIVO_ESTADO = 'estado.json';
const RADAR03_URL = process.env.RADAR03_URL || 'https://doe.monitorlegislativo.com.br/controle03/';
const CASA_RADAR03 = process.env.CASA_RADAR03 || 'MT - Cuiabá';
const CONTROLE03_STATE_URL = process.env.CONTROLE03_STATE_URL || new URL('api/state', RADAR03_URL).toString();
const CONTROLE03_API_USER = process.env.CONTROLE03_API_USER || '';
const CONTROLE03_API_PASS = process.env.CONTROLE03_API_PASS || '';
const CONTROLE03_BASIC_AUTH = process.env.CONTROLE03_BASIC_AUTH || '';

const URL_BASE = 'https://legislativo.camaracuiaba.mt.gov.br/spl/consulta-producao.aspx';
const NOME_CASA = 'Câmara Municipal de Cuiabá';
const ANO = new Date().getFullYear();
const ITENS_POR_PAGINA = 50;
const MAX_PAGINAS_PRIMEIRO_RUN = 10; // 500 proposições no backlog inicial
const MAX_PAGINAS_INCREMENTAL = Number(process.env.MAX_PAGINAS_INCREMENTAL || 5);
const MAX_NOVIDADES_EMAIL = Number(process.env.MAX_NOVIDADES_EMAIL || 80);
const MAX_TENTATIVAS_EMAIL = 3;
const EXIT_TRANSIENT_SOURCE = 75;
const EXIT_OPERATIONAL_BLOCK = 78;

// Tipos monitorados
const TIPOS_MONITORADOS = [
  'projeto de lei',
  'projeto de lei complementar',
  'projeto de lei substitutivo',
  'projeto de lei complementar substitutivo',
  'projeto de decreto legislativo',
  'projeto de decreto de legislativo substitutivo',
  'projeto de resolução',
  'proposta de emenda à lei orgânica',
  'veto',
  'requerimento de informações',
  'requerimento de audiência pública',
  'requerimento de instauração de comissão parlamentar de inquérito',
  'indicação',
];

function tipoMonitorado(tipo) {
  if (!tipo) return false;
  const t = tipo.toLowerCase().trim();
  return TIPOS_MONITORADOS.some(m => t === m || t.includes(m) || m.includes(t));
}

function absolutizarUrl(href) {
  if (!href) return '';
  return new URL(href.replace(/&amp;/g, '&').trim(), URL_BASE).toString();
}

// ─── Estado ───────────────────────────────────────────────────────────────────

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

class EstadoDefasadoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EstadoDefasadoError';
  }
}

class FonteTransitoriaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FonteTransitoriaError';
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

function extrairViewState(html) {
  const m = html.match(/id="__VIEWSTATE"[^>]*value="([^"]+)"/);
  return m ? m[1] : null;
}

function extrairViewStateGenerator(html) {
  const m = html.match(/id="__VIEWSTATEGENERATOR"[^>]*value="([^"]+)"/);
  return m ? m[1] : null;
}

function extrairEventValidation(html) {
  const m = html.match(/id="__EVENTVALIDATION"[^>]*value="([^"]+)"/);
  return m ? m[1] : null;
}

function extrairDoCampoUpdatePanel(resposta, nomeCampo) {
  const partes = resposta.split('|');
  for (let i = 0; i < partes.length - 3; i++) {
    if (partes[i + 1] === 'hiddenField' && partes[i + 2] === nomeCampo) {
      return partes[i + 3];
    }
  }
  return null;
}

function extrairViewStateDeResposta(resposta) {
  return extrairDoCampoUpdatePanel(resposta, '__VIEWSTATE');
}

function extrairEventValidationDeResposta(resposta) {
  return extrairDoCampoUpdatePanel(resposta, '__EVENTVALIDATION');
}

function extrairHtmlUpdatePanel(resposta) {
  const marker = '|updatePanel|ContentPlaceHolder1_upp_consultaProducao|';
  const idx = resposta.indexOf(marker);
  if (idx === -1) return null;
  const inicio = idx + marker.length;
  const tamanhoStr = resposta.substring(0, idx).split('|').pop();
  const tamanho = parseInt(tamanhoStr);
  if (!isNaN(tamanho)) return resposta.substring(inicio, inicio + tamanho);
  return resposta.substring(inicio);
}

function extrairAlvosPaginacao(html) {
  const alvos = {};
  const normalizado = String(html || '').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const regex = /__doPostBack\('([^']+rptPaging[^']+lbPaging)',''\)[^>]*>\s*(\d+)\s*<\/a>/gi;
  let match;
  while ((match = regex.exec(normalizado)) !== null) {
    alvos[match[2]] = match[1];
  }
  return alvos;
}

function parseProposicoes(html) {
  const proposicoes = [];
  const blocos = html.split('kt-widget5__item');

  for (let i = 1; i < blocos.length; i++) {
    const bloco = blocos[i];

    const idMatch = bloco.match(/ID:<\/span>\s*<span[^>]*>(\d+)<\/span>/);
    if (!idMatch) continue;
    const id = idMatch[1];

    const tituloMatch = bloco.match(/kt-widget5__title[^>]*>\s*([^<]+?)\s*<\/a>/);
    const titulo = tituloMatch ? tituloMatch[1].trim() : '-';
    const hrefMatch = bloco.match(/<a\b[^>]*href=["\']([^"\']+)["\'][^>]*class=["\'][^"\']*kt-widget5__title/i);
    const url = hrefMatch ? absolutizarUrl(hrefMatch[1]) : '';

    const tipoNumMatch = titulo.match(/^(.+?)\s+n[°º]\s*(\d+)\/\d+/);
    const tipo = tipoNumMatch ? tipoNumMatch[1].trim() : titulo;
    const numero = tipoNumMatch ? tipoNumMatch[2] : '-';

    const ementaMatch = bloco.match(/kt-widget5__desc[^>]*>\s*([\s\S]+?)\s*<\/a>/);
    const ementa = ementaMatch
      ? ementaMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : '-';

    const dataMatch = bloco.match(/Data:<\/span>\s*<span[^>]*>([^<]+)<\/span>/);
    const data = dataMatch ? dataMatch[1].trim() : '-';

    const autorMatch = bloco.match(/Autor\(es\) da Proposição:<\/span>\s*<span[^>]*>([\s\S]+?)<\/span>/);
    let autor = '-';
    if (autorMatch) {
      autor = autorMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    }

    const processoMatch = bloco.match(/Processo N°:<\/span>\s*<a[^>]*>([^<]+)<\/a>/);
    const processo = processoMatch ? processoMatch[1].trim() : '-';

    proposicoes.push({ id, tipo, numero, ementa, data, autor, processo, url });
  }

  return proposicoes;
}

// ─── Requisições ──────────────────────────────────────────────────────────────

const HEADERS_BASE = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isTransientHttpStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function isTransientNetworkError(err) {
  const message = String((err && err.message) || '').toLowerCase();
  return [
    'fetch failed',
    'econnreset',
    'etimedout',
    'eai_again',
    'socket hang up',
    'network',
    'timeout',
  ].some(fragment => message.includes(fragment));
}

async function fetchComRetry(url, options = {}, tentativas = 4) {
  let ultimoErro = null;

  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    try {
      const resp = await fetch(url, options);
      if (resp.ok || !isTransientHttpStatus(resp.status) || tentativa === tentativas) {
        return resp;
      }

      const texto = await resp.text().catch(() => '');
      console.warn('⚠️ Fonte instável (' + resp.status + ' ' + resp.statusText + ') na tentativa ' + tentativa + '/' + tentativas + ': ' + texto.substring(0, 120));
      ultimoErro = new FonteTransitoriaError('HTTP ' + resp.status + ' em fonte CMC-MT');
    } catch (err) {
      ultimoErro = err;
      if (tentativa === tentativas || !isTransientNetworkError(err)) {
        throw err;
      }
      console.warn('⚠️ Falha transitória de rede na tentativa ' + tentativa + '/' + tentativas + ': ' + err.message);
    }

    await sleep(15000 * tentativa);
  }

  throw ultimoErro || new FonteTransitoriaError('Falha transitória desconhecida na fonte CMC-MT');
}

function isTransientEmailError(err) {
  const responseCode = Number(err && err.responseCode);
  const message = String((err && err.message) || '').toLowerCase();
  return [421, 450, 451, 452].includes(responseCode) || message.includes('temporary') || message.includes('try again later');
}

async function carregarPaginaInicial() {
  const url = `${URL_BASE}?ano=${ANO}&ano_proposicao=${ANO}`;
  console.log(`📥 Carregando página inicial: ${url}`);

  const resp = await fetchComRetry(url, { headers: HEADERS_BASE });
  if (!resp.ok) {
    const msg = `HTTP ${resp.status} na página inicial`;
    if (isTransientHttpStatus(resp.status)) throw new FonteTransitoriaError(msg);
    throw new Error(msg);
  }

  const html = await resp.text();
  const viewState = extrairViewState(html);
  const viewStateGen = extrairViewStateGenerator(html);
  const eventValidation = extrairEventValidation(html);

  if (!viewState) throw new Error('Não foi possível extrair __VIEWSTATE');

  const proposicoesPag1 = parseProposicoes(html);
  const totalMatch = html.match(/Localizada\(s\)\s*<strong>(\d+)<\/strong>/);
  const total = totalMatch ? parseInt(totalMatch[1]) : 0;
  const totalPaginas = Math.ceil(total / ITENS_POR_PAGINA);
  const cookies = resp.headers.get('set-cookie') || '';

  console.log(`✅ Página inicial OK. Total: ${total} proposições (~${totalPaginas} págs com ${ITENS_POR_PAGINA}/pág)`);
  console.log(`📊 Página 1 (10 itens): ${proposicoesPag1.length} proposições`);

  return { viewState, viewStateGen, eventValidation, proposicoesPag1, total, totalPaginas, cookies };
}

async function mudarPara50Itens({ viewState, viewStateGen, eventValidation, cookies }) {
  const body = new URLSearchParams({
    'ctl00$scm_principal': 'ctl00$ContentPlaceHolder1$upp_consultaProducao|ctl00$ContentPlaceHolder1$ddl_ItensExibidos',
    '__EVENTTARGET': 'ctl00$ContentPlaceHolder1$ddl_ItensExibidos',
    '__EVENTARGUMENT': '',
    '__LASTFOCUS': '',
    '__VIEWSTATE': viewState,
    '__VIEWSTATEGENERATOR': viewStateGen || '',
    '__EVENTVALIDATION': eventValidation,
    'ctl00$ContentPlaceHolder1$id_proposicao': '123456',
    'ctl00$ContentPlaceHolder1$txt_nome': '',
    'ctl00$ContentPlaceHolder1$txt_email': '',
    'ctl00$ContentPlaceHolder1$txt_email_confirmacao': '',
    'ctl00$ContentPlaceHolder1$ddl_ItensExibidos': String(ITENS_POR_PAGINA),
    '__ASYNCPOST': 'true',
  });

  const resp = await fetchComRetry(`${URL_BASE}?ano=${ANO}&ano_proposicao=${ANO}`, {
    method: 'POST',
    headers: {
      ...HEADERS_BASE,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-MicrosoftAjax': 'Delta=true',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${URL_BASE}?ano=${ANO}&ano_proposicao=${ANO}`,
      ...(cookies ? { 'Cookie': cookies } : {}),
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const msg = `HTTP ${resp.status} ao mudar itens/página`;
    if (isTransientHttpStatus(resp.status)) throw new FonteTransitoriaError(msg);
    throw new Error(msg);
  }

  const texto = await resp.text();
  const novoViewState = extrairViewStateDeResposta(texto);
  const novoEventValidation = extrairEventValidationDeResposta(texto);
  const htmlPanel = extrairHtmlUpdatePanel(texto);
  const proposicoes = htmlPanel ? parseProposicoes(htmlPanel) : [];

  console.log(`✅ Mudou para ${ITENS_POR_PAGINA} itens/pág. Proposições: ${proposicoes.length}`);

  return {
    viewState: novoViewState || viewState,
    viewStateGen,
    eventValidation: novoEventValidation || eventValidation,
    proposicoes,
    pageTargets: extrairAlvosPaginacao(htmlPanel),
    cookies,
  };
}

async function buscarPagina(numeroPagina, estadoAtual) {
  const { viewState, viewStateGen, eventValidation, cookies, pageTargets = {} } = estadoAtual;
  const eventoTarget = pageTargets[String(numeroPagina)];
  if (!eventoTarget) {
    throw new Error(`Paginacao CMC-MT sem alvo para a pagina ${numeroPagina}; links disponiveis: ${Object.keys(pageTargets).join(', ') || 'nenhum'}`);
  }

  const body = new URLSearchParams({
    'ctl00$scm_principal': `ctl00$ContentPlaceHolder1$upp_consultaProducao|${eventoTarget}`,
    '__EVENTTARGET': eventoTarget,
    '__EVENTARGUMENT': '',
    '__LASTFOCUS': '',
    '__VIEWSTATE': viewState,
    '__VIEWSTATEGENERATOR': viewStateGen || '',
    '__EVENTVALIDATION': eventValidation,
    'ctl00$ContentPlaceHolder1$id_proposicao': '123456',
    'ctl00$ContentPlaceHolder1$txt_nome': '',
    'ctl00$ContentPlaceHolder1$txt_email': '',
    'ctl00$ContentPlaceHolder1$txt_email_confirmacao': '',
    'ctl00$ContentPlaceHolder1$ddl_ItensExibidos': String(ITENS_POR_PAGINA),
    '__ASYNCPOST': 'true',
  });

  const resp = await fetchComRetry(`${URL_BASE}?ano=${ANO}&ano_proposicao=${ANO}`, {
    method: 'POST',
    headers: {
      ...HEADERS_BASE,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-MicrosoftAjax': 'Delta=true',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${URL_BASE}?ano=${ANO}&ano_proposicao=${ANO}`,
      ...(cookies ? { 'Cookie': cookies } : {}),
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const msg = `HTTP ${resp.status} na página ${numeroPagina}`;
    if (isTransientHttpStatus(resp.status)) throw new FonteTransitoriaError(msg);
    throw new Error(msg);
  }

  const texto = await resp.text();
  const novoViewState = extrairViewStateDeResposta(texto);
  const novoEventValidation = extrairEventValidationDeResposta(texto);
  const htmlPanel = extrairHtmlUpdatePanel(texto);
  const proposicoes = htmlPanel ? parseProposicoes(htmlPanel) : [];
  const idsAnteriores = new Set((estadoAtual.proposicoes || []).map(item => String(item.id)));
  if (proposicoes.length > 0 && proposicoes.every(item => idsAnteriores.has(String(item.id)))) {
    throw new Error(`Paginacao CMC-MT nao avancou para a pagina ${numeroPagina}; resposta repetiu a pagina anterior`);
  }

  return {
    viewState: novoViewState || viewState,
    viewStateGen,
    eventValidation: novoEventValidation || eventValidation,
    proposicoes,
    pageTargets: extrairAlvosPaginacao(htmlPanel),
    cookies,
  };
}

// ─── Lógica principal ─────────────────────────────────────────────────────────

async function buscarProposicoes(idsVistos, primeiroRun) {
  const inicial = await carregarPaginaInicial();
  await sleep(1500);

  let estadoAtual = await mudarPara50Itens(inicial);
  await sleep(1500);

  let novasNaPagina = estadoAtual.proposicoes.filter(p => !idsVistos.has(p.id));

  if (!primeiroRun && novasNaPagina.length === 0) {
    console.log('✅ Nenhuma novidade na primeira página. Parando.');
    return [];
  }

  const todasProposicoes = [...estadoAtual.proposicoes];
  const totalPaginas = Math.ceil(inicial.total / ITENS_POR_PAGINA);
  const maxPag = primeiroRun
    ? Math.min(MAX_PAGINAS_PRIMEIRO_RUN, totalPaginas)
    : Math.min(MAX_PAGINAS_INCREMENTAL, totalPaginas);
  let parouPorPaginaConhecida = false;

  for (let pag = 2; pag <= maxPag; pag++) {
    console.log(`📄 Página ${pag}/${maxPag}...`);
    await sleep(2000);

    try {
      estadoAtual = await buscarPagina(pag, estadoAtual);
      console.log(`   → ${estadoAtual.proposicoes.length} proposições`);
      todasProposicoes.push(...estadoAtual.proposicoes);

      if (!primeiroRun) {
        novasNaPagina = estadoAtual.proposicoes.filter(p => !idsVistos.has(p.id));
        if (novasNaPagina.length === 0) {
          console.log(`✅ Sem novidades na página ${pag}. Parando.`);
          parouPorPaginaConhecida = true;
          break;
        }
      }
    } catch (err) {
      if (err instanceof FonteTransitoriaError || isTransientNetworkError(err)) {
        throw err;
      }
      console.error(`❌ Erro na página ${pag}: ${err.message}`);
      break;
    }
  }

  const novasMonitoradas = todasProposicoes.filter(p => !idsVistos.has(p.id) && tipoMonitorado(p.tipo));

  if (!primeiroRun && !parouPorPaginaConhecida && maxPag < totalPaginas) {
    throw new EstadoDefasadoError(
      'Estado CMC-MT parece defasado: ' + maxPag + ' paginas recentes ainda tinham IDs nao vistos ' +
      '(' + novasMonitoradas.length + ' proposicoes monitoradas novas ate aqui; total da fonte ~' + totalPaginas + ' paginas). ' +
      'Execucao bloqueada para evitar varrer backlog gigante e enviar email estourado. ' +
      'Proximo passo: revisar/resemear estado.json em rodada controlada antes de reativar envio.'
    );
  }

  if (novasMonitoradas.length > MAX_NOVIDADES_EMAIL) {
    throw new EstadoDefasadoError(
      'CMC-MT gerou ' + novasMonitoradas.length + ' novidades monitoradas em uma rodada incremental. ' +
      'Limite seguro: ' + MAX_NOVIDADES_EMAIL + '. Bloqueado para evitar email estourado; revisar estado.json antes de envio.'
    );
  }

  return novasMonitoradas;
}

// ─── Email ────────────────────────────────────────────────────────────────────

const ORDEM_TIPOS = [
  'Projeto de Lei',
  'Projeto de Lei Complementar',
  'Projeto de Lei Substitutivo',
  'Projeto de Lei Complementar Substitutivo',
  'Projeto de Decreto Legislativo',
  'Projeto de Decreto de Legislativo Substitutivo',
  'Projeto de Resolução',
  'Proposta de Emenda à Lei Orgânica',
  'Veto',
  'Indicação',
  'Requerimento de Informações',
  'Requerimento de Audiência Pública',
  'Requerimento de Instauração de Comissão Parlamentar de Inquérito',
];

function ordemTipo(tipo) {
  const idx = ORDEM_TIPOS.findIndex(t => t.toLowerCase() === tipo.toLowerCase());
  return idx === -1 ? 99 : idx;
}


const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario',
  'Boticário', 'Grupo Boticario', 'Grupo Boticário', 'O Boticario',
  'O Boticário', 'Abrasel', 'Abrasel PB', 'Abrasel Paraíba',
  'ANBRASEL', 'Ambev', 'Heineken', 'Abralatas',
  'ABIR', 'Coca-Cola', 'Coca Cola', 'Coca-Cola Company',
  'Femsa', 'Solar', 'Grupo Simões', 'Grupo Simoes',
  'Andina', 'CVI', 'iFood', 'Zé Delivery',
  'Ze Delivery', 'Verde Brasil', 'JCRIG', 'Associação dos Cemitérios e Crematórios do Brasil',
  'Associacao dos Cemiterios e Crematorios do Brasil', 'Lalamove', 'Matrix', 'CVC',
  'Rei do Pitaco', 'Maersk', 'Mac Jee', 'Norte Energia',
  'Pacto Pela Fome', 'Sanofi', 'TikTok', 'Minalba',
  'Esmaltec', 'Nacional Gás', 'Nacional Gas', 'Syngenta',
  'Braskem', 'Ypê', 'Ype', 'VTal',
  'V.tal', 'Grupo EPR', 'EPR', 'Natural Energia',
  'DIAGEO', 'Alpargatas', 'Ternium', 'ABRADEE',
  'Eletrobras', 'Eletrobrás', 'MeetKai', 'IPQ',
  'Equatorial', 'EquatorialEnergia', 'Equatorial Energia', 'Equatorial Goiás',
  'Equatorial Goias', 'Equatorial Goiás Distribuidora de Energia', 'Equatorial Goias Distribuidora de Energia', 'CEA Equatorial',
  'CEA Equatorial Energia', 'Equtorial', 'Energisa', 'EnergisaLuz',
  'Neoenergia', 'ENEL', 'Ampla Energia', 'SABESP',
  'COMGAS', 'COMGÁS', 'AEGEA', 'Aegea Saneamento',
  'Águas de Teresina', 'Aguas de Teresina', 'Águas de Timon', 'Aguas de Timon',
  'Águas do Rio', 'Aguas do Rio', 'Águas do Rio 1', 'Águas do Rio 4',
  'Naturgy', 'Agenersa', 'Regenera', 'Comlurb',
  'Hekos', 'Orizon', 'Solvi', 'União Norte',
  'Uniao Norte', 'Vital', 'Eletromidia', 'Eletromídia',
  'AkzoNobel', 'Expedia', 'Hotels.com', 'Vrbo',
  'RTSC', 'Gramado Parks', 'Grupo Wish', 'Huawei',
  'Carrefour', 'Atacadão', 'Atacadao', 'Walmart',
  "Sam's Club", 'Sams Club', 'JBS', 'Friboi',
  'Seara', 'Swift', "Pilgrim's", 'Pilgrims',
  'Wild Fork', 'Ajinomoto', 'Vibra', 'Vibra Energia',
  'BR Distribuidora', 'Raízen', 'Raizen', 'Mindlab',
  'ABVTEX', 'Semove', 'Barcas', 'Seta',
  'Nova Infra'
];

const CLIENTES_INATIVOS_NAO_DESTACAR = [
  'CVC', 'DIAGEO', 'Femsa', 'Lalamove', 'lalamove',
  'Maersk', 'Matrix', 'Rei do Pitaco', 'Sanofi', 'Syngenta',
  'Ypê', 'Ype', 'Braskem', 'Vital', 'Natural Energia',
  'Pacto Pela Fome', 'TikTok', 'Norte Energia', 'Mac Jee',
  'Solar', 'Grupo Simões', 'Grupo Simoes'
];

function clienteAtivoParaDestaque(nome) {
  return !CLIENTES_INATIVOS_NAO_DESTACAR.some(inativo => inativo.toLowerCase() === String(nome || '').toLowerCase());
}

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    if (!clienteAtivoParaDestaque(nome)) continue;
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return promoverInteresseClienteProposicao(p, achados, mlClientInterestContext());
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    p.clientesCitados = clientes;
    if (clientes.length && p.ementa && !(String(p.ementa).includes('Cliente citado:') || String(p.ementa).includes('CLIENTE CITADO:'))) {
      p.ementa = String(p.ementa).trim() + ' | Cliente citado: ' + clientes.join(', ');
    }
  }
}

function mlEscapeHtmlClienteDestaque(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mlEscapeRegExpClienteDestaque(valor) {
  return String(valor).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function mlDestacarTermosClienteEmail(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .filter(clienteAtivoParaDestaque)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return mlEscapeHtmlClienteDestaque(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(mlEscapeRegExpClienteDestaque).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return mlEscapeHtmlClienteDestaque(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#fff1f2;color:#991b1b;font-weight:800;border:1px solid #fecdd3;border-radius:3px;padding:1px 4px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+(?:🆘\s*)?CLIENTE CITADO:\s+|\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | Cliente citado: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#fff1f2;border:1px solid #fb7185;color:#991b1b;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0">' +
    '🆘 CLIENTE CITADO: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}


function clientesCitadosResumoEmail(novas) {
  const nomes = [];
  for (const p of novas || []) {
    for (const nome of (Array.isArray(p && p.clientesCitados) ? p.clientesCitados : [])) {
      if (nome && !nomes.some(n => n.toLowerCase() === String(nome).toLowerCase())) nomes.push(String(nome));
    }
  }
  return nomes;
}

function assuntoEmailClienteCitado(novas, assuntoBase) {
  const nomes = clientesCitadosResumoEmail(novas);
  if (!nomes.length) return assuntoBase;
  const lista = nomes.slice(0, 3).join(', ') + (nomes.length > 3 ? ' +' + (nomes.length - 3) : '');
  const base = String(assuntoBase || '');
  return base.startsWith('🆘') ? base : '🆘 Cliente citado: ' + lista + ' | ' + base;
}

function radar03Numero(p) {
  const numero = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const ano = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (!numero) return '';
  if (numero.includes('/') || !ano) return numero;
  return numero + '/' + ano;
}


function radar03NumeroPartes(p) {
  const numeroRaw = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const anoRaw = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (!numeroRaw) return null;

  const match = numeroRaw.match(/^(\d+)\s*\/\s*(\d{2,4})$/);
  const numero = match ? match[1] : numeroRaw;
  const ano = match ? match[2] : anoRaw;
  const numeroInt = parseInt(numero, 10);
  if (!Number.isFinite(numeroInt)) return null;

  return {
    numero,
    numeroInt,
    ano: ano && ano.length === 2 ? '20' + ano : ano,
  };
}


function radar03BlocoEmail(novas) {
  return radar03AgruparNovidades(novas)
    .map(item => {
      const total = Array.isArray(item.itens) ? item.itens.length : 1;
      const principal = item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '');
      return total > 1 ? principal + ' +' + (total - 1) + ' item(ns)' : principal;
    })
    .join(' | ');
}

function radar03PrimeiraFonte(novas) {
  const item = (novas || []).find(p => p?.link || p?.url || p?.fonte || p?.projeto_url);
  return item ? String(item.link || item.url || item.fonte || item.projeto_url || '') : '';
}


function radar03TipoControle(tipo) {
  const normal = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  const mapa = {
    'PROJETO DE LEI': 'PL', 'PROJETO LEI': 'PL', 'PROJETO DE LEI ORDINARIA': 'PL', 'PLO': 'PL', 'PL': 'PL', 'PL - PROJETO DE LEI': 'PL', 'PL PROJETO DE LEI': 'PL',
    'PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC': 'PLC', 'PLC - PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC PROJETO DE LEI COMPLEMENTAR': 'PLC',
    'PROPOSTA DE EMENDA A CONSTITUICAO': 'PEC', 'PEC': 'PEC', 'PEC - PROPOSTA DE EMENDA CONSTITUCIONAL': 'PEC', 'PEC PROPOSTA DE EMENDA CONSTITUCIONAL': 'PEC',
    'PROJETO DE DECRETO LEGISLATIVO': 'PDL', 'PDL': 'PDL',
    'PROJETO DE RESOLUCAO': 'PR', 'PR': 'PR',
    'PROJETO DE INDICACAO': 'PIL', 'PIL': 'PIL', 'PIL - PROJETO DE INDICACAO': 'PIL', 'PIL PROJETO DE INDICACAO': 'PIL',
    'INDICACAO': 'IND', 'MOCAO': 'MOC', 'REQUERIMENTO': 'REQ', 'REQ.': 'REQ',
    'REQUERIMENTO DE INFORMACAO': 'REQINF', 'RI': 'REQINF', 'VETO': 'VETO',
  };
  return mapa[normal] || String(tipo || '').trim().toUpperCase();
}

function radar03DiaUtilAtual() {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date());
  const d = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w] || 0;
  if (d === 0 || d === 6) return 4;
  return Math.max(0, Math.min(4, d - 1));
}

function radar03AuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = CONTROLE03_BASIC_AUTH || (
    CONTROLE03_API_USER && CONTROLE03_API_PASS
      ? Buffer.from(CONTROLE03_API_USER + ':' + CONTROLE03_API_PASS).toString('base64')
      : ''
  );
  if (token) headers.Authorization = token.startsWith('Basic ') ? token : 'Basic ' + token;
  return headers;
}

function radar03AgruparNovidades(novas) {
  const porTipo = new Map();
  (novas || []).forEach(p => {
    const tipo = radar03TipoControle(p?.tipo || p?.sigla || p?.rotulo || '');
    const partes = radar03NumeroPartes(p);
    if (!tipo || !partes) return;
    const itemCaptado = {
      tipo,
      numeroInt: partes.numeroInt,
      numero: partes.numero,
      ano: partes.ano || String(p?.ano || ''),
      id: String(p?.id || p?.codigo || p?.projeto_id || p?.id_proposicao || ''),
      ementa: String(p?.ementa || p?.resumo || p?.titulo || '').trim(),
      link: String(p?.link || p?.url || p?.fonte || p?.projeto_url || '').trim(),
      clienteSugestao: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
      clienteCitado: Array.isArray(p?.clientesCitados) && p.clientesCitados.length > 0,
      clienteCitadoNomes: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
    };
    let atual = porTipo.get(tipo);
    if (!atual) {
      atual = { ...itemCaptado, itens: [] };
      porTipo.set(tipo, atual);
    }
    atual.itens.push(itemCaptado);
    if (partes.numeroInt > atual.numeroInt) {
      atual.numeroInt = partes.numeroInt;
      atual.numero = partes.numero;
      atual.ano = partes.ano || String(p?.ano || '');
      atual.id = itemCaptado.id;
      atual.ementa = itemCaptado.ementa;
      atual.link = itemCaptado.link;
      atual.clienteSugestao = itemCaptado.clienteSugestao;
    }
  });
  return Array.from(porTipo.values()).map(rec => {
    rec.itens.sort((a, b) => a.numeroInt - b.numeroInt);
    return rec;
  });
}

function radar03DetalhesControle03(rec) {
  const detalhes = Array.isArray(rec.itens) && rec.itens.length ? rec.itens : [rec];
  const comCliente = detalhes.filter(item => item.clienteCitado);
  if (rec.tipo !== 'IND' || comCliente.length) return detalhes;
  if (detalhes.length <= 3) return detalhes;
  return [{
    tipo: rec.tipo,
    numeroInt: rec.numeroInt,
    numero: rec.numero,
    ano: rec.ano,
    id: rec.id,
    ementa: detalhes.length + ' indicações captadas na fonte de Cuiabá. Consolidado por tipo para não transformar zeladoria urbana em fila individual da 03.',
    link: rec.link,
    clienteSugestao: '',
    clienteCitado: false,
    clienteCitadoNomes: '',
  }];
}

async function sincronizarRadar03(novas) {
  const resumo = radar03AgruparNovidades(novas);
  if (!resumo.length) return;
  try {
    const getResp = await fetch(CONTROLE03_STATE_URL, { headers: radar03AuthHeaders() });
    if (!getResp.ok) throw new Error('GET ' + getResp.status);
    const state = await getResp.json();
    if (!Array.isArray(state.data)) throw new Error('estado central vazio ou inválido');

    const data = state.data;
    let casa = data.find(item => item && item.casa === CASA_RADAR03);
    if (!casa) {
      casa = { casa: CASA_RADAR03, casaId: CASA_RADAR03, regiao: '', responsavel: '', risco: 'media', status: 'A conferir', week: ['off', 'off', 'off', 'off', 'off'], items: [] };
      data.push(casa);
    }
    if (!Array.isArray(casa.items)) casa.items = [];
    if (!Array.isArray(casa.week)) casa.week = ['off', 'off', 'off', 'off', 'off'];
    while (casa.week.length < 5) casa.week.push('off');

    resumo.forEach(rec => {
      const detalhes = radar03DetalhesControle03(rec);
      const existentesTipo = casa.items.filter(i => radar03TipoControle(i?.tipo || '') === rec.tipo);
      const baseAtual = existentesTipo.reduce((max, i) => {
        const n = Number.parseInt(String(i?.base || i?.mon || 0), 10) || 0;
        return Math.max(max, n);
      }, 0);

      detalhes.forEach(det => {
        let item = casa.items.find(i =>
          (det.id && i?.radar03Id === det.id) ||
          (radar03TipoControle(i?.tipo || '') === det.tipo &&
            Number.parseInt(String(i?.mon || 0), 10) === det.numeroInt &&
            String(i?.link || '') === String(det.link || ''))
        );
        if (!item) {
          item = { tipo: det.tipo, base: baseAtual, mon: det.numeroInt, radar03Id: det.id || '' };
          casa.items.push(item);
        }

        const base = Number.parseInt(String(item.base || baseAtual || 0), 10) || 0;
        item.tipo = det.tipo;
        item.mon = det.numeroInt;
        item.delta = det.numeroInt === base ? 0 : 1;
        item.sentido = det.numeroInt === base ? 'bate com o controle' : 'captado individualmente na fonte';
        item.fluxo = item.delta ? 'nao_consultado' : (item.fluxo || 'revisado');
        item.ementa = det.ementa || item.ementa || '';
        item.link = det.link || item.link || '';
        item.clienteSugestao = det.clienteSugestao || item.clienteSugestao || '';
        item.clienteCitado = Boolean(det.clienteCitado || item.clienteCitado);
        item.clienteCitadoNomes = det.clienteCitadoNomes || item.clienteCitadoNomes || item.clienteSugestao || '';
        item.radar03Id = det.id || item.radar03Id || '';
        item.listaReal03 = true;
      });
    });

    casa.status = 'Atualizar 03';
    casa.week[radar03DiaUtilAtual()] = 'leva';
    if (!Array.isArray(casa.obs03)) casa.obs03 = [];
    casa.obs03.push({
      tipo: CASA_RADAR03,
      situacao: 'novo',
      label: 'Rodada sincronizada automaticamente na 03',
      base: radar03BlocoEmail(novas),
      fonte: 'monitor-proposicoes',
      at: new Date().toISOString(),
    });

    const postResp = await fetch(CONTROLE03_STATE_URL, {
      method: 'POST', headers: radar03AuthHeaders(), body: JSON.stringify({ data, merge_casas: [CASA_RADAR03] }),
    });
    if (!postResp.ok) throw new Error('POST ' + postResp.status);
    console.log('✅ Radar 03 sincronizado: ' + CASA_RADAR03 + ' · ' + radar03BlocoEmail(novas));
  } catch (err) {
    console.warn('⚠️ Não foi possível sincronizar o Radar 03 automaticamente: ' + err.message);
  }
}

function radar03ReviewUrl(novas) {
  const params = new URLSearchParams({
    casa: CASA_RADAR03,
    bloco: radar03BlocoEmail(novas),
    fonte: radar03PrimeiraFonte(novas),
  });
  return `${RADAR03_URL}?${params.toString()}`;
}


function radar03SemNovidadeUrl() {
  const params = new URLSearchParams({
    casa: CASA_RADAR03,
    situacao: 'sem_novidade',
    fonte: 'monitor-proposicoes',
  });
  return RADAR03_URL + '?' + params.toString();
}

function radar03Escape(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function renderRadar03SemNovidadeEmailButton() {
  return '\n    <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:6px;padding:12px 14px;margin:14px 0;color:#334155;font-size:13px">\n      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Sem novidades</div>\n      <div style="margin-bottom:9px;color:#475569">' + radar03Escape(CASA_RADAR03) + ' · fonte vista sem proposição nova nesta rodada</div>\n      <a href="' + radar03Escape(radar03SemNovidadeUrl()) + '" style="display:inline-block;background:#475569;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Marcar sem novidade na 03</a>\n      <span style="font-size:12px;color:#64748b;margin-left:8px">abre a 03 pronta para fechar o dia</span>\n    </div>\n  ';
}

function renderRadar03EmailButton(novas) {
  const bloco = radar03BlocoEmail(novas);
  if (!bloco) return renderRadar03SemNovidadeEmailButton();
  return `
    <div style="background:#ecfdf3;border:1px solid #bbf7d0;border-radius:6px;padding:12px 14px;margin:14px 0;color:#14532d;font-size:13px">
      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Novas Proposições</div>
      <div style="margin-bottom:9px;color:#166534">${radar03Escape(CASA_RADAR03)} · ${radar03Escape(bloco)}</div>
      <a href="${radar03Escape(radar03ReviewUrl(novas))}" style="display:inline-block;background:#166534;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Revisar no Radar 03</a>
      <span style="font-size:12px;color:#64748b;margin-left:8px">abre preenchido para confirmação</span>
    </div>
  `;
}


async function enviarEmail(novas) {
  if (CONTROLE03_FORCE_LATEST) {
    console.log('📌 Modo Controle 03: email de novidades não enviado.');
    return;
  }

  anotarClientesCitados(novas);
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  const porTipo = {};
  novas.forEach(p => {
    const tipo = p.tipo || 'OUTROS';
    if (!porTipo[tipo]) porTipo[tipo] = [];
    porTipo[tipo].push(p);
  });

  const tiposOrdenados = Object.keys(porTipo).sort((a, b) => ordemTipo(a) - ordemTipo(b));

  const linhas = tiposOrdenados.map(tipo => {
    const header = `<tr><td colspan="5" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#003366;font-size:13px;border-top:2px solid #003366">${tipo} — ${porTipo[tipo].length} proposição(ões)</td></tr>`;
    const rows = porTipo[tipo]
      .sort((a, b) => (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0))
      .map(p => {
        const numero = p.url
          ? `<a href="${p.url}" style="color:#003366;text-decoration:none"><strong>${p.numero || '-'}/${ANO}</strong></a>`
          : `<strong>${p.numero || '-'}/${ANO}</strong>`;

        return `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${p.tipo || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">${numero}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.autor || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${p.data ? p.data.substring(0, 16) : '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${renderizarEmentaCliente(p)}</td>
      </tr>`;
      }).join('');
    return header + rows;
  }).join('');

  const html = `
      ${renderRadar03EmailButton(novas)}
    <div style="font-family:Arial,sans-serif;max-width:960px;margin:0 auto">
      <h2 style="color:#003366;border-bottom:2px solid #003366;padding-bottom:8px">
        🏛️ ${NOME_CASA} — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666;font-size:13px">Monitoramento automático · ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#003366;color:white">
            <th style="padding:10px;text-align:left">Tipo</th>
            <th style="padding:10px;text-align:left">Número</th>
            <th style="padding:10px;text-align:left">Autor</th>
            <th style="padding:10px;text-align:left">Data</th>
            <th style="padding:10px;text-align:left">Ementa</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Acesse: <a href="https://legislativo.camaracuiaba.mt.gov.br/spl/consulta-producao.aspx?ano=${ANO}&ano_proposicao=${ANO}">Portal da Câmara Municipal de Cuiabá</a>
      </p>
    </div>
  `;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_EMAIL; tentativa++) {
    try {
      await transporter.sendMail({
        from: `"Monitor Câmara Municipal de Cuiabá" <${EMAIL_REMETENTE}>`,
        to: EMAIL_DESTINO,
        subject: assuntoEmailClienteCitado(novas, `🏛️ Cuiabá: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`),
        html: fichaEmailButtonHtml() + html,
      });

      console.log(`✅ Email enviado: ${novas.length} proposições novas.`);
      return;
    } catch (err) {
      if (tentativa >= MAX_TENTATIVAS_EMAIL || !isTransientEmailError(err)) {
        throw err;
      }

      const esperaMs = tentativa * 5000;
      console.warn(`⚠️ Falha temporária ao enviar email (tentativa ${tentativa}/${MAX_TENTATIVAS_EMAIL}): ${err.message}`);
      console.warn(`↻ Retentando em ${esperaMs / 1000}s...`);
      await sleep(esperaMs);
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

(async () => {
  console.log('🚀 Monitor CMC-MT iniciado');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);
  console.log(`🔍 Tipos monitorados: ${TIPOS_MONITORADOS.length}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas.map(String));
  const primeiroRun = idsVistos.size === 0;

  console.log(`📁 IDs já vistos: ${idsVistos.size} | Primeiro run: ${primeiroRun}`);

  try {
    const novas = await buscarProposicoes(idsVistos, primeiroRun);
    console.log(`🆕 Proposições novas (tipos monitorados): ${novas.length}`);

    if (novas.length > 0) {
      await sincronizarRadar03(novas);
    await enviarEmail(novas);
      novas.forEach(p => idsVistos.add(String(p.id)));
    } else {
      console.log('✅ Sem novidades nos tipos monitorados. Nada a enviar.');
    }

    estado.proposicoes_vistas = Array.from(idsVistos);
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);

  } catch (err) {
    console.error(`❌ Erro fatal: ${err.message}`);
    if (err instanceof EstadoDefasadoError) {
      console.error(`::error title=CMC-MT estado defasado::${err.message}`);
      process.exit(EXIT_OPERATIONAL_BLOCK);
    }
    if (err instanceof FonteTransitoriaError || isTransientNetworkError(err)) {
      console.error(`::warning title=CMC-MT fonte instável::${err.message}`);
      process.exit(EXIT_TRANSIENT_SOURCE);
    }
    console.error(err.stack);
    process.exit(1);
  }
})();
