// The n8n Code nodes get these files pasted in without the module.exports line, with no require available.
// Running them that way in a bare sandbox catches hidden dependencies and name clashes between files.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCES = ['ids', 'coarse', 'validate', 'view', 'cards', 'match'];
const pasted = (name) => fs.readFileSync(path.join(__dirname, `${name}.js`), 'utf8').replace(/^module\.exports.*$/m, '');

for (const name of SOURCES) {
  test(`${name}.js runs pasted, with no require`, () => {
    const exported = Object.keys(require(`./${name}`));
    const sandbox = vm.createContext({});
    vm.runInContext(`${pasted(name)}\nglobalThis.__defined = [${exported.map((e) => `typeof ${e}`).join(', ')}];`, sandbox);
    assert.deepEqual(sandbox.__defined, exported.map(() => 'function'));
  });
}

test('all sources can share one Code node without clashing', () => {
  assert.doesNotThrow(() => vm.runInContext(SOURCES.map(pasted).join('\n'), vm.createContext({})));
});
