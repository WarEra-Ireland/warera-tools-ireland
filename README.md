# War Era tools

An Irish player's toolkit for [War Era](https://app.warera.io/). Live at [we.hawtre.net](https://we.hawtre.net).

This is a static site: plain HTML, CSS, and vanilla JavaScript with no build step, no framework, and no bundler. You edit files, refresh the page, done. Everything runs in the browser. The only backend is a thin Cloudflare Worker that proxies the game's API and holds a couple of secrets.

> **Game version note.** War Era v0.27 (2026-10-25) replaced the player job market with NPC employees and removed Entrepreneurship, specialisation, deposits and party ethics. Several tools below were built on the old mechanics and are now broken or obsolete.

## Quick start

Clone the repo and serve the folder over HTTP. You can't open `index.html` with `file://` because the tools use `fetch` and the Web Crypto API, both of which need a real origin.

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static server works (`npx serve`, VS Code Live Server, etc.). There is nothing to install and nothing to compile.

On `localhost` the site calls a local Worker at `http://localhost:8787` (see [`worker/README.md`](worker/README.md)):

```bash
cd worker && npx wrangler dev --port 8787 --ip 127.0.0.1   # needs worker/.dev.vars with a game API key
```

The production Worker only accepts the live site's origin, so previews on another host (e.g. Tailscale) pass `?proxy=<worker origin>`, which sticks for the tab: `https://<host>:8000/?proxy=https://<host>:8787#training`. That origin must also be in `.dev.vars` `ALLOWED_ORIGINS`.

## How a contributor should think about this

The site is one HTML page with several hidden "views". A hash router shows one view at a time. Each tool is a self-contained script that the router switches on when its view becomes visible. Shared plumbing (the API client, formatting helpers, the loading-step UI) lives in one file that every tool depends on.

If you understand `shared.js` and the tool pattern below, you understand the whole codebase.

## Section explanations

Put explanations in an ⓘ tooltip at the top right of the section they explain. Use `sectionHelp(label, content)` from `js/section-help.js` inside a `.section-help-card`. The shared helper supports hover, keyboard focus, click or tap, Escape, and outside-click dismissal. Keep it available in desktop and phone layouts.

Use short paragraphs about the current calculation, assumptions, and limits. Keep essential warnings visible. Avoid separate “How this works” panels, repeated explanatory subtitles, API endpoint names, and game-update announcements in user-facing help.

## File structure

```
index.html        All views live here as <section class="view"> blocks
styles.css        Main stylesheet (theme variables + every tool's styles)
community.css     Styles specific to the Community tools directory
js/
  shared.js       Loaded first. Data layer + helpers. Tools depend on this.
  toolkit.js      Home/landing shell + tab navigation
  advisor.js      Company Migration Advisor
  clockin.js      Manager Check-In Monitor
  softcap.js      Gear Softcap Advisor
  buddy-finder.js Buddy Finder (public)
  daily-profit.js Daily Profit calculator
  product-picker.js Top products (best product per company, v0.27)
  employee-core.js  Training card value model, no DOM (also runs in Node)
  employee-training.js Employee Training (#training)
  wealth.js       Wealth tracker
  donation-draw.js Ireland Donation Draw
  mu.js           Irish Military Units
  buddy.js        Buddy System Monitor (encrypted, MoE password)
  battle-orders.js Battle Orders (encrypted, MoD password)
  beer.js         Bunker monitor (encrypted, BEER password)
  router.js       Loaded last. Hash routing + view switching.
images/           Item icons used by the advisor and clock-in tools
worker/           Cloudflare Worker: the API proxy with the key pool
```

Script load order in `index.html` matters and is fixed: `shared.js` first, then the tools, then `router.js` last. Shared helpers must exist before any tool runs, and the router must run after every tool global is defined.

## Architecture

### Views and routing

Every view is a `<section class="view" data-view="NAME">` inside `index.html`. Only one carries the `active` class at a time; the rest are hidden by CSS.

Routing is hash-based and deep-linkable. Parameters sit inside the hash after a literal `?`, so the whole route travels as one fragment and survives static hosting that doesn't rewrite query strings.

