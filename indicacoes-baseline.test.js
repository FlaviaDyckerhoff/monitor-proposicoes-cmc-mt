const assert = require('assert');
const { separarLoteEmail } = require('./monitor');

const lote = [
  { id: '1', tipo: 'Indicação', numero: '10' },
  { id: '2', tipo: 'INDICAÇÃO', numero: '11' },
  { id: '3', tipo: 'Projeto de Lei', numero: '12' },
  { id: '4', tipo: 'Requerimento de Informações', numero: '13' },
];

const padrao = separarLoteEmail(lote);
assert.deepStrictEqual(padrao.baselineSemEmail.map(item => item.id), ['1', '2']);
assert.deepStrictEqual(padrao.paraEmail.map(item => item.id), ['3', '4']);

const inclusivo = separarLoteEmail(lote, false);
assert.deepStrictEqual(inclusivo.baselineSemEmail, []);
assert.deepStrictEqual(inclusivo.paraEmail.map(item => item.id), ['1', '2', '3', '4']);

console.log('OK: Indicações ficam no baseline silencioso por padrão');
