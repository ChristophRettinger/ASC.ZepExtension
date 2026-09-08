'use strict';

// The pure core is required straight out of the userscript - no build step, so the
// edit-and-reload loop that motivated ADR 0001 stays intact. The DOM adapter behind the
// `window` guard does not run here.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PALETTE,
  DEFAULT_RULES,
  paletteSlot,
  normalizeRules,
  mergeRules,
  resolveFarbe,
  findStaleRules,
  serializeRules,
  rulesFrom
} = require('../zep-auto-color.user.js');

// Which palette slot comes out for a (Projekt, Vorgang) pair - the whole external
// behaviour of the script, expressed without a browser.
const farbeFor = (rules, projekt, vorgang) => {
  const match = resolveFarbe(rules, { projekt, vorgang });
  return match ? match.slot.name : null;
};

test('the palette is closed at the ten Farben ZEP offers', () => {
  assert.equal(PALETTE.length, 10);
  assert.deepEqual(
    PALETTE.map((slot) => slot.name),
    ['none', 'sage', 'cream', 'mint', 'ice', 'lilac', 'blush', 'amber', 'green', 'cyan']
  );
  assert.deepEqual(
    PALETTE.filter((slot) => slot.saturated).map((slot) => slot.name),
    ['amber', 'green', 'cyan']
  );
  assert.equal(paletteSlot('amber').hex, '#FFD173');
  assert.equal(paletteSlot('#FFD173').name, 'amber');
  assert.equal(paletteSlot('#ffd173').name, 'amber', 'hex lookup ignores case');
  assert.equal(paletteSlot('turquoise'), null);
  assert.equal(paletteSlot(''), null);
});

test('the shipped defaults are usable Rules', () => {
  const { rules, errors } = normalizeRules(DEFAULT_RULES);
  assert.deepEqual(errors, []);
  assert.equal(rules.length, DEFAULT_RULES.length);
});

test('a Projekt is matched by prefix, so one Rule covers a family', () => {
  const rules = [{ projekt: 'ASC intern', farbe: 'amber' }];
  assert.equal(farbeFor(rules, 'ASC intern'), 'amber');
  assert.equal(farbeFor(rules, 'ASC intern API'), 'amber');
  assert.equal(farbeFor(rules, 'ASC intern DB'), 'amber');
  assert.equal(farbeFor(rules, 'ASC extern'), null, 'a sibling family is not swallowed');
});

test('matching survives case and sloppy whitespace on either side', () => {
  const rules = [{ projekt: '  asc   INTERN ', farbe: 'cyan' }];
  assert.equal(farbeFor(normalizeRules(rules).rules, 'ASC Intern  API'), 'cyan');
});

test('Rules are tried in order and the first match wins', () => {
  // A narrow exception above a broad family Rule has to take precedence.
  const rules = [
    { projekt: 'ASC intern API', farbe: 'green' },
    { projekt: 'ASC intern', farbe: 'ice' }
  ];
  assert.equal(farbeFor(rules, 'ASC intern API'), 'green');
  assert.equal(farbeFor(rules, 'ASC intern DB'), 'ice');

  const reversed = [rules[1], rules[0]];
  assert.equal(farbeFor(reversed, 'ASC intern API'), 'ice', 'the broad Rule now wins');
});

test('a Rule narrows to a Vorgang when it names one', () => {
  const rules = [
    { projekt: 'Kunde Nord', vorgang: 'Support', farbe: 'blush' },
    { projekt: 'Kunde Nord', farbe: 'sage' }
  ];
  assert.equal(farbeFor(rules, 'Kunde Nord', 'Support'), 'blush');
  assert.equal(farbeFor(rules, 'Kunde Nord', 'Entwicklung'), 'sage');
  assert.equal(farbeFor(rules, 'Kunde Nord', ''), 'sage');
});

test('a Vorgang is matched by prefix too', () => {
  const rules = [{ projekt: 'Kunde Nord', vorgang: 'Support', farbe: 'blush' }];
  assert.equal(farbeFor(rules, 'Kunde Nord', 'Support 2026'), 'blush');
});

test('a Rule that names a Vorgang never matches an entry without one', () => {
  const rules = [{ projekt: 'Kunde Nord', vorgang: 'Support', farbe: 'blush' }];
  assert.equal(farbeFor(rules, 'Kunde Nord', ''), null);
  assert.equal(farbeFor(rules, 'Kunde Nord', undefined), null);
});

test('a Rule without a Vorgang works unchanged for Projekte that have none', () => {
  const rules = [{ projekt: 'Urlaub', farbe: 'mint' }];
  assert.equal(farbeFor(rules, 'Urlaub'), 'mint');
  assert.equal(farbeFor(rules, 'Urlaub', ''), 'mint');
});

test('an unmapped Projekt is left untouched - no fallback Farbe', () => {
  const rules = [{ projekt: 'ASC intern', farbe: 'amber' }];
  assert.equal(resolveFarbe(rules, { projekt: 'Kunde Sued' }), null);
  assert.equal(resolveFarbe([], { projekt: 'ASC intern' }), null);
});