```
#home                 Irish tools landing (default)
#community            External community tools directory
#mu                   Irish Military Units
#mu?filter=open       MU tool with the "Has slots" filter applied
#advisor              Migration Advisor, empty
#advisor?u=toie       Migration Advisor pre-loaded for a user
#clockin?u=toie       Clock-In Monitor pre-loaded for a user
#buddy-finder?u=toie  Buddy Finder pre-loaded for a user
```

`router.js` parses the hash into `{ view, params }`, toggles the right section active, shows or hides the tab bar and back link, and calls the tool's `activate(params)`.

Two things to know about the router:

1. `activate(params)` runs **every time** a view becomes active, not just the first time. Tools must be idempotent. For example, MU kicks off its data load exactly once, and the advisor only re-runs if the `?u=` value changed. This is what lets a hash edit from `#advisor` to `#advisor?u=toie` pick up the new parameter without a full reload.
2. To register a new view you add it to the `VALID` set and the `tools` map in `router.js`. Landing pages (`home`, `community`) go in the `LANDING` set so they show the tab bar instead of the back link.

### The tool pattern

Every tool is an IIFE assigned to a global, returning an object with an `activate` method. That global is what `router.js` references.

```js
const MyTool = (() => {
  // grab DOM nodes, wire up event listeners, define the pipeline
  return {
    activate(params) {
      // called whenever this view opens; must be idempotent
    }
  };
})();
```

Tools never touch each other. They share state only through the URL and through helpers in `shared.js`.

### shared.js (read this first)

`shared.js` is the contract every tool relies on. The important pieces:

**Constants**

```js
API_BASE         = 'https://warera-proxy.0x5ca1ab1e.workers.dev/trpc'
GAME_BASE        = 'https://app.warera.io'
IRELAND_COUNTRY_ID = '6813b6d446e731854c7ac7fe'
```

**`trpc(endpoint, inputOrInputs, { batch, retry, timeoutMs, fresh })`** is the only way to call the game API. It builds the proxied URL, unwraps the tRPC response shape, and optionally retries transient errors. With `batch: true`, pass an array of inputs for the same endpoint; the result uses `Promise.allSettled`'s shape. `fresh: true` bypasses the resolved-value cache. Always use `trpc` rather than calling `fetch` against the live API directly.

**`trpcMany(endpoint, inputs, { urlBudget, maxChunk, concurrency, retry, timeoutMs, fresh, onProgress })`** is the bulk form, and the one to reach for whenever a tool needs the same procedure for a list of IDs. It packs `inputs` into batches by URL size, sends four batches at a time, and resolves to one flat `Promise.allSettled`-shaped array in input order. Failure is per item, so a bad chunk can't sink the sweep, and `onProgress(done, total)` drives the step counters. Retryable failures are re-sent as a batch of *just the failures*, so one bad item in a chunk of 100 costs one small repair request rather than re-pulling all 100. **`trpcManyValues(endpoint, inputs, { fallback, ... })`** is the same thing unwrapped to plain values, with `fallback` (default `null`) in place of anything that failed — that's the one most call sites want.

Reach for these instead of hand-rolling a concurrency pool over scalar `trpc` calls: a 600-citizen roster sweep is 6 requests instead of 600, which is the difference between finishing and tripping the rate limit. Batches are sized **by URL length**, not by a fixed count, because everything rides in the URL and the Worker runtime rejects a URL over 16 KB with a bare `500` (measured against the live proxy: 15,726 chars → `200`, 16,058 → `500`). `urlBudget` defaults to 12,000, keeping ~25% clear of that cliff. Packing by bytes is what lets cheap calls ride in big batches — the budget buys ~290 `user.getUserLite` inputs but only ~75 `transaction.getPaginatedTransactions` inputs, and a fixed count would have to be sized for the worst shape.

`maxChunk` (100) is a backstop, not the sizing rule: response size and blast radius also scale with batch size — 75 batched transaction inputs return ~1.7 MB, and a batch that fails outright takes every input in it down. Both defaults are verified live at the sizes the packer actually emits (100 × `getUserLite` = 8,256 chars, 457 KB, `200`; 75 × `getPaginatedTransactions` = 11,981 chars, 1.7 MB, `200`).

