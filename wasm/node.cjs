// The employee model in Node, from the build the site ships (js/wasm/,
// written by wasm/build.sh or wasm/fetch.sh), for scripts that run the
// model in Node, such as CI's smoke check. It isn't shipped.
//
//   require('./wasm/node.cjs')()           this checkout's js/
//   require('./wasm/node.cjs')(js)         the js/ directory `js`
//   require('./wasm/node.cjs')(js, glue)   `js`'s loader over another
//                                          no-modules glue, with its
//                                          _bg.wasm beside it
//
// The glue is a classic script that declares `let wasm_bindgen`: run as a
// function body, the binding stays local, so one glue can't shadow
// another's. initSync instantiates its .wasm in place of the page's fetch,
// and the glue becomes the global wasm_bindgen, the name the page sees.
// Then js/employee-model.js loads afresh over it, and in Node it is ready
// as soon as it loads. Each call gives a fresh instance, so one process can
// load two checkouts. Returns EmployeeModel.
const fs = require('node:fs');
const path = require('node:path');

module.exports = function load(js = path.join(__dirname, '../js'), glue = path.join(js, 'wasm/employee_model.js')) {
  const wasm = glue.replace(/\.js$/, '_bg.wasm');
  for (const f of [glue, wasm]) {
    if (!fs.existsSync(f)) throw Error(`No build of the employee model at ${f}: run wasm/fetch.sh (CI's build, needs gh) or wasm/build.sh (needs Rust)`);
  }
  const source = fs.readFileSync(glue, 'utf8');
  const bindgen = new Function(`${source}\nreturn wasm_bindgen;`)();
  bindgen.initSync({ module: fs.readFileSync(wasm) });
  globalThis.wasm_bindgen = bindgen;
  const loader = require.resolve(path.join(js, 'employee-model.js'));
  delete require.cache[loader];
  const model = require(loader);
  if (!model?.api) throw Error(`The employee model did not start from ${glue}.`);
  return model;
};
