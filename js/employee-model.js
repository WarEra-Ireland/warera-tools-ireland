/*
 *  EMPLOYEE MODEL LOADER
 *  Instantiates the employee model, a Rust crate built to WASM by
 *  wasm/build.sh (wasm/README.md has the build and test notes).
 *  Load it right after its glue, js/wasm/employee_model.js, with the same
 *  ?v= tag: that one tag covers the glue, this file and the .wasm.
 *
 *    page    <script src="js/wasm/employee_model.js?v=T">, then this file;
 *            the .wasm tag is read from this script's own src.
 *    worker  importScripts('wasm/employee_model.js?v=T', 'employee-model.js?v=T'),
 *            with the tag passed in the worker URL as model=T.
 *    Node    the harness requires the --target nodejs build (instantiated
 *            on require) as the global wasm_bindgen, then this file.
 *
 *  Nothing may call the module before EmployeeModel.ready resolves. The
 *  router waits for it before activating the tools that use the model, and
 *  the planner worker queues its messages on it.
 *
 *  The glue declares `let wasm_bindgen`: a global binding other classic
 *  scripts see by name, but not a property of window or self.
 */
const EmployeeModel = (() => {
  const page = typeof document !== 'undefined';
  const worker = !page && typeof importScripts === 'function';
  const script = page ? document.currentScript?.src : null;
  const tag = (worker ? new URL(self.location.href).searchParams.get('model') : script?.match(/[?&]v=([\w.-]+)/)?.[1]) || '';
  const glue = typeof wasm_bindgen === 'undefined' ? null : wasm_bindgen;

  const freeze = v => {
    if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.values(v).forEach(freeze); Object.freeze(v); }
    return v;
  };

  // `api` is the module's exports: the facades (js/employee-core.js,
  // employee-planner.js) and the UI call it directly where no input needs
  // shaping. TABLES holds the other init-time tables (the defaults);
  // CHURN the planner's minimum gain, TOOL_TYPES each tool type's goods,
  // SPECIALIZATION how saved specialisation reads ({ percentPerDay,
  // maxPercent }), CHANGE_ITEM_COST a product switch's concrete,
  // SPIKE_RATIO a live margin's spike over the game's, MAX_REROLLS the
  // career simulation's Reroll cap.
  const model = { tag, ready: null, version: null, CFG: null, TRAIT_RULES: null, EXCLUSIVE: null, NUMERIC_CARDS: null, TABLES: null,
    CHURN: null, TOOL_TYPES: null, SPECIALIZATION: null, CHANGE_ITEM_COST: null, SPIKE_RATIO: null, MAX_REROLLS: null, Snapshot: null, api: null };

  // The game constants. traitProductionPaid is the module's switch for the
  // paid rule (off, as the game has it): setting it turns the rule on.
  function config() {
    const cfg = glue.config();
    delete cfg.traitProductionPaid;
    return Object.defineProperty(cfg, 'traitProductionPaid', { enumerable: true, get: () => glue.traitProductionPaid(), set: v => glue.setTraitProductionPaid(!!v) });
  }

  async function start() {
    if (!glue) throw Error('The employee model script (js/wasm/employee_model.js) did not load.');
    // In Node the glue is already instantiated. Elsewhere the path is always
    // passed: the glue's default doesn't survive a ?v= query.
    if (page || worker) {
      const base = worker ? self.location.href : script || location.href;
      await glue({ module_or_path: new URL(`wasm/employee_model_bg.wasm${tag ? `?v=${tag}` : ''}`, base) });
    }
    const planner = glue.plannerConstants();
    Object.assign(model, {
      version: glue.version(),
      CFG: freeze(config()),
      TRAIT_RULES: freeze(glue.traitRules()),
      EXCLUSIVE: freeze(glue.exclusivePairs()),
      NUMERIC_CARDS: freeze(glue.numericCards()),
      TABLES: freeze(glue.tables()),
      CHURN: freeze(planner.churn),
      TOOL_TYPES: freeze(glue.toolTypes()),
      SPECIALIZATION: freeze(planner.specialization),
      CHANGE_ITEM_COST: planner.changeItemCost,
      SPIKE_RATIO: planner.spikeRatio,
      MAX_REROLLS: glue.careerConstants().maxRerolls,
      Snapshot: glue.Snapshot,
      api: glue,
    });
    if (page || worker) console.info(`[model] employee model ${model.version} ready in the ${worker ? 'worker' : 'page'} (v=${tag || 'none'})`);
    return model;
  }

  model.ready = start();
  model.ready.catch(error => console.error("[model] Couldn't load the employee model:", error));
  return model;
})();

if (typeof module !== 'undefined') module.exports = EmployeeModel;