Mixed-endpoint batching isn't supported; a `Promise.all` over several different procedures stays as it is.

**Rate limits and retries.** The game API allows **500 requests per minute per API token**, and the Worker uses one token for every visitor — so the budget is shared, not per user. It advertises this on every response (`ratelimit-policy: 500;w=60`, `ratelimit-remaining`, `ratelimit-reset`) and answers `429` with `Retry-After` once exhausted. Batching is what keeps tools inside it: **a batch counts as one request no matter how many inputs it carries** (measured — a 100-input batch decrements `ratelimit-remaining` by exactly 1), so a roster sweep costs 6 requests instead of 600.

`isTransientError` treats `429` and `5xx`/timeouts as retryable and `404`/`400` as permanent, so a missing user never costs a wasted retry. A retry waits as long as `Retry-After` asks rather than a fixed backoff, which matters because the wait can be nearly a full window: burn the quota at the *start* of one and the API asks for 59s. `TRPC_RETRY_MAX_WAIT_MS` is therefore 65s — deliberately larger than feels comfortable, because a tighter cap silently defeats the retry (at 30s, a rate-limited 100-user fetch returned 100 nulls without retrying once). Waits are announced through `onRateLimit`, or `setRateLimitHandler` globally, so a tool can say "waiting 38s" instead of looking hung.

This depends on the Worker's `Access-Control-Expose-Headers` — the rate-limit headers reach the browser but stay invisible to `fetch()` unless they're listed there. Drop that and the tools still retry, just blind, on a fixed fallback wait.

**Caching.** Two independent mechanisms sit behind `trpc`. *In-flight dedupe* is always on and shares one promise between identical concurrent calls. The *resolved cache* is opt-in via `setTrpcCache(true)`, holds values for 90s, and skips endpoints in `TRPC_VOLATILE` (`transaction.getPaginatedTransactions`, `worker.getWorkers`, `manager.getByCompanyId`).

The resolved cache is **per item, not per request**. A batched result is stored under the key each input would have had as a scalar call, so the two share freely in both directions: a 100-user batch fills the cache for a later single lookup, and an overlapping list only fetches the difference. Order and chunk boundaries don't matter, and a failed item no longer stops its neighbours being cached — only fulfilled items are stored, so a 404 is never cached and stuck for 90s. Entries are evicted on read when stale and capped at `TRPC_CACHE_MAX_ENTRIES`, since nothing else sweeps them.

Note the cache is off by default and only two places switch it on: dashboard during a run, and the toolkit shell while you're on `#home` (which covers tools hosted inside it). Each passes an owner token — `setTrpcCache(true, 'toolkit')` — and a release only lands if that view still holds the cache. Several views tear down on the same `hashchange` that mounts the next one, so without this the scheme's correctness rests on the order the listeners were registered, i.e. on `<script>` order in `index.html`; reorder two tags and the incoming view's freshly warmed cache is wiped by the outgoing view's teardown, silently. A tool opened standalone runs with in-flight dedupe only. That makes `fresh: true` a no-op wherever the cache is off — it's a correctness marker for calls that must never serve a warmed value (donation-draw resolves money), not something that changes behaviour today.

**`enforceIrishOnly(country, username)`** throws unless the user is an Irish citizen or the `bypass=1` URL flag is set. Personal tools call this right after resolving a username, before any expensive loading. A `null` country passes through (the resolution path reports its own error).

**`makeSteps(rootEl)`** returns `{ setStep, reset, markActiveAsError, fadeOut, hide }` for driving the multi-step loading panel (the spinner-and-checkmark list you see while a tool works). The matching markup is the `.steps` block inside each view.

The panel also reports rate-limit waits on its own. `reset()` claims the global rate-limit handler and `fadeOut()`/`hide()` release it, so when the API rate-limits a request the panel grows a transient amber step — "Rate limited by the game API", counting down — and removes it when the wait ends. No tool passes a callback for this and no tool's markup contains that step. Its state is `waiting`, deliberately not `active`, so `markActiveAsError` still targets the real step underneath. Tools without a step panel (dashboard, roster) wire `setRateLimitHandler` to their status line instead; anything that does neither falls back to a `console.warn`.