test('nothing is decided while no Projekt is selected', () => {
  const rules = [{ projekt: 'ASC intern', farbe: 'amber' }];
  assert.equal(resolveFarbe(rules, { projekt: '' }), null);
  assert.equal(resolveFarbe(rules, { projekt: '   ' }), null);
  assert.equal(resolveFarbe(rules, {}), null);
  assert.equal(resolveFarbe(rules, null), null);
});

test('a matched Rule reports itself, so the status light can name it', () => {
  const rules = [
    { projekt: 'Kunde Nord', farbe: 'sage' },
    { projekt: 'ASC intern', farbe: 'amber' }
  ];
  const match = resolveFarbe(rules, { projekt: 'ASC intern API' });
  assert.equal(match.index, 1);
  assert.equal(match.rule.projekt, 'ASC intern');
  assert.equal(match.slot.hex, '#FFD173');
});

test('junk Rules are dropped with a complaint rather than crashing the list', () => {
  const { rules, errors } = normalizeRules([
    { projekt: 'Gut', farbe: 'amber' },
    { projekt: '  ', farbe: 'amber' },
    { projekt: 'Ohne Farbe' },
    { projekt: 'Falsche Farbe', farbe: 'octarine' },
    null,
    'nonsense',
    { projekt: ' Getrimmt ', vorgang: '  ', farbe: '#86DFA7', extra: 'ignoriert' }
  ]);

  assert.deepEqual(rules, [
    { projekt: 'Gut', farbe: 'amber' },
    { projekt: 'Getrimmt', farbe: 'green' }
  ]);
  assert.equal(errors.length, 5);
  assert.ok(errors.some((message) => message.includes('missing "projekt"')));
  assert.ok(errors.some((message) => message.includes('unknown "farbe"')));
  assert.ok(
    !Object.prototype.hasOwnProperty.call(rules[1], 'vorgang'),
    'a blank Vorgang is no Vorgang'
  );
});

test('an imported Rule may spell the Farbe as "color"', () => {
  const { rules, errors } = normalizeRules([{ projekt: 'Import', color: '#73D8EA' }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(rules, [{ projekt: 'Import', farbe: 'cyan' }]);
});

test('a colleague who never opens the editor gets the shipped defaults', () => {
  const defaults = [{ projekt: 'ASC intern', farbe: 'ice' }];
  assert.deepEqual(mergeRules(defaults, null), defaults);
  assert.deepEqual(mergeRules(defaults, undefined), defaults);
});

test('local Rules override the shipped defaults', () => {
  const defaults = [{ projekt: 'ASC intern', farbe: 'ice' }];
  const stored = JSON.stringify({ version: 1, rules: [{ projekt: 'Kunde Nord', farbe: 'cyan' }] });
  assert.deepEqual(mergeRules(defaults, stored), [{ projekt: 'Kunde Nord', farbe: 'cyan' }]);
  assert.equal(farbeFor(mergeRules(defaults, stored), 'ASC intern'), null);
});

test('a bare array is accepted as stored configuration', () => {
  const defaults = [{ projekt: 'ASC intern', farbe: 'ice' }];
  assert.deepEqual(
    mergeRules(defaults, '[{"projekt":"Kunde Nord","farbe":"cyan"}]'),
    [{ projekt: 'Kunde Nord', farbe: 'cyan' }]
  );
});

test('deleting every Rule is honoured, corrupt storage is not', () => {
  const defaults = [{ projekt: 'ASC intern', farbe: 'ice' }];
  assert.deepEqual(mergeRules(defaults, '{"version":1,"rules":[]}'), [], 'an empty list is meant');
  assert.deepEqual(mergeRules(defaults, '{'), defaults, 'unparsable JSON falls back');
  assert.deepEqual(mergeRules(defaults, '"nonsense"'), defaults);
  assert.deepEqual(mergeRules(defaults, '{"rules":"nope"}'), defaults);
});

test('stored junk is filtered while the salvageable Rules still load', () => {
  const stored = '{"version":1,"rules":[{"projekt":"Gut","farbe":"amber"},{"farbe":"amber"}]}';
  assert.deepEqual(mergeRules([], stored), [{ projekt: 'Gut', farbe: 'amber' }]);
});

test('a Rule matching none of the Projekte on offer is flagged as stale', () => {
  const rules = [
    { projekt: 'ASC intern', farbe: 'ice' },
    { projekt: 'Kunde Weg', farbe: 'cyan' },
    { projekt: 'kunde nord', farbe: 'sage' }
  ];
  const angebotene = ['ASC intern API', 'Kunde Nord', 'Urlaub'];
  assert.deepEqual(findStaleRules(rules, angebotene), [1]);
});

test('nothing is stale while no Projekt list is known', () => {
  const rules = [{ projekt: 'Kunde Weg', farbe: 'cyan' }];
  assert.deepEqual(findStaleRules(rules, []), []);
  assert.deepEqual(findStaleRules(rules, null), []);
  assert.deepEqual(findStaleRules(rules, ['  ']), []);
});

test('exported Rules import again unchanged', () => {
  const rules = [
    { projekt: 'ASC intern', farbe: 'ice' },
    { projekt: 'Kunde Nord', vorgang: 'Support', farbe: 'blush' }
  ];
  const exported = serializeRules(rules);
  assert.equal(JSON.parse(exported).version, 1);
  assert.deepEqual(normalizeRules(rulesFrom(exported)).rules, rules);
});
