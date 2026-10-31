const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadTraining(companies, tab = 'train') {
  const requests = [];
  const context = vm.createContext({
    console,
    IRELAND_COUNTRY_ID: 'ireland',
    document: { getElementById: () => ({}) },
    localStorage: { getItem: () => null },
    makeStatus: () => () => {},
    makeSteps: () => ({}),
    EmployeeAssignments: {
      createCardPricer: () => ({
        generation: 1,
        reset() {},
        request(key, jobs, priority) {
          requests.push({ key, jobs, priority });
          return { status: 'fallback', reason: 'No planner in this test.' };
        },
        reprioritize() {},
      }),
    },
  });
  const root = path.join(__dirname, '..', 'js');
  vm.runInContext(fs.readFileSync(path.join(root, 'employee-core.js'), 'utf8'), context);
  const source = fs.readFileSync(path.join(root, 'employee-training.js'), 'utf8');
  // Expose the existing closure to exercise its real feed and hand-pricing paths.
  const at = source.lastIndexOf('\n  return {');
  assert.ok(at > 0);
  vm.runInContext(source.slice(0, at) + `
    globalThis.training = {
      prefetchHands, feedRows,
      configure(companies, tab) {
        team = { companies, management: 0, energy: 100 };
        market = { ppValue: 1, list: [], types: {} };
        view.tab = tab;
      },
    };
  ` + source.slice(at), context);
  context.training.configure(companies, tab);
  return { training: context.training, requests };
}

const company = employees => ({
  company: { _id: 'company', itemCode: 'grain', activeUpgradeLevels: { breakRoom: 3 } },
  employees,
});
const employee = id => ({
  _id: id, name: id, age: 20, nationality: 'ireland', gender: 'male',
  base: { production: 2, responsibility: 2, luck: 2 },
  wage: 0.5, wageExpectation: 1, potential: 0, potentialMax: 5,
  traits: [],
  pendingTraining: { offers: ['production', 'responsibility', 'luck'].map(stat =>
    ({ card: 'drill', rarity: 'common', stat, delta: 1 })) },
});

for (const tab of ['train', 'hire']) {
  test(`background hand pricing with a free hiring slot on ${tab}`, () => {
    const { training, requests } = loadTraining([company([employee('worker')])], tab);
    assert.ok(training.feedRows().some(row => row.kind === 'hire'));
    training.prefetchHands();
    const hands = requests.filter(r => JSON.parse(r.key)[0] === 'hand');
    assert.equal(hands.length, 1);
    assert.equal(hands[0].jobs[0].subjectId, 'worker');
    assert.equal(hands[0].jobs[0].cards.length, 3);
    training.prefetchHands();
    assert.equal(requests.filter(r => JSON.parse(r.key)[0] === 'hand').length, 1);
  });
}

test('an empty company offers hiring without queuing an employee hand', () => {
  const { training, requests } = loadTraining([company([])], 'hire');
  assert.equal(training.feedRows()[0].kind, 'hire');
  training.prefetchHands();
  assert.equal(requests.length, 0);
});

test('hand queue follows training priority while hiring rows stay in the feed', () => {
  const older = { ...employee('older'), age: 40 };
  const younger = employee('younger');
  const { training, requests } = loadTraining([company([older, younger])]);
  const rows = training.feedRows();
  assert.ok(rows.some(row => row.kind === 'hire'));
  const expected = Array.from(rows.filter(row => row.kind === 'train'), row => row.emp._id);
  assert.equal(expected.length, 2);
  training.prefetchHands();
  const actual = requests.filter(r => JSON.parse(r.key)[0] === 'hand').map(r => r.jobs[0].subjectId);
  assert.deepEqual(actual, expected);
});

test('hand pricing still works when the company has no hiring slot', () => {
  const entry = company([employee('worker')]);
  entry.company.activeUpgradeLevels.breakRoom = 1;
  const { training, requests } = loadTraining([entry]);
  assert.ok(training.feedRows().every(row => row.kind === 'train'));
  training.prefetchHands();
  assert.equal(requests.filter(r => JSON.parse(r.key)[0] === 'hand').length, 1);
});