**`makeStatus(el)`** returns a `setStatus(text, isError)` function for the single-line status message under a tool header.

**Formatting helpers:** `escapeHtml`, `fmtNum`, `fmt`, `flag`, `formatDuration`, `formatDate`. Always run any user-supplied or API string through `escapeHtml` before putting it in `innerHTML`.

**`isTransientError(err)`** classifies retryable failures (HTTP 502/503/504, timeouts, network errors). Use it to decide between a friendly "try again in a moment" message and a hard error.

### Username resolution

Several tools need to turn a typed username into a user ID. The game's `search.searchAnything` is fuzzy and relevance-ranked, so the first result is not guaranteed to be an exact match. The shared pattern, used in advisor, clock-in, and buddy-finder, is:

1. Search for the text.
2. Fetch lite profiles for the top results.
3. Keep the one whose username matches exactly, case-insensitive.
4. Never silently fall back to the top hit. If nothing matches, tell the user what came back.

If you write a tool that resolves usernames, copy this behaviour. Falling back to an unverified result causes "wrong user" bugs during API hiccups.

## The tools

Each tool is described below: what it does, the selection or computation rules that matter, and the gotchas worth knowing before you touch it. The two encrypted tools are covered under Access control above.

### Irish Military Units (`mu.js`)

Lists every MU owned by an Irish citizen, located in Ireland, with a majority-Irish roster.

Three checks decide whether an MU appears: the owner is currently an Irish citizen (founders who migrated away are dropped); the MU's own country, if it exposes one, is Ireland (MUs with no country field skip this check rather than being dropped, so missing data doesn't wipe the list); and at least half the members are Irish. There's also a hardcoded `EXCLUDED_MU_IDS` blacklist for manual removals.

Each member gets an eco / war / mixed tag based on how they've spent skill points. The classifier reads each skill's `level` (points spent), not `value` (the derived stat), because allocation is what reveals playstyle. `ECO_SKILLS` and `WAR_SKILLS` are the buckets; `PURITY_THRESHOLD` (0.6) sets how skewed an allocation must be to count as pure, and `MIN_POINTS_TO_CLASSIFY` (5) suppresses tags for players who've barely started.

Capacity is `dormitories * 5`. MUs with no dormitory data have unknown capacity and show only under the "All" filter, never "Has slots" or "Full".

### Company Migration Advisor (`advisor.js`)

Rebuilt for v0.27. For each of a user's companies, says whether it sits in an Irish core region, and if not, what moving home is worth.

v0.27 left only two location effects: a +5% employee output bonus in a core region, and the controlling country's income tax, which is charged on employee wages and costs employees 1 happiness (worth 1% output) per percent. "Core" is read as `region.country === region.initialCountry`. The game doesn't document that rule, so treat it as inferred. Each company is **home** (Irish core region), **not core** (Irish-controlled but not core, i.e. Northern Ireland) or **abroad**.

Abroad cards compare "employee output from location" (core bonus minus tax rate) here and in Ireland, and say so plainly when staying abroad is better. They estimate the wage tax sent abroad as the last 7 days of `work.getStatsByCompany` `wage` × the country's `taxes.income`. A move costs 5 concrete, or nothing while `company.freeMoves ≥ 1` (a one-off v0.27 grant). Don't use `company.getProductionBonus`: it still returns only the dead deposit bonus.

`AdvisorTool.loadPlacements(userId)` is also what the dashboard's Migration card calls.

### Manager Check-In Monitor (`clockin.js`)

Lists each active company and its current manager using `manager.getByCompanyId`, with vacancies shown explicitly. Active/Inactive comes from the manager's `isInactive` flag. Cards show hourly pay, the production bonus, unpaid hours, and the profile's latest login and manager care timestamps. Missing profile data is shown as Unknown; failed company or manager lookups stop the run rather than imply vacancies.

The inactive filter uses the game's status. Sorting uses last login, with unknown timestamps last. Payroll is the sum of current hourly wages across all listed contracts multiplied by 3, 6 or 24 hours, assuming contracts and rates stay unchanged. It includes inactive managers and excludes unknown wages with a notice.

