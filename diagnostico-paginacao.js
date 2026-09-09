const {
  carregarPaginaInicial,
  mudarPara50Itens,
  buscarPagina,
  tipoMonitorado,
} = require('./monitor');
const fs = require('fs');

async function main() {
  const inicial = await carregarPaginaInicial();
  let estado = await mudarPara50Itens(inicial);
  const persistido = JSON.parse(fs.readFileSync('estado.json', 'utf8'));
  const vistos = new Set(persistido.proposicoes_vistas.map(String));
  const novas = [];

  function registrarPagina(pagina) {
    const desconhecidas = estado.proposicoes.filter(item => !vistos.has(String(item.id)));
    const monitoradas = desconhecidas.filter(item => tipoMonitorado(item.tipo));
    novas.push(...desconhecidas);
    console.log(JSON.stringify({
      pagina,
      itens: estado.proposicoes.length,
      desconhecidas: desconhecidas.length,
      monitoradas: monitoradas.length,
      primeiroId: estado.proposicoes[0] && estado.proposicoes[0].id,
      ultimoId: estado.proposicoes.at(-1) && estado.proposicoes.at(-1).id,
      links: Object.keys(estado.pageTargets),
    }));
    return monitoradas.length;
  }

  registrarPagina(1);

  for (let pagina = 2; pagina <= 20; pagina++) {
    estado = await buscarPagina(pagina, estado);
    if (registrarPagina(pagina) === 0) break;
  }

  const monitoradas = novas.filter(item => tipoMonitorado(item.tipo));
  const porTipo = monitoradas.reduce((acc, item) => {
    acc[item.tipo] = (acc[item.tipo] || 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({
    ultimaExecucao: persistido.ultima_execucao,
    desconhecidas: novas.length,
    monitoradas: monitoradas.length,
    porTipo,
    materiais: monitoradas
      .filter(item => !/^indica[cç][aã]o$/i.test(String(item.tipo || '')))
      .map(item => ({
        id: item.id,
        tipo: item.tipo,
        numero: item.numero,
        data: item.data,
        autor: item.autor,
        ementa: item.ementa,
        url: item.url,
      })),
  }, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
