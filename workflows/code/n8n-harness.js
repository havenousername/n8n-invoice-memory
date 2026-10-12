// Test helper: runs a generated Code node the way n8n does, as an async function body with
// $() for upstream nodes, $input/$json for its own input, and this.helpers for binary data.
const path = require('node:path');
const vm = require('node:vm');

function loadWorkflow(file) {
  return require(path.join(__dirname, '..', file));
}

function codeOf(workflow, nodeName) {
  const node = workflow.nodes.find((n) => n.name === nodeName);
  if (!node || node.type !== 'n8n-nodes-base.code') throw new Error(`no Code node named ${nodeName}`);
  return node.parameters.jsCode;
}

// upstream: { nodeName: [json, ...] }; input: [{ json, binary }]; binaryBuffers: { property: Buffer }
async function runCodeNode(workflow, nodeName, { upstream = {}, input = [{ json: {} }], binaryBuffers = {} } = {}) {
  const itemsOf = (name) => {
    if (!(name in upstream)) throw new Error(`the test gave no items for node ${name}`);
    return upstream[name].map((json) => ({ json }));
  };
  const $ = (name) => ({ first: () => itemsOf(name)[0], all: () => itemsOf(name) });
  const $input = { first: () => input[0], all: () => input };
  const helpers = {
    getBinaryDataBuffer: async (index, property) => {
      if (!binaryBuffers[property]) throw new Error(`no binary property ${property}`);
      return binaryBuffers[property];
    },
  };
  const context = vm.createContext({ $, $input, $json: input[0].json, Buffer });
  const body = vm.runInContext(`(async function () {\n${codeOf(workflow, nodeName)}\n})`, context);
  return body.call({ helpers });
}

module.exports = { loadWorkflow, runCodeNode };