This replaces the removed player-worker roster and wage timeline. Hourly payments do not indicate attendance, and the API exposes no manager check-in history. The existing `#clockin?u=toie` route, Irish citizenship restriction and bypass parameter remain supported.

### Gear Softcap Advisor (`softcap.js`)

Finds the cheapest armor and dodge gear that still reaches the same effective percentage, so players stop paying for stat points that round away.

Armor and Dodge are the only two skills with a soft cap - every other skill has `softCap: null` in `gameConfig`, so the tool covers exactly three slots: chest and pants (armor) and boots (dodge). The game converts raw points with `effective% = round(100 * total / (total + softCap))`, where `total` is the skill contribution plus the gear contribution and `softCap` is 40 for both. Skill levels are integers, equipment rolls an integer inside its rarity's `dynamicStats` range, and the result is rounded, so effective% is a step function: consecutive totals collapse into bands and everything above a band's floor is wasted. With dodge maxed, boots rolled at 52, 53, 54 and 55 all give 70%.

Nothing is hardcoded. The soft caps, the skill level tables and every equipment tier's stat range are read from `gameConfig.getGameConfig` at runtime, so a balance patch flows through without a code change.

The skill dropdown recalculates the bands as if the player had that skill level. Assuming skills can't be respecced, bands entirely below the skill contribution are filtered out of both the target list and the band table.

One limitation, stated in the tool's how-to: `totalAfterSoftCap` is the only value the API exposes and the only one the game client consumes, but combat is resolved server-side. If the server rolled against an unrounded value, the bottom of a band would be marginally worse than the top.

### Buddy Finder (`buddy-finder.js`)

A self-service tool for the Irish buddy pool. Distinct from the MoE-only Buddy System Monitor, which is an admin oversight dashboard.

Buddies are not reciprocal pairs. Any Irish player can have a buddy managing each of their companies, while managing just one company themselves. A buddy is any Irish manager, whatever the wage. Every other company is an open slot, including one with a foreign manager.

Each search scans the whole pool: every Irish citizen's profile, their companies (`company.getCompanies`) and each company's manager (`manager.getByCompanyId`). Batched, that is under 20 requests for 130 citizens and 1,150 companies. A batch counts once against the game's rate limit. The API has no lookup from a player to the company they manage, so the scan is also what shows whether a player already manages an Irish company. It cannot see Irish players managing foreign companies. A failed profile, company list or contract stops the search rather than miscounting slots. `manager-core.js` holds the pool and ranking logic.

Results are a sortable table of every active Irish player. Management available is a player's Management when they can take a manager job: level 10 or above and not managing an Irish company. Manager jobs available is how many of their companies have no Irish manager. The table starts with the most jobs available, breaking ties by players free to manage, then higher Management, then username. The dashboard's Buddy Finder card shows the player's buddies, open slots and the top players free to manage.

### Ireland Donation Draw (`donation-draw.js`)

Aggregates money donated to Ireland over an exact, shareable date-time period and selects uniformly from unique donors who are current Irish citizens and meet the operator's aggregate minimum. Periods are half-open (`start <= createdAt < end`), limited to a 31-day lookback, and default to the previous seven days with a ₿1 minimum. Donation totals and counts never weight the draw: each eligible user has one entry.

Donation transaction field names are counterintuitive and were verified against the game UI. For `transactionType: 'donation'`, `buyerId` is the user who donated and `sellerCountryId === IRELAND_COUNTRY_ID` means Ireland received it. Do not reverse this mapping based on the trade-oriented buyer/seller names. Non-money, non-positive, item-only, userless, other-country, and other transaction records are excluded; unexpected donation-shaped records are surfaced as warnings.

The tool incrementally caches only the required public transaction fields in versioned `localStorage`, deduplicated by transaction ID and evicted after 31 days. It still fetches the newest API page every time it opens or refreshes. Current citizenship is reloaded separately and revalidated before the first roll or after it becomes stale; unresolved profiles and incomplete pagination disable selection rather than silently shrinking the pool.

