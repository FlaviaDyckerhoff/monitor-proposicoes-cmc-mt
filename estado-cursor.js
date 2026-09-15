function registrarIdsObservados(idsVistos, proposicoes) {
  for (const proposicao of proposicoes || []) {
    if (proposicao && proposicao.id !== undefined && proposicao.id !== null) {
      idsVistos.add(String(proposicao.id));
    }
  }
  return idsVistos;
}

module.exports = { registrarIdsObservados };
