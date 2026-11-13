// Starts the employee model in Node from the build the site ships
// (js/wasm/, --target no-modules), through wasm/node.cjs, and fails unless
// it starts and gives its version.
const loadModel = require('../../wasm/node.cjs');

(async () => {
  const model = loadModel();
  await model.ready;
  if (typeof model.version !== 'string' || !model.version) throw Error('The employee model gave no version.');
  console.log(`Employee model ${model.version}: js/wasm/ starts in Node.`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