Winner history is also versioned in `localStorage` and keyed by the exact normalized start, end, and minimum. Winners cannot repeat for that filter set until the operator explicitly resets the draw. Search, sorting, row expansion, and the ineligible-donor toggle affect only the audit table, never the random pool. Selection uses `crypto.getRandomValues()` with rejection sampling rather than `Math.random()`.

### Buddy System Monitor (`buddy.js`) and Battle Orders (`battle-orders.js`)

Both are password-encrypted (see Access control). Buddy System Monitor is the MoE-facing oversight version of Buddy Finder: it tracks every reciprocal employment pair across the Irish economy and flags strays and mismatches. Battle Orders is an MoD-facing live battle tracker with MU order compliance and a Discord push for commanders. Their gate code is public; the tool logic lives inside the encrypted payload.

### Daily Profit (`daily-profit.js`)

Estimates a player's daily profit across their companies and employees: engine vs staff throughput, wages, fidelity, daily/weekly missions, case sales, and per-product net margins (with country tax and production-bonus lookups). The economic model was validated formula-by-formula against Adro's spreadsheet — direct questions about the model go to Adro.

> **v0.27:** the model's inputs (`worker.getWorkers`, `workOffer.*`, fidelity, self-work tax, Entrepreneurship, deposits) are gone. Employee wages are now set by the employee and paid hourly, so the model needs rebuilding.

### Wealth tracker (`wealth.js`)

Charts any Irish citizen's wealth over time. A scheduled GitHub Action (`wealth_log.py`) snapshots every citizen's public wealth once a day into `data/wealth/<userId>.json`; the page fetches only the one file for the player being viewed, so it scales to hundreds of citizens. The wealth breakdown (companies, items, money, equipment, weapons) is the same public figure shown on an in-game profile.

### Employee Training (`employee-training.js`, `employee-core.js`)

**Assign tools and employees to companies** compares manual tool inventory and employee placements across the loaded companies. It accounts for product and coworker traits, happiness, saved specialization, Creature of Habit and tool expiry, then lists the recommended moves, swaps and equipment with the reasons for each. Companies it cannot reproduce exactly are left unchanged and out of the totals.

Which training card to keep. Loading a username reads every employee of the player's companies through the company employee endpoints (`employee.getCompanyEmployees`, `getCompanyEstimate`), shows a workforce summary with profit at today's prices, ranks where the next 10 energy is best spent (training each employee or hiring into a company with a free slot), compares typed-in candidates (hire, reroll or wait), ranks who is worth keeping against the best of a fresh candidate set (fire, replace or keep, with the bar a candidate must beat), and fills a calculator that ranks an exact hand for one employee. A hand an employee was dealt but hasn't picked from is read from the API (`pendingTraining.offers`) and listed above the energy ranking, so the player never types it in. Management fills from the account.

### Bunker monitor (`beer.js`)

A searchable, timezone-aware log of region bunker activity for the BEER alliance block. A scheduled GitHub Action (`bunker_log.py`) snapshots every region every few hours, diffs it, and records came-online / went-offline / level-changed / built events into `data/events.json` (rolling 30-day window), with `data/state.json` as the previous-snapshot baseline. Password-encrypted like the other two gated tools (BEER password).

## Data layer

All game data comes through one Cloudflare Worker at `warera-proxy.0x5ca1ab1e.workers.dev`. Its source lives in `worker/` — see `worker/README.md` for deploying it. It exposes these routes:

- `/trpc/*` proxies the live War Era tRPC API at `api2.warera.io`, injecting the game API token.
- `/deal-config-submit` creates a tax deal. Its dashboard is paused for v0.27 and the workflow is disabled.
- `/notify-discord` forwards a message to the Battle Orders Discord webhook (held as a Worker secret).
- `/healthz` reports whether the game API token is configured.

The old Worker also carried a `/monitored-update` route for a wealth-monitor watch-list. Nothing called it and no workflow received it, so it was not carried over.

The Worker holds the secrets — the game API token, and the GitHub PAT for the deal route. The browser never sees them. The whole site otherwise runs client-side and stores nothing about users.

Endpoints currently in use, for reference:

