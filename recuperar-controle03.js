const {
  carregarPaginaInicial,
  mudarPara50Itens,
  buscarPagina,
  sincronizarRadar03,
} = require('./monitor');

const alvos = new Set(
  String(process.env.CONTROLE03_RECOVERY_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
);

async function main() {
  if (!alvos.size) throw new Error('CONTROLE03_RECOVERY_IDS vazio');

  const inicial = await carregarPaginaInicial();
  let estado = await mudarPara50Itens(inicial);
  const encontrados = new Map();

  for (let pagina = 1; pagina <= 20; pagina++) {
    if (pagina > 1) estado = await buscarPagina(pagina, estado);
    for (const item of estado.proposicoes) {
      if (alvos.has(String(item.id))) encontrados.set(String(item.id), item);
    }
    console.log(`📄 Recuperação Controle 03: página ${pagina}, ${encontrados.size}/${alvos.size} IDs encontrados`);
    if (encontrados.size === alvos.size) break;
  }

  const faltantes = [...alvos].filter(id => !encontrados.has(id));
  if (faltantes.length) throw new Error('IDs não encontrados na fonte: ' + faltantes.join(', '));

  const sincronizado = await sincronizarRadar03([...encontrados.values()]);
  if (!sincronizado) throw new Error('Controle 03 não confirmou a gravação');
  console.log(`✅ Recuperação Controle 03 concluída: ${encontrados.size} itens, sem email e sem alteração do estado local`);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
