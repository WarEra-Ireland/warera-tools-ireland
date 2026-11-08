let wasm_bindgen = (function(exports) {
    let script_src;
    if (typeof document !== 'undefined' && document.currentScript !== null) {
        script_src = new URL(document.currentScript.src, location.href).toString();
    }

    /**
     * `EmployeePlanner.cardSession`'s pricing over its prepared snapshot
     * (see pricing.rs). Its caches live as long as the handle.
     */
    class CardSession {
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            CardSessionFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_cardsession_free(ptr, 0);
        }
        /**
         * Over `snapshot` (with its exclusions and horizon); `unpriced`: trait
         * ids whose rows say unpriced.
         * @param {Snapshot} snapshot
         * @param {boolean} allow_moves
         * @param {Uint8Array | number[]} unpriced
         */
        constructor(snapshot, allow_moves, unpriced) {
            _assertClass(snapshot, Snapshot);
            const val2 = +allow_moves;
            const ptr0 = passArray8ToWasm0(unpriced, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.cardsession_new(snapshot.__wbg_ptr, val2, ptr0, len0);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            this.__wbg_ptr = ret[0];
            CardSessionFinalization.register(this, this.__wbg_ptr, this);
            return this;
        }
        /**
         * The planned companies' employees (indices): plans' equipment order.
         * @returns {Uint32Array}
         */
        people() {
            const ret = wasm.cardsession_people(this.__wbg_ptr);
            var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
            return v1;
        }
        /**
         * Plan `index` of a state a price made.
         * @param {number} state
         * @param {number} index
         * @returns {any}
         */
        plan(state, index) {
            const ret = wasm.cardsession_plan(this.__wbg_ptr, state, index);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * One price: the inputs merged by the facade.
         * @param {any} input
         * @returns {any}
         */
        price(input) {
            const ret = wasm.cardsession_price(this.__wbg_ptr, input);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
    }
    if (Symbol.dispose) CardSession.prototype[Symbol.dispose] = CardSession.prototype.free;
    exports.CardSession = CardSession;

    /**
     * The career simulation of one employee and hand (`careerOptions`): its
     * caches live as long as the handle, across `batch` runs.
     */
    class Career {
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            CareerFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_career_free(ptr, 0);
        }
        /**
         * `rules.advance` for the first state, from day `from` to day `to`.
         * @param {number} from
         * @param {number} to
         * @returns {any}
         */
        advanceFirst(from, to) {
            const ret = wasm.career_advanceFirst(this.__wbg_ptr, from, to);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * The outcome `rules.apply` picks for the first state.
         * @param {any} card
         * @param {number} draw
         * @returns {any}
         */
        applyFirst(card, draw) {
            const ret = wasm.career_applyFirst(this.__wbg_ptr, card, draw);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * A batch of `count` sampled careers from pair `start`.
         * @param {number} seed
         * @param {number} start
         * @param {number} count
         * @returns {CareerRun}
         */
        batch(seed, start, count) {
            const ret = wasm.career_batch(this.__wbg_ptr, seed, start, count);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return CareerRun.__wrap(ret[0]);
        }
        /**
         * @param {number} time
         * @returns {number}
         */
        energyCost(time) {
            const ret = wasm.career_energyCost(this.__wbg_ptr, time);
            return ret;
        }
        /**
         * The hand `rules.hand` deals the state after the first card `card`
         * (its outcome by `pick`), when every draw is `draw`.
         * @param {any} card
         * @param {number} pick
         * @param {number} draw
         * @returns {any}
         */
        handAfter(card, pick, draw) {
            const ret = wasm.career_handAfter(this.__wbg_ptr, card, pick, draw);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * The hand `rules.hand` deals the first state when every draw is `draw`.
         * @param {number} draw
         * @returns {any}
         */
        handFirst(draw) {
            const ret = wasm.career_handFirst(this.__wbg_ptr, draw);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * The work done so far.
         * @returns {any}
         */
        metrics() {
            const ret = wasm.career_metrics(this.__wbg_ptr);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * The careers of employee `subject` (a place in `snapshot`, see
         * `career::Model::new`), with the subject's rules, energy and hand.
         * @param {Snapshot} snapshot
         * @param {number} subject
         * @param {any} input
         */
        constructor(snapshot, subject, input) {
            _assertClass(snapshot, Snapshot);
            const ret = wasm.career_new(snapshot.__wbg_ptr, subject, input);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            this.__wbg_ptr = ret[0];
            CareerFinalization.register(this, this.__wbg_ptr, this);
            return this;
        }
        /**
         * `rules.next` for the first state.
         * @param {number} time
         * @returns {number}
         */
        next(time) {
            const ret = wasm.career_next(this.__wbg_ptr, time);
            return ret;
        }
        /**
         * The hand's slots that can't be taken.
         * @returns {Uint32Array}
         */
        skipped() {
            const ret = wasm.career_skipped(this.__wbg_ptr);
            var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
            return v1;
        }
        /**
         * The hand's slots that are arms, after taking nothing.
         * @returns {Uint32Array}
         */
        slots() {
            const ret = wasm.career_slots(this.__wbg_ptr);
            var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
            return v1;
        }
    }
    if (Symbol.dispose) Career.prototype[Symbol.dispose] = Career.prototype.free;
    exports.Career = Career;

    /**
     * A batch in progress: `step(n)` runs up to n transitions.
     */
    class CareerRun {
        static __wrap(ptr) {
            const obj = Object.create(CareerRun.prototype);
            obj.__wbg_ptr = ptr;
            CareerRunFinalization.register(obj, obj.__wbg_ptr, obj);
            return obj;
        }
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            CareerRunFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_careerrun_free(ptr, 0);
        }
        /**
         * @returns {any}
         */
        progress() {
            const ret = wasm.careerrun_progress(this.__wbg_ptr);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * @returns {any}
         */
        result() {
            const ret = wasm.careerrun_result(this.__wbg_ptr);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * True once every career is done.
         * @param {number} transitions
         * @returns {boolean}
         */
        step(transitions) {
            const ret = wasm.careerrun_step(this.__wbg_ptr, transitions);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return ret[0] !== 0;
        }
    }
    if (Symbol.dispose) CareerRun.prototype[Symbol.dispose] = CareerRun.prototype.free;
    exports.CareerRun = CareerRun;

    /**
     * A fresh set's value; `beat(bar)` reads its picks.
     */
    class FreshSet {
        static __wrap(ptr) {
            const obj = Object.create(FreshSet.prototype);
            obj.__wbg_ptr = ptr;
            FreshSetFinalization.register(obj, obj.__wbg_ptr, obj);
            return obj;
        }
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            FreshSetFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_freshset_free(ptr, 0);
        }
        /**
         * @param {number} bar
         * @returns {number}
         */
        beat(bar) {
            const ret = wasm.freshset_beat(this.__wbg_ptr, bar);
            return ret;
        }
        /**
         * `{ best, gross, days, rate, average, coworkers }`.
         * @returns {any}
         */
        summary() {
            const ret = wasm.freshset_summary(this.__wbg_ptr);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
    }
    if (Symbol.dispose) FreshSet.prototype[Symbol.dispose] = FreshSet.prototype.free;
    exports.FreshSet = FreshSet;

    /**
     * The keep step and recruiting over a snapshot (`EmployeePlanner.keepSession`,
     * keep.rs): employees by place in the snapshot, rosters as `{ company,
     * without }` (company by place, the employee left out by place or none).
     */
    class KeepSession {
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            KeepSessionFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_keepsession_free(ptr, 0);
        }
        /**
         * A typed candidate (`candidateValue`'s) who is `newcomer` joining
         * `roster`: `{ value, place }`; `options` is `{ alt }`.
         * @param {any} roster
         * @param {any} newcomer
         * @param {any} candidate
         * @param {any} options
         * @returns {any}
         */
        candidate(roster, newcomer, candidate, options) {
            const ret = wasm.keepsession_candidate(this.__wbg_ptr, roster, newcomer, candidate, options);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * A fresh set in `roster`: `options` is `{ alt, slots }`.
         * @param {any} roster
         * @param {any} options
         * @returns {FreshSet}
         */
        freshSet(roster, options) {
            const ret = wasm.keepsession_freshSet(this.__wbg_ptr, roster, options);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return FreshSet.__wrap(ret[0]);
        }
        /**
         * What `newcomer` (`{ nationality, gender, production, wage }`) does to
         * the traits of `roster`'s employees: `{ value, notes: [{ employee,
         * trait }] }`.
         * @param {any} roster
         * @param {any} newcomer
         * @returns {any}
         */
        impact(roster, newcomer) {
            const ret = wasm.keepsession_impact(this.__wbg_ptr, roster, newcomer);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * Employee `employee` in their company as the rules read them: `{
         * employee, context }`, the plain objects the rules decode. `options`
         * is `{ energyValue, coworkers }`: what 10 energy earns elsewhere (a
         * number or a list by day), and whether each coworker is a model in
         * their own context (the default).
         * @param {number} employee
         * @param {any} options
         * @returns {any}
         */
        model(employee, options) {
            const ret = wasm.keepsession_model(this.__wbg_ptr, employee, options);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * Over `snapshot` (with its exclusions, which retention reads); throws
         * without its PP value.
         * @param {Snapshot} snapshot
         */
        constructor(snapshot) {
            _assertClass(snapshot, Snapshot);
            const ret = wasm.keepsession_new(snapshot.__wbg_ptr);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            this.__wbg_ptr = ret[0];
            KeepSessionFinalization.register(this, this.__wbg_ptr, this);
            return this;
        }
        /**
         * One step of building what employee `employee`'s row reads (the
         * newcomer's tables and the coworker grid of the company without
         * them); true once it is ready.
         * @param {number} employee
         * @returns {boolean}
         */
        prepare(employee) {
            const ret = wasm.keepsession_prepare(this.__wbg_ptr, employee);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return ret[0] !== 0;
        }
        /**
         * Employee `employee`'s company with and without them (retention), as
         * `RetentionSession.price`; kept for their row.
         * @param {number} employee
         * @returns {any}
         */
        retention(employee) {
            const ret = wasm.keepsession_retention(this.__wbg_ptr, employee);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * Employee `employee`'s keep row: `feed` is `{ alt, trainingValue,
         * energyValue }`.
         * @param {number} employee
         * @param {any} feed
         * @returns {any}
         */
        row(employee, feed) {
            const ret = wasm.keepsession_row(this.__wbg_ptr, employee, feed);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
    }
    if (Symbol.dispose) KeepSession.prototype[Symbol.dispose] = KeepSession.prototype.free;
    exports.KeepSession = KeepSession;

    /**
     * `recommend`'s output-only comparison, searched alongside the main search
     * (in another worker) over the same snapshot and options: `step()` runs a
     * round and says whether to go on, with the most projections the main
     * search can leave; `settle(terms)` takes its `outputOnlyTerms()` once it
     * has finished, holding the search to that budget (starting again if it
     * has already projected past it); `result()` finishes the search and gives
     * what `Recommend.outputOnly()` would have.
     */
    class OutputOnlySearch {
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            OutputOnlySearchFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_outputonlysearch_free(ptr, 0);
        }
        /**
         * @param {Snapshot} snapshot
         * @param {any} options
         */
        constructor(snapshot, options) {
            _assertClass(snapshot, Snapshot);
            const ret = wasm.outputonlysearch_new(snapshot.__wbg_ptr, options);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            this.__wbg_ptr = ret[0];
            OutputOnlySearchFinalization.register(this, this.__wbg_ptr, this);
            return this;
        }
        /**
         * After `settle`: the comparison, or null when it isn't made.
         * @returns {any}
         */
        result() {
            const ret = wasm.outputonlysearch_result(this.__wbg_ptr);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * The main search's terms (`Recommend.outputOnlyTerms()`).
         * @param {any} terms
         */
        settle(terms) {
            const ret = wasm.outputonlysearch_settle(this.__wbg_ptr, terms);
            if (ret[1]) {
                throw takeFromExternrefTable0(ret[0]);
            }
        }
        /**
         * @returns {boolean}
         */
        step() {
            const ret = wasm.outputonlysearch_step(this.__wbg_ptr);
            return ret !== 0;
        }
    }
    if (Symbol.dispose) OutputOnlySearch.prototype[Symbol.dispose] = OutputOnlySearch.prototype.free;
    exports.OutputOnlySearch = OutputOnlySearch;

    /**
     * `recommend`'s search over a snapshot, a round at a time: `step()` runs
     * one and says whether to go on (the facade reports progress between
     * them), `result(partial)` gives the result so far, marked `partial` as the
     * facade says, and `outputOnly()` the output-only comparison after the
     * search (`planner::output_only`), or `outputOnlyTerms()` the terms for
     * one an `OutputOnlySearch` made alongside it.
     */
    class Recommend {
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            RecommendFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_recommend_free(ptr, 0);
        }
        /**
         * @returns {number}
         */
        floor() {
            const ret = wasm.recommend_floor(this.__wbg_ptr);
            return ret;
        }
        /**
         * @param {Snapshot} snapshot
         * @param {any} options
         */
        constructor(snapshot, options) {
            _assertClass(snapshot, Snapshot);
            const ret = wasm.recommend_new(snapshot.__wbg_ptr, options);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            this.__wbg_ptr = ret[0];
            RecommendFinalization.register(this, this.__wbg_ptr, this);
            return this;
        }
        /**
         * After `result(false)`: the output-only comparison's terms, `{ budget,
         * value }`, for an `OutputOnlySearch` to settle on, or null when the
         * comparison isn't made (also before any result).
         * @returns {any}
         */
        outputOnlyTerms() {
            const ret = wasm.recommend_outputOnlyTerms(this.__wbg_ptr);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * After `result(false)`: the comparison, or null when it isn't made
         * (also before any result, with no plan to compare).
         * @returns {any}
         */
        outputOnly() {
            const ret = wasm.recommend_outputOnly(this.__wbg_ptr);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * Projections run so far (`P.misses`).
         * @returns {number}
         */
        projections() {
            const ret = wasm.recommend_projections(this.__wbg_ptr);
            return ret;
        }
        /**
         * @param {boolean} partial
         * @returns {any}
         */
        result(partial) {
            const ret = wasm.recommend_result(this.__wbg_ptr, partial);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * @returns {boolean}
         */
        step() {
            const ret = wasm.recommend_step(this.__wbg_ptr);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return ret[0] !== 0;
        }
    }
    if (Symbol.dispose) Recommend.prototype[Symbol.dispose] = Recommend.prototype.free;
    exports.Recommend = Recommend;

    /**
     * `EmployeePlanner.retentionSession`'s projections over its snapshot.
     */
    class RetentionSession {
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            RetentionSessionFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_retentionsession_free(ptr, 0);
        }
        /**
         * Over `snapshot` (with its exclusions).
         * @param {Snapshot} snapshot
         */
        constructor(snapshot) {
            _assertClass(snapshot, Snapshot);
            const ret = wasm.retentionsession_new(snapshot.__wbg_ptr);
            this.__wbg_ptr = ret;
            RetentionSessionFinalization.register(this, this.__wbg_ptr, this);
            return this;
        }
        /**
         * Employee `employee`'s company with and without them; throws for one
         * who isn't in a planned company.
         * @param {number} employee
         * @returns {any}
         */
        price(employee) {
            const ret = wasm.retentionsession_price(this.__wbg_ptr, employee);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
    }
    if (Symbol.dispose) RetentionSession.prototype[Symbol.dispose] = RetentionSession.prototype.free;
    exports.RetentionSession = RetentionSession;

    /**
     * A decoded planner snapshot (snapshot.rs), held in the module: sessions
     * made from it share it. Free it with `free()` when done (the glue also
     * frees it on garbage collection); a session keeps what it needs.
     */
    class Snapshot {
        static __wrap(ptr) {
            const obj = Object.create(Snapshot.prototype);
            obj.__wbg_ptr = ptr;
            SnapshotFinalization.register(obj, obj.__wbg_ptr, obj);
            return obj;
        }
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            SnapshotFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_snapshot_free(ptr, 0);
        }
        /**
         * The index of an employee's company in `companies`, if it has one.
         * @param {number} employee
         * @returns {number | undefined}
         */
        companyIndex(employee) {
            const ret = wasm.snapshot_companyIndex(this.__wbg_ptr, employee);
            return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
        }
        /**
         * @returns {number}
         */
        get employeeCount() {
            const ret = wasm.snapshot_employeeCount(this.__wbg_ptr);
            return ret >>> 0;
        }
        /**
         * The snapshot with the companies at `places` not planned either
         * (`withExclusions`).
         * @param {Uint32Array | number[]} places
         * @returns {Snapshot}
         */
        exclude(places) {
            const ptr0 = passArray32ToWasm0(places, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.snapshot_exclude(this.__wbg_ptr, ptr0, len0);
            return Snapshot.__wrap(ret);
        }
        /**
         * Decodes `snapshotOf(...).snapshot`, or a hand-built one; throws on a
         * shape it can't read.
         * @param {any} value
         */
        constructor(value) {
            const ret = wasm.snapshot_new(value);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            this.__wbg_ptr = ret[0];
            SnapshotFinalization.register(this, this.__wbg_ptr, this);
            return this;
        }
        /**
         * An employee's known traits as ids (`traitRules` order).
         * @param {number} employee
         * @returns {Uint8Array}
         */
        traitIds(employee) {
            const ret = wasm.snapshot_traitIds(this.__wbg_ptr, employee);
            var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
            return v1;
        }
        /**
         * The snapshot planned over `days` days (card pricing's horizon).
         * @param {number} days
         * @returns {Snapshot}
         */
        withDays(days) {
            const ret = wasm.snapshot_withDays(this.__wbg_ptr, days);
            return Snapshot.__wrap(ret);
        }
    }
    if (Symbol.dispose) Snapshot.prototype[Symbol.dispose] = Snapshot.prototype.free;
    exports.Snapshot = Snapshot;

    /**
     * One employee in one context, decoded once (see model.rs) and priced by
     * handle. Work shared between calls (gained
     * trait values, Second Wind's outlook, the Luck forecast's pool) is kept
     * for the handle's life: every rule is pure.
     */
    class Subject {
        __destroy_into_raw() {
            const ptr = this.__wbg_ptr;
            this.__wbg_ptr = 0;
            SubjectFinalization.unregister(this);
            return ptr;
        }
        free() {
            const ptr = this.__destroy_into_raw();
            wasm.__wbg_subject_free(ptr, 0);
        }
        /**
         * @param {number} drop
         * @returns {boolean}
         */
        canNegotiate(drop) {
            const ret = wasm.subject_canNegotiate(this.__wbg_ptr, drop);
            return ret !== 0;
        }
        /**
         * @param {any} card
         * @returns {any}
         */
        cardOutcomes(card) {
            const ret = wasm.subject_cardOutcomes(this.__wbg_ptr, card);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * @param {any} price_fn
         * @param {number | null} [depth]
         * @returns {any}
         */
        cardPool(price_fn, depth) {
            const ret = wasm.subject_cardPool(this.__wbg_ptr, price_fn, !isLikeNone(depth), isLikeNone(depth) ? 0 : depth);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * @param {any} card
         * @param {number | null} [depth]
         * @returns {number | undefined}
         */
        cardValue(card, depth) {
            const ret = wasm.subject_cardValue(this.__wbg_ptr, card, !isLikeNone(depth), isLikeNone(depth) ? 0 : depth);
            if (ret[3]) {
                throw takeFromExternrefTable0(ret[2]);
            }
            return ret[0] === 0 ? undefined : ret[1];
        }
        /**
         * @param {number} rate
         * @returns {number}
         */
        careerBonus(rate) {
            const ret = wasm.subject_careerBonus(this.__wbg_ptr, rate);
            return ret;
        }
        /**
         * On the context's situation.
         * @param {number} day
         * @returns {number}
         */
        comparisonProduction(day) {
            const ret = wasm.subject_comparisonProduction(this.__wbg_ptr, day);
            return ret;
        }
        /**
         * @param {number | null | undefined} depth
         * @param {any} price_fn
         * @returns {number}
         */
        expectedTrainingValue(depth, price_fn) {
            const ret = wasm.subject_expectedTrainingValue(this.__wbg_ptr, !isLikeNone(depth), isLikeNone(depth) ? 0 : depth, price_fn);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return ret[0];
        }
        /**
         * @param {number} delta
         * @returns {number}
         */
        futureLuckValue(delta) {
            const ret = wasm.subject_futureLuckValue(this.__wbg_ptr, delta);
            return ret;
        }
        /**
         * @param {any} card
         * @param {number | null} [margin]
         * @param {number | null} [pp_value]
         * @returns {number | undefined}
         */
        gameDailyProfit(card, margin, pp_value) {
            const ret = wasm.subject_gameDailyProfit(this.__wbg_ptr, card, !isLikeNone(margin), isLikeNone(margin) ? 0 : margin, !isLikeNone(pp_value), isLikeNone(pp_value) ? 0 : pp_value);
            if (ret[3]) {
                throw takeFromExternrefTable0(ret[2]);
            }
            return ret[0] === 0 ? undefined : ret[1];
        }
        /**
         * @returns {number}
         */
        hourlyProfit() {
            const ret = wasm.subject_hourlyProfit(this.__wbg_ptr);
            return ret;
        }
        /**
         * @returns {number}
         */
        marginPerPoint() {
            const ret = wasm.subject_marginPerPoint(this.__wbg_ptr);
            return ret;
        }
        /**
         * `e` and `ctx` decoded with the defaults (model.rs); `ctx` undefined
         * or null is `DEFAULT_CONTEXT`.
         * @param {any} e
         * @param {any} ctx
         */
        constructor(e, ctx) {
            const ret = wasm.subject_new(e, ctx);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            this.__wbg_ptr = ret[0];
            SubjectFinalization.register(this, this.__wbg_ptr, this);
            return this;
        }
        /**
         * @param {number} potential
         * @param {number} alt
         * @param {number | null} [training_value]
         * @returns {number}
         */
        potentialValue(potential, alt, training_value) {
            const ret = wasm.subject_potentialValue(this.__wbg_ptr, potential, alt, !isLikeNone(training_value), isLikeNone(training_value) ? 0 : training_value);
            return ret;
        }
        /**
         * @param {string[]} genders
         * @returns {number}
         */
        rolledTraitValue(genders) {
            const ptr0 = passArrayJsValueToWasm0(genders, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.subject_rolledTraitValue(this.__wbg_ptr, ptr0, len0);
            return ret;
        }
        /**
         * @param {number} gain
         * @param {number | null | undefined} depth
         * @param {any} price_fn
         * @returns {number}
         */
        secondWindValue(gain, depth, price_fn) {
            const ret = wasm.subject_secondWindValue(this.__wbg_ptr, gain, !isLikeNone(depth), isLikeNone(depth) ? 0 : depth, price_fn);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return ret[0];
        }
        /**
         * @param {any} price_fn
         * @param {number | null} [depth]
         * @returns {any}
         */
        trainingOutlook(price_fn, depth) {
            const ret = wasm.subject_trainingOutlook(this.__wbg_ptr, price_fn, !isLikeNone(depth), isLikeNone(depth) ? 0 : depth);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * @param {string} code
         * @param {string | null | undefined} arg
         * @param {boolean} held
         * @returns {any}
         */
        traitValue(code, arg, held) {
            const val3 = +held;
            let ptr0, len0, ptr1, len1;
            try {
                ptr0 = passStringToWasm0(code, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
                len0 = WASM_VECTOR_LEN;
                ptr1 = isLikeNone(arg) ? 0 : passStringToWasm0(arg, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
                len1 = WASM_VECTOR_LEN;
            } catch (e) {
                if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
                if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
                throw e;
            }
            const ret = wasm.subject_traitValue(this.__wbg_ptr, ptr0, len0, ptr1, len1, val3);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
        /**
         * @returns {any}
         */
        wildCardOutcomes() {
            const ret = wasm.subject_wildCardOutcomes(this.__wbg_ptr);
            if (ret[2]) {
                throw takeFromExternrefTable0(ret[1]);
            }
            return takeFromExternrefTable0(ret[0]);
        }
    }
    if (Symbol.dispose) Subject.prototype[Symbol.dispose] = Subject.prototype.free;
    exports.Subject = Subject;

    /**
     * `candidateValue`: a typed-in candidate over their working life, in PP.
     * @param {any} candidate
     * @param {any} options
     * @returns {any}
     */
    function candidateValue(candidate, options) {
        const ret = wasm.candidateValue(candidate, options);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.candidateValue = candidateValue;

    /**
     * Card pricing's horizon: the longest working life among the planned
     * employees, in whole days from 1 to 47.
     * @param {Float64Array | number[]} working_days
     * @returns {number}
     */
    function cardHorizon(working_days) {
        const ptr0 = passArrayF64ToWasm0(working_days, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.cardHorizon(ptr0, len0);
        return ret;
    }
    exports.cardHorizon = cardHorizon;

    /**
     * `EmployeeCareer.compare`: arm i against arm j of a batch (null standard
     * error below two samples); an error when the batch has no such arm.
     * @param {any} stats
     * @param {number} i
     * @param {number} j
     * @returns {any}
     */
    function careerCompare(stats, i, j) {
        const ret = wasm.careerCompare(stats, i, j);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.careerCompare = careerCompare;

    /**
     * @returns {any}
     */
    function careerConstants() {
        const ret = wasm.careerConstants();
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.careerConstants = careerConstants;

    /**
     * `EmployeeCareer.merge`: two batches' stats as one; an empty one (no
     * `n`) gives the other back as it is.
     * @param {any} a
     * @param {any} b
     * @returns {any}
     */
    function careerMerge(a, b) {
        const ret = wasm.careerMerge(a, b);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.careerMerge = careerMerge;

    /**
     * `EmployeeCareer.random`: the arguments cross as int32s (the facade's
     * `x | 0`).
     * @param {number} seed
     * @param {number} pair
     * @param {number} step
     * @param {number} purpose
     * @returns {number}
     */
    function careerRandom(seed, pair, step, purpose) {
        const ret = wasm.careerRandom(seed, pair, step, purpose);
        return ret;
    }
    exports.careerRandom = careerRandom;

    /**
     * The game constants (`cfg::CFG`), with `traitProductionPaid` as it is now.
     * @returns {any}
     */
    function config() {
        const ret = wasm.config();
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.config = config;

    /**
     * `eligibleTraits`: trait ids, of the polarities listed (in the rules'
     * order, whatever the list's).
     * @param {string[]} held
     * @param {string | null | undefined} gender
     * @param {any} polarities
     * @returns {Uint8Array}
     */
    function eligibleTraits(held, gender, polarities) {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passArrayJsValueToWasm0(held, wasm.__wbindgen_malloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = isLikeNone(gender) ? 0 : passStringToWasm0(gender, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__externref_drop_slice(ptr0, len0); wasm.__wbindgen_free(ptr0, len0 * 4, 4); }
            throw e;
        }
        const ret = wasm.eligibleTraits(ptr0, len0, ptr1, len1, polarities);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v3;
    }
    exports.eligibleTraits = eligibleTraits;

    /**
     * `energyOn`: what 10 energy earns elsewhere `day` days from now, in the
     * context's `energyValue`.
     * @param {any} context
     * @param {number} day
     * @returns {number}
     */
    function energyOn(context, day) {
        const ret = wasm.energyOn(context, day);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    exports.energyOn = energyOn;

    /**
     * `evaluate`'s totals under `arrangement` (`[{ employee, company, tool }]`
     * by id).
     * @param {Snapshot} snapshot
     * @param {any} arrangement
     * @returns {any}
     */
    function evaluate(snapshot, arrangement) {
        _assertClass(snapshot, Snapshot);
        const ret = wasm.evaluate(snapshot.__wbg_ptr, arrangement);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.evaluate = evaluate;

    /**
     * `EmployeePlanner.evaluateRetooled`: one company re-tooled where it
     * stands, as Top Products tries it, and projected.
     * @param {Snapshot} snapshot
     * @param {any} input
     * @returns {any}
     */
    function evaluateRetooled(snapshot, input) {
        _assertClass(snapshot, Snapshot);
        const ret = wasm.evaluateRetooled(snapshot.__wbg_ptr, input);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.evaluateRetooled = evaluateRetooled;

    /**
     * The pairs no employee holds both of (`traits::EXCLUSIVE`):
     * `[[code, code]]`.
     * @returns {any}
     */
    function exclusivePairs() {
        const ret = wasm.exclusivePairs();
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.exclusivePairs = exclusivePairs;

    /**
     * `freshSetValue`: what a fresh set of candidates is worth when the pick
     * sees only what a card shows (see fresh.rs).
     * @param {any} groups
     * @param {any} options
     * @returns {FreshSet}
     */
    function freshSetValue(groups, options) {
        const ret = wasm.freshSetValue(groups, options);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return FreshSet.__wrap(ret[0]);
    }
    exports.freshSetValue = freshSetValue;

    /**
     * `gameMargins`: the game's own money per PP of each product, as its UI
     * prices profit, `{ code: margin }` in the items' order. `items`: `{ code:
     * item }`; `values`: `{ code: money per embodied PP }`. A unit is worth
     * value x (its PP plus its inputs' PP), less what its inputs are worth; an
     * item without a value takes `pp_value`; a product with an input that has
     * none counts no input cost.
     * @param {any} items
     * @param {any} values
     * @param {number} pp_value
     * @returns {any}
     */
    function gameMargins(items, values, pp_value) {
        const ret = wasm.gameMargins(items, values, pp_value);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.gameMargins = gameMargins;

    /**
     * The cards priced by number (`cards::numeric_cards`): `{ rarity: [card] }`.
     * @returns {any}
     */
    function numericCards() {
        const ret = wasm.numericCards();
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.numericCards = numericCards;

    /**
     * `withExclusions`' stat check, skipping the companies at the places in
     * `skip`.
     * @param {Snapshot} snapshot
     * @param {Uint32Array | number[]} skip
     * @returns {any}
     */
    function observedMismatches(snapshot, skip) {
        _assertClass(snapshot, Snapshot);
        const ptr0 = passArray32ToWasm0(skip, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.observedMismatches(snapshot.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.observedMismatches = observedMismatches;

    /**
     * `paidProduction`: the Production the wage is paid on, never below 1;
     * None when the employee's Production is unknown (see `OwnProduction`).
     * @param {any} employee
     * @returns {number | undefined}
     */
    function paidProduction(employee) {
        const ret = wasm.paidProduction(employee);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        return ret[0] === 0 ? undefined : ret[1];
    }
    exports.paidProduction = paidProduction;

    /**
     * `peerProduction`: each row's Production after peer effects.
     * @param {any} rows
     * @returns {Float64Array}
     */
    function peerProduction(rows) {
        const ret = wasm.peerProduction(rows);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    exports.peerProduction = peerProduction;

    /**
     * @returns {any}
     */
    function plannerConstants() {
        const ret = wasm.plannerConstants();
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.plannerConstants = plannerConstants;

    /**
     * `priceSets`: today's and the game's margins as tables (the facade
     * builds the objects and functions).
     * @param {any} input
     * @returns {any}
     */
    function priceSets(input) {
        const ret = wasm.priceSets(input);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.priceSets = priceSets;

    /**
     * `riskWarnings`' rule over rows `[{ id, minHappiness }]` (the last
     * employee with the id): the indices of the rows whose employee may quit.
     * @param {Snapshot} snapshot
     * @param {any} rows
     * @returns {Uint32Array}
     */
    function quitRisks(snapshot, rows) {
        _assertClass(snapshot, Snapshot);
        const ret = wasm.quitRisks(snapshot.__wbg_ptr, rows);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    exports.quitRisks = quitRisks;

    /**
     * `rarityOdds`: `{ rarity: p }`.
     * @param {number} luck
     * @param {number} management
     * @returns {any}
     */
    function rarityOdds(luck, management) {
        const ret = wasm.rarityOdds(luck, management);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.rarityOdds = rarityOdds;

    /**
     * `EmployeePlanner.retool`: a company re-tooled onto a good.
     * @param {any} input
     * @returns {any}
     */
    function retool(input) {
        const ret = wasm.retool(input);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.retool = retool;

    /**
     * @param {boolean} on
     */
    function setTraitProductionPaid(on) {
        wasm.setTraitProductionPaid(on);
    }
    exports.setTraitProductionPaid = setTraitProductionPaid;

    /**
     * `EmployeePlanner.singleSwitches` on a snapshot through `withExclusions`.
     * @param {Snapshot} snapshot
     * @param {any} switches
     * @returns {any}
     */
    function singleSwitches(snapshot, switches) {
        _assertClass(snapshot, Snapshot);
        const ret = wasm.singleSwitches(snapshot.__wbg_ptr, switches);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.singleSwitches = singleSwitches;

    /**
     * `switchContext`'s goods, best at the worse price first.
     * @param {any} switches
     * @returns {string[]}
     */
    function switchCodes(switches) {
        const ret = wasm.switchCodes(switches);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    exports.switchCodes = switchCodes;

    /**
     * The model's other tables: `DEFAULT_EMPLOYEE`, `DEFAULT_CONTEXT` and
     * `DEFAULT_SITUATION`.
     * @returns {any}
     */
    function tables() {
        const ret = wasm.tables();
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.tables = tables;

    /**
     * `TOOL_TYPES`.
     * @returns {any}
     */
    function toolTypes() {
        const ret = wasm.toolTypes();
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.toolTypes = toolTypes;

    /**
     * `toolboxRate`.
     * @param {number} luck
     * @returns {number}
     */
    function toolboxRate(luck) {
        const ret = wasm.toolboxRate(luck);
        return ret;
    }
    exports.toolboxRate = toolboxRate;

    /**
     * `CFG.traitProductionPaid`: whether the wage is paid on own-trait
     * Production too. Off, as the game has it; tests turn it on to model it.
     * @returns {boolean}
     */
    function traitProductionPaid() {
        const ret = wasm.traitProductionPaid();
        return ret !== 0;
    }
    exports.traitProductionPaid = traitProductionPaid;

    /**
     * `[{ code, polarity, weight, gender?, partner?, arg?, priced }]`, in trait id order.
     * @returns {any}
     */
    function traitRules() {
        const ret = wasm.traitRules();
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.traitRules = traitRules;

    /**
     * `uncertainty` of every employee: those the planner can't reproduce, in
     * snapshot order.
     * @param {Snapshot} snapshot
     * @returns {any}
     */
    function uncertainty(snapshot) {
        _assertClass(snapshot, Snapshot);
        const ret = wasm.uncertainty(snapshot.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.uncertainty = uncertainty;

    /**
     * `validate(s, arrangement)`: the problems, in check order (see
     * `check::validate`). `arrangement`: `[{ employee, company, tool }]` by id.
     * @param {Snapshot} snapshot
     * @param {any} arrangement
     * @returns {any}
     */
    function validate(snapshot, arrangement) {
        _assertClass(snapshot, Snapshot);
        const ret = wasm.validate(snapshot.__wbg_ptr, arrangement);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    exports.validate = validate;

    /**
     * The crate version, reported by the loader on the page and in workers.
     * @returns {string}
     */
    function version() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.version();
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    exports.version = version;

    /**
     * The wage expectation a reported wage shows: wage / (paid Production /
     * outputDivisor x the PP's money value).
     * @param {number} wage
     * @param {number} paid_production
     * @param {number} pp_value
     * @returns {number}
     */
    function wageExpectation(wage, paid_production, pp_value) {
        const ret = wasm.wageExpectation(wage, paid_production, pp_value);
        return ret;
    }
    exports.wageExpectation = wageExpectation;

    /**
     * `wildCardRisk`; undefined for null.
     * @param {string[]} held
     * @param {string | null} [gender]
     * @returns {number | undefined}
     */
    function wildCardRisk(held, gender) {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passArrayJsValueToWasm0(held, wasm.__wbindgen_malloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = isLikeNone(gender) ? 0 : passStringToWasm0(gender, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__externref_drop_slice(ptr0, len0); wasm.__wbindgen_free(ptr0, len0 * 4, 4); }
            throw e;
        }
        const ret = wasm.wildCardRisk(ptr0, len0, ptr1, len1);
        return ret[0] === 0 ? undefined : ret[1];
    }
    exports.wildCardRisk = wildCardRisk;

    /**
     * `workingDays`: days left to retirement, if known (see `WorkingLife`).
     * @param {any} employee
     * @returns {number | undefined}
     */
    function workingDays(employee) {
        const ret = wasm.workingDays(employee);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        return ret[0] === 0 ? undefined : ret[1];
    }
    exports.workingDays = workingDays;
    function __wbg_get_imports() {
        const import0 = {
            __proto__: null,
            __wbg_Error_208446807d0d1e30: function(arg0, arg1) {
                const ret = Error(getStringFromWasm0(arg0, arg1));
                return ret;
            },
            __wbg_Number_ff192a72a0dcdf6d: function(arg0) {
                const ret = Number(arg0);
                return ret;
            },
            __wbg___wbindgen_bigint_get_as_i64_11da4b52cd0aedef: function(arg0, arg1) {
                const v = arg1;
                const ret = typeof(v) === 'bigint' ? v : undefined;
                getDataViewMemory0().setBigInt64((arg0 >>> 0) + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
                getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, !isLikeNone(ret), true);
            },
            __wbg___wbindgen_boolean_get_4f1baf9a00be3c74: function(arg0) {
                const v = arg0;
                const ret = typeof(v) === 'boolean' ? v : undefined;
                return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
            },
            __wbg___wbindgen_debug_string_f249a2a76caa9a55: function(arg0, arg1) {
                const ret = debugString(arg1);
                const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
                const len1 = WASM_VECTOR_LEN;
                getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
                getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
            },
            __wbg___wbindgen_in_3f58a9d3b3a7eed2: function(arg0, arg1) {
                const ret = arg0 in arg1;
                return ret;
            },
            __wbg___wbindgen_is_bigint_5fa10641e039d3ef: function(arg0) {
                const ret = typeof(arg0) === 'bigint';
                return ret;
            },
            __wbg___wbindgen_is_function_741ff2bb612836f5: function(arg0) {
                const ret = typeof(arg0) === 'function';
                return ret;
            },
            __wbg___wbindgen_is_null_c22311b1cc228e3a: function(arg0) {
                const ret = arg0 === null;
                return ret;
            },
            __wbg___wbindgen_is_object_8b968c3ab8e96595: function(arg0) {
                const val = arg0;
                const ret = typeof(val) === 'object' && val !== null;
                return ret;
            },
            __wbg___wbindgen_is_string_fc456fee5d3317de: function(arg0) {
                const ret = typeof(arg0) === 'string';
                return ret;
            },
            __wbg___wbindgen_is_undefined_be5b34249ff1fc15: function(arg0) {
                const ret = arg0 === undefined;
                return ret;
            },
            __wbg___wbindgen_jsval_eq_38d7bfbe4cc84039: function(arg0, arg1) {
                const ret = arg0 === arg1;
                return ret;
            },
            __wbg___wbindgen_jsval_loose_eq_b2f214e2e4b30e36: function(arg0, arg1) {
                const ret = arg0 == arg1;
                return ret;
            },
            __wbg___wbindgen_number_get_934b640d0889af78: function(arg0, arg1) {
                const obj = arg1;
                const ret = typeof(obj) === 'number' ? obj : undefined;
                getDataViewMemory0().setFloat64((arg0 >>> 0) + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
                getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, !isLikeNone(ret), true);
            },
            __wbg___wbindgen_string_get_7ce8eee7fd327545: function(arg0, arg1) {
                const obj = arg1;
                const ret = typeof(obj) === 'string' ? obj : undefined;
                var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
                var len1 = WASM_VECTOR_LEN;
                getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
                getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
            },
            __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
                throw new Error(getStringFromWasm0(arg0, arg1));
            },
            __wbg_call_40b008ba32f73991: function() { return handleError(function (arg0, arg1) {
                const ret = arg0.call(arg1);
                return ret;
            }, arguments); },
            __wbg_call_4a4239669a589179: function() { return handleError(function (arg0, arg1, arg2) {
                const ret = arg0.call(arg1, arg2);
                return ret;
            }, arguments); },
            __wbg_call_a326129292d9c079: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
                const ret = arg0.call(arg1, arg2, arg3, arg4);
                return ret;
            }, arguments); },
            __wbg_done_57e08d0be6e30c02: function(arg0) {
                const ret = arg0.done;
                return ret;
            },
            __wbg_entries_7bb1459bd9b5c2b9: function(arg0) {
                const ret = Object.entries(arg0);
                return ret;
            },
            __wbg_get_635eea311fa1a291: function() { return handleError(function (arg0, arg1) {
                const ret = Reflect.get(arg0, arg1);
                return ret;
            }, arguments); },
            __wbg_get_d7176cfb76d71114: function(arg0, arg1) {
                const ret = arg0[arg1 >>> 0];
                return ret;
            },
            __wbg_get_unchecked_e6325ad374eff861: function(arg0, arg1) {
                const ret = arg0[arg1 >>> 0];
                return ret;
            },
            __wbg_get_with_ref_key_fc601247060b7204: function(arg0, arg1) {
                const ret = arg0[arg1];
                return ret;
            },
            __wbg_instanceof_ArrayBuffer_12cdaa4161423e6b: function(arg0) {
                let result;
                try {
                    result = arg0 instanceof ArrayBuffer;
                } catch (_) {
                    result = false;
                }
                const ret = result;
                return ret;
            },
            __wbg_instanceof_Map_0b4fc8b62e73f163: function(arg0) {
                let result;
                try {
                    result = arg0 instanceof Map;
                } catch (_) {
                    result = false;
                }
                const ret = result;
                return ret;
            },
            __wbg_instanceof_Uint8Array_d7aeb0dcb3108fea: function(arg0) {
                let result;
                try {
                    result = arg0 instanceof Uint8Array;
                } catch (_) {
                    result = false;
                }
                const ret = result;
                return ret;
            },
            __wbg_isArray_bcf1376d0d732d08: function(arg0) {
                const ret = Array.isArray(arg0);
                return ret;
            },
            __wbg_isSafeInteger_1a35ba4d31e71d38: function(arg0) {
                const ret = Number.isSafeInteger(arg0);
                return ret;
            },
            __wbg_iterator_e4c5e8f68ada7b58: function() {
                const ret = Symbol.iterator;
                return ret;
            },
            __wbg_length_186163212ffe79c3: function(arg0) {
                const ret = arg0.length;
                return ret;
            },
            __wbg_length_b03a0fabb109b1e9: function(arg0) {
                const ret = arg0.length;
                return ret;
            },
            __wbg_new_13de428334042d26: function(arg0) {
                const ret = new Uint8Array(arg0);
                return ret;
            },
            __wbg_new_37eb45aaf5eeb820: function() {
                const ret = new Array();
                return ret;
            },
            __wbg_new_7075786089b89c5e: function() {
                const ret = new Map();
                return ret;
            },
            __wbg_new_cd4348290afae586: function() {
                const ret = new Object();
                return ret;
            },
            __wbg_next_178c1651c11432b3: function(arg0) {
                const ret = arg0.next;
                return ret;
            },
            __wbg_next_af5ac6a08bb0a717: function() { return handleError(function (arg0) {
                const ret = arg0.next();
                return ret;
            }, arguments); },
            __wbg_prototypesetcall_13162965d1fe7aa3: function(arg0, arg1, arg2) {
                Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
            },
            __wbg_set_8282f7e0d2d01336: function(arg0, arg1, arg2) {
                const ret = arg0.set(arg1, arg2);
                return ret;
            },
            __wbg_set_d2d33b52458e984a: function(arg0, arg1, arg2) {
                arg0[arg1 >>> 0] = arg2;
            },
            __wbg_set_e4b9a833d288759a: function(arg0, arg1, arg2) {
                arg0[arg1] = arg2;
            },
            __wbg_value_e0f328965e184931: function(arg0) {
                const ret = arg0.value;
                return ret;
            },
            __wbindgen_generic_0000000000000001: function(arg0) {
                // Cast intrinsic for `F64 -> Externref`.
                const ret = arg0;
                return ret;
            },
            __wbindgen_generic_0000000000000002: function(arg0) {
                // Cast intrinsic for `I64 -> Externref`.
                const ret = arg0;
                return ret;
            },
            __wbindgen_generic_0000000000000003: function(arg0, arg1) {
                // Cast intrinsic for `Ref(String) -> Externref`.
                const ret = getStringFromWasm0(arg0, arg1);
                return ret;
            },
            __wbindgen_generic_0000000000000004: function(arg0) {
                // Cast intrinsic for `U64 -> Externref`.
                const ret = BigInt.asUintN(64, arg0);
                return ret;
            },
            __wbindgen_init_externref_table: function() {
                const table = wasm.__wbindgen_externrefs;
                table.set(0, undefined);
                table.set(1024, undefined);
                table.set(1025, null);
                table.set(1026, true);
                table.set(1027, false);
            },
        };
        return {
            __proto__: null,
            "./employee_model_bg.js": import0,
        };
    }

    const CardSessionFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_cardsession_free(ptr, 1));
    const CareerFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_career_free(ptr, 1));
    const CareerRunFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_careerrun_free(ptr, 1));
    const FreshSetFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_freshset_free(ptr, 1));
    const KeepSessionFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_keepsession_free(ptr, 1));
    const OutputOnlySearchFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_outputonlysearch_free(ptr, 1));
    const RecommendFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_recommend_free(ptr, 1));
    const RetentionSessionFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_retentionsession_free(ptr, 1));
    const SnapshotFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_snapshot_free(ptr, 1));
    const SubjectFinalization = (typeof FinalizationRegistry === 'undefined')
        ? { register: () => {}, unregister: () => {} }
        : new FinalizationRegistry(ptr => wasm.__wbg_subject_free(ptr, 1));

    function addToExternrefTable0(obj) {
        const idx = wasm.__externref_table_alloc();
        wasm.__wbindgen_externrefs.set(idx, obj);
        return idx;
    }

    function _assertClass(instance, klass) {
        if (!(instance instanceof klass)) {
            throw new Error(`expected instance of ${klass.name}`);
        }
    }

    function debugString(val) {
        switch (typeof val) {
            // primitive types
            case 'number':
            case 'boolean':
            case 'undefined':
            return `${val}`;
            case 'string':
            return JSON.stringify(val);
            case 'bigint':
            return `${val}n`;
            case 'symbol':
            return val.description !== undefined
                ? `Symbol(${val.description})`
                : 'Symbol';
            case 'function':
            return typeof val.name === 'string' && val.name !== ''
                ? `Function(${val.name})`
                : 'Function';
            case 'object': {
                if (val === null) {
                    return 'null';
                }
                // objects
                if (Array.isArray(val)) {
                    return '[' + Array.from(val, debugString).join(', ') + ']';
                }
                // errors
                if (val instanceof Error) {
                    return `${val.name}: ${val.message}\n${val.stack}`;
                }

                const toStringOutput = toString.call(val);
                // Test for built-in
                const className = /\[object ([^\]]+)\]/.exec(toStringOutput)?.[1];

                // Failed to match the standard '[object ClassName]'
                if (className === undefined) {
                    return toStringOutput;
                }
                if (className === 'Object') {
                    // we're a user defined class or Object
                    // JSON.stringify avoids problems with cycles, and is generally much
                    // easier than looping through ownProperties of `val`.
                    try {
                        return 'Object(' + JSON.stringify(val) + ')';
                    } catch (_) {
                        return 'Object';
                    }
                }
                // TODO we could test for more things here, like `Set`s and `Map`s.
                return className;
            }
            // Per MDN: 'This list of values is exhaustive.'
            // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/typeof#description
        }
    }

    function getArrayF64FromWasm0(ptr, len) {
        ptr = ptr >>> 0;
        return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
    }

    function getArrayJsValueFromWasm0(ptr, len) {
        ptr = ptr >>> 0;
        const mem = getDataViewMemory0();
        const result = [];
        for (let i = ptr; i < ptr + 4 * len; i += 4) {
            result.push(wasm.__wbindgen_externrefs.get(mem.getUint32(i, true)));
        }
        wasm.__externref_drop_slice(ptr, len);
        return result;
    }

    function getArrayU32FromWasm0(ptr, len) {
        ptr = ptr >>> 0;
        return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
    }

    function getArrayU8FromWasm0(ptr, len) {
        ptr = ptr >>> 0;
        return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
    }

    let cachedDataViewMemory0 = null;
    function getDataViewMemory0() {
        if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
            cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
        }
        return cachedDataViewMemory0;
    }

    let cachedFloat64ArrayMemory0 = null;
    function getFloat64ArrayMemory0() {
        if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
            cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
        }
        return cachedFloat64ArrayMemory0;
    }

    function getStringFromWasm0(ptr, len) {
        ptr = ptr >>> 0;
        return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
    }

    let cachedUint32ArrayMemory0 = null;
    function getUint32ArrayMemory0() {
        if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
            cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
        }
        return cachedUint32ArrayMemory0;
    }

    let cachedUint8ArrayMemory0 = null;
    function getUint8ArrayMemory0() {
        if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
            cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
        }
        return cachedUint8ArrayMemory0;
    }

    function handleError(f, args) {
        try {
            return f.apply(this, args);
        } catch (e) {
            const idx = addToExternrefTable0(e);
            wasm.__wbindgen_exn_store(idx);
        }
    }

    function isLikeNone(x) {
        return x === undefined || x === null;
    }

    function passArray32ToWasm0(arg, malloc) {
        const ptr = malloc(arg.length * 4, 4) >>> 0;
        getUint32ArrayMemory0().set(arg, ptr / 4);
        WASM_VECTOR_LEN = arg.length;
        return ptr;
    }

    function passArray8ToWasm0(arg, malloc) {
        const ptr = malloc(arg.length * 1, 1) >>> 0;
        getUint8ArrayMemory0().set(arg, ptr / 1);
        WASM_VECTOR_LEN = arg.length;
        return ptr;
    }

    function passArrayF64ToWasm0(arg, malloc) {
        const ptr = malloc(arg.length * 8, 8) >>> 0;
        getFloat64ArrayMemory0().set(arg, ptr / 8);
        WASM_VECTOR_LEN = arg.length;
        return ptr;
    }

    function passArrayJsValueToWasm0(array, malloc) {
        const ptr = malloc(array.length * 4, 4) >>> 0;
        for (let i = 0; i < array.length; i++) {
            const add = addToExternrefTable0(array[i]);
            getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
        }
        WASM_VECTOR_LEN = array.length;
        return ptr;
    }

    function passStringToWasm0(arg, malloc, realloc) {
        if (realloc === undefined) {
            const buf = cachedTextEncoder.encode(arg);
            const ptr = malloc(buf.length, 1) >>> 0;
            getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
            WASM_VECTOR_LEN = buf.length;
            return ptr;
        }

        let len = arg.length;
        let ptr = malloc(len, 1) >>> 0;

        const mem = getUint8ArrayMemory0();

        let offset = 0;

        for (; offset < len; offset++) {
            const code = arg.charCodeAt(offset);
            if (code > 0x7F) break;
            mem[ptr + offset] = code;
        }
        if (offset !== len) {
            if (offset !== 0) {
                arg = arg.slice(offset);
            }
            ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
            const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
            const ret = cachedTextEncoder.encodeInto(arg, view);

            offset += ret.written;
            ptr = realloc(ptr, len, offset, 1) >>> 0;
        }

        WASM_VECTOR_LEN = offset;
        return ptr;
    }

    function takeFromExternrefTable0(idx) {
        const value = wasm.__wbindgen_externrefs.get(idx);
        wasm.__externref_table_dealloc(idx);
        return value;
    }

    let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
    cachedTextDecoder.decode();
    function decodeText(bytes) {
        return cachedTextDecoder.decode(bytes);
    }

    const cachedTextEncoder = new TextEncoder();

    if (!('encodeInto' in cachedTextEncoder)) {
        cachedTextEncoder.encodeInto = function (arg, view) {
            const buf = cachedTextEncoder.encode(arg);
            view.set(buf);
            return {
                read: arg.length,
                written: buf.length
            };
        };
    }

    let WASM_VECTOR_LEN = 0;

    let wasmModule, wasmInstance, wasm;
    function __wbg_finalize_init(instance, module) {
        wasmInstance = instance;
        wasm = instance.exports;
        wasmModule = module;
        cachedDataViewMemory0 = null;
        cachedFloat64ArrayMemory0 = null;
        cachedUint32ArrayMemory0 = null;
        cachedUint8ArrayMemory0 = null;
        wasm.__wbindgen_start();
        return wasm;
    }

    async function __wbg_load(module, imports) {
        if (typeof Response === 'function' && module instanceof Response) {
            if (!module.ok) {
                throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
            }

            if (typeof WebAssembly.instantiateStreaming === 'function') {
                try {
                    return await WebAssembly.instantiateStreaming(module, imports);
                } catch (e) {
                    const validResponse = expectedResponseType(module.type);

                    if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                        console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                    } else { throw e; }
                }
            }

            const bytes = await module.arrayBuffer();
            return await WebAssembly.instantiate(bytes, imports);
        } else {
            const instance = await WebAssembly.instantiate(module, imports);

            if (instance instanceof WebAssembly.Instance) {
                return { instance, module };
            } else {
                return instance;
            }
        }

        function expectedResponseType(type) {
            switch (type) {
                case 'basic': case 'cors': case 'default': return true;
            }
            return false;
        }
    }

    function initSync(module) {
        if (wasm !== undefined) return wasm;


        if (module !== undefined) {
            if (Object.getPrototypeOf(module) === Object.prototype) {
                ({module} = module)
            } else {
                console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
            }
        }

        const imports = __wbg_get_imports();
        if (!(module instanceof WebAssembly.Module)) {
            module = new WebAssembly.Module(module);
        }
        const instance = new WebAssembly.Instance(module, imports);
        return __wbg_finalize_init(instance, module);
    }

    let __wbg_init_promise;
    async function __wbg_init(module_or_path) {
        if (wasm !== undefined) return wasm;
        if (__wbg_init_promise === undefined) {
            __wbg_init_promise = __wbg_init_once(module_or_path);
            __wbg_init_promise.catch(() => { __wbg_init_promise = undefined; });
        }
        return __wbg_init_promise;
    }

    async function __wbg_init_once(module_or_path) {

        if (module_or_path !== undefined) {
            if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
                ({module_or_path} = module_or_path)
            } else {
                console.warn('using deprecated parameters for the initialization function; pass a single object instead')
            }
        }

        if (module_or_path === undefined && script_src !== undefined) {
            module_or_path = script_src.replace(/\.js$/, "_bg.wasm");
        }
        const imports = __wbg_get_imports();

        if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
            module_or_path = fetch(module_or_path);
        }

        const { instance, module } = await __wbg_load(await module_or_path, imports);

        return __wbg_finalize_init(instance, module);
    }

    return Object.assign(__wbg_init, { initSync }, exports);
})({ __proto__: null });