```
search.searchAnything
user.getUserLite, user.getById (+ fallbacks), user.getUsersByCountry
company.getCompanies, company.getById
worker.getWorkers, workOffer.getWorkOffersPaginated   (removed in v0.27, now 404)
transaction.getPaginatedTransactions
mu.getManyPaginated
region.getRegionsObject
country.getCountryById, country.getAllCountries
gameConfig.getGameConfig
party.getById, itemTrading.getPrices
```

## Access control

There are two separate mechanisms. Don't confuse them.

**Irish-only gate.** Personal tools (advisor, clock-in, buddy-finder) call `enforceIrishOnly` to block non-Irish users. Append `?bypass=1` to the hash for admin or debugging. The MU tool doesn't gate; it filters MUs down to Irish ones instead.

**Password-encrypted tools.** Buddy System Monitor (`#buddy`, MoE), Battle Orders (`#battle-orders`, MoD), and the Bunker monitor (`#beer`, BEER) ship their entire tool (CSS, HTML, JS) as an AES-encrypted blob in the source. The page is useless without the password, so the sensitive logic never reaches an unauthorised browser in readable form. (Caveat: the plaintext payload sources — `bo-payload.js`, `buddy-payload.js`, `beer-payload.js` — are also committed, so this only holds if the repo is private; see `.gitignore`.)

### How the encrypted tools work

- Blob format: base64 of `salt(16) || iv(12) || AES-GCM-256 ciphertext`.
- Key derivation: PBKDF2-SHA-256, 200000 iterations.
- On correct password, the gate decrypts the blob and injects it as a `<script>` tag, which mounts the real tool.
- The blob lives in the `BO_ENCRYPTED_PAYLOAD` / `BUDDY_ENCRYPTED_PAYLOAD` / `BEER_ENCRYPTED_PAYLOAD` constant at the top of the respective gate file.

To set up or rotate a password: encrypt the tool's payload file with the standalone `encrypt.html` generator (it is payload-agnostic and works for all three tools), then paste the resulting base64 string as the constant value. Until the constant is filled in, the gate shows "payload not configured yet" and does nothing.

The gate code itself (`buddy.js`, `battle-orders.js`, `beer.js`) is plain and public. Only the payload is secret.

## Styling conventions

`styles.css` defines the dark theme through CSS custom properties in `:root` (`--bg`, `--panel`, `--accent`, `--warn`, `--danger`, `--link`, `--muted`, `--text`, `--border`, and a few more). Use these variables. Don't hardcode colours. Add a new variable only when the existing palette genuinely can't express what you need (the one precedent is `--bf-orange` for the "mismatched" badge, where green, yellow, and red were already taken).

Other rules:

- **Scope every tool's classes with a prefix** (`clockin-`, `bf-`, and so on) so styles can't collide across tools sharing one stylesheet.
- **Reuse shared components** where they exist: `.steps` for loading, `.status` for the status line, `details.howto` for the "how this works" disclosure, `.icon-box` for item icons.
- **Mobile breakpoints** are at 720px, 640px, 600px, and 380px. Keep each tool's responsive overrides together so the file stays scannable.

## Adding a new tool

The process is build-standalone, then merge, and design must survive the merge.

**1. Build it standalone.** Make a throwaway page with its own HTML, CSS, and JS and get the tool fully working in isolation. This keeps experiments out of the main site until they're ready.

**2. Merge it in.** Five steps, in order:

1. Add a `<section class="view" data-view="yourtool">` to `index.html`.
2. Add a card for it on the home view so people can find it.
3. Fold its CSS into `styles.css`, renaming classes to a unique prefix and swapping any hardcoded colours for the theme variables.
4. Add `js/yourtool.js` following the IIFE-plus-`activate` pattern. Use `trpc`, `makeSteps`, `makeStatus`, `escapeHtml`, and `enforceIrishOnly` from `shared.js` rather than reinventing them.
5. Register it in `router.js` (add the name to `VALID` and map it in `tools`), and add its `<script>` tag in `index.html` before `router.js`.

**3. Preserve the look.** A merged tool should be indistinguishable in style from the existing ones. Same loading panel, same status line, same card and disclosure patterns, same spacing. If it looks like a different site, the merge isn't finished.

## Credit

By toie. Live data via the [War Era API](https://api2.warera.io/docs/).
