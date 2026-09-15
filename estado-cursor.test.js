const assert = require('node:assert/strict');
const { registrarIdsObservados } = require('./estado-cursor');

const vistos = new Set(['100']);
registrarIdsObservados(vistos, [
  { id: 101, tipo: 'Moção' },
  { id: '102', tipo: 'Projeto de Lei' },
  { id: 103, tipo: 'Requerimento de Sessão' },
]);

assert.deepEqual([...vistos], ['100', '101', '102', '103']);
console.log('estado-cursor: ok');
