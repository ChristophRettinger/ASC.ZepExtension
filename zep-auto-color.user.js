// ==UserScript==
// @name         ZEP Auto-Color
// @namespace    https://github.com/ChristophRettinger/ASC.ZepExtension
// @version      1.0.0
// @description  Sets the Farbe of a new ZEP Projektzeit automatically from the selected Projekt and Vorgang.
// @author       Christoph Rettinger
// @homepageURL  https://github.com/ChristophRettinger/ASC.ZepExtension
// @supportURL   https://github.com/ChristophRettinger/ASC.ZepExtension/issues
// @match        https://www.zep-online.de/*/view/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/ChristophRettinger/ASC.ZepExtension/main/zep-auto-color.user.js
// @downloadURL  https://raw.githubusercontent.com/ChristophRettinger/ASC.ZepExtension/main/zep-auto-color.user.js
// ==/UserScript==

// Two halves live in this one file:
//
//   1. A pure core over plain data - the palette, the Rules and the matching. No DOM and
//      no jQuery, exported for `node:test` under a `module` guard.
//   2. A DOM adapter that binds to ZEP and writes the Farbe, guarded behind a `window`
//      check so requiring this file from Node runs none of it.
//
// See docs/adr/ for why this is a userscript (0001) and why a Projektzeit opened for
// editing is never re-coloured (0002).

(function () {
  'use strict';

  // ----------------------------------------------------------------------------------
  // Palette
  // ----------------------------------------------------------------------------------

  // The ten Farben ZEP offers, in the order the dialog shows them. The hex value is the
  // literal `value` of the matching `input[type=radio][name=color]`, which is what gets
  // posted; the name exists so a Rule can say `amber` rather than `#FFD173`.
  // `saturated` marks the three that genuinely leap out of a week view.
  var PALETTE = [
    { name: 'none',  hex: '#e6f2f0', saturated: false },
    { name: 'sage',  hex: '#b5d8d2', saturated: false },
    { name: 'cream', hex: '#FFF2D9', saturated: false },
    { name: 'mint',  hex: '#DEF6E7', saturated: false },
    { name: 'ice',   hex: '#D9F4F9', saturated: false },
    { name: 'lilac', hex: '#EADFF7', saturated: false },
    { name: 'blush', hex: '#FFE6E0', saturated: false },
    { name: 'amber', hex: '#FFD173', saturated: true },
    { name: 'green', hex: '#86DFA7', saturated: true },
    { name: 'cyan',  hex: '#73D8EA', saturated: true }
  ];

  // The shared, diffable baseline. Local edits land in localStorage and win over this;
  // whoever never opens the editor gets exactly what is listed here. A Rule matches the
  // visible Projekt label by prefix, so one line covers a whole family of Projekte.
  // Orchestra is most of most weeks, so it gets a calm pastel: colouring the majority
  // with a saturated slot would turn the week view into a wall of one colour and defeat
  // the point. The saturated three are spent on the exceptions worth spotting.
  var DEFAULT_RULES = [
    { projekt: 'Orchestra', vorgang: '4500002385_00040', farbe: 'amber' },
    { projekt: 'Orchestra', farbe: 'sage' },
    { projekt: 'ASC intern API', farbe: 'cyan' },
    { projekt: 'ASC Schulung', farbe: 'green' }
  ];

  var STORAGE_KEY = 'zep-auto-color.rules';
  var PROJEKTE_KEY = 'zep-auto-color.projekte';
  var DEBUG_KEY = 'zep-auto-color.debug';
  var CONFIG_VERSION = 1;

  // ----------------------------------------------------------------------------------
  // Pure core: palette lookup, Rule normalisation, matching
  // ----------------------------------------------------------------------------------

  // Labels are compared with whitespace collapsed and case folded, so a Rule typed as
  // "asc intern" still covers "ASC Intern API" and a stray double space on either side
  // does not silently break a Rule.
  function normalizeLabel(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\s+/g, ' ').trim();
  }

  function foldLabel(value) {
    return normalizeLabel(value).toLowerCase();
  }

  // Resolves a palette slot from a name ("amber") or from a hex value ("#FFD173").
  function paletteSlot(value) {
    var wanted = foldLabel(value);
    if (wanted === '') return null;
    for (var i = 0; i < PALETTE.length; i++) {
      if (PALETTE[i].name === wanted) return PALETTE[i];
      if (PALETTE[i].hex.toLowerCase() === wanted) return PALETTE[i];
    }
    return null;
  }

  // True when `label` starts with `prefix`. An empty prefix matches nothing rather than
  // everything, so a half-typed Rule cannot swallow every Projekt.
  function matchesPrefix(prefix, label) {
    var p = foldLabel(prefix);
    var l = foldLabel(label);
    if (p === '' || l === '') return false;
    return l.indexOf(p) === 0;
  }

  // Coerces one arbitrary object into a Rule, or explains why it is not one. `color` is
  // accepted as an alias for `farbe` so that JSON from elsewhere still imports.
  function normalizeRule(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: 'not an object' };
    }
    var projekt = normalizeLabel(raw.projekt);
    if (projekt === '') return { error: 'missing "projekt"' };

    var slot = paletteSlot(raw.farbe !== undefined ? raw.farbe : raw.color);
    if (!slot) return { error: 'unknown "farbe" on projekt "' + projekt + '"' };

    var rule = { projekt: projekt, farbe: slot.name };
    var vorgang = normalizeLabel(raw.vorgang);
    if (vorgang !== '') rule.vorgang = vorgang;
    return { rule: rule };
  }

  // Normalises a whole list, dropping what cannot be salvaged and collecting the
  // complaints so that the editor can show them.
  function normalizeRules(raw) {
    var input = Array.isArray(raw) ? raw : [];
    var rules = [];
    var errors = [];
    for (var i = 0; i < input.length; i++) {
      var result = normalizeRule(input[i]);
      if (result.rule) rules.push(result.rule);
      else errors.push('Rule ' + (i + 1) + ': ' + result.error);
    }
    return { rules: rules, errors: errors };
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (err) {
      return undefined;
    }
  }

  // Pulls the Rule list out of whatever storage or an import happens to hold: the
  // `{ version, rules }` object the editor writes, or a bare array. Returns undefined
  // when there is nothing usable in there, which is what makes `mergeRules` fall back.
  function rulesFrom(stored) {
    var value = typeof stored === 'string' ? parseJson(stored) : stored;
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && Array.isArray(value.rules)) return value.rules;
    return undefined;
  }

  // Layers the local configuration over the shipped defaults. An explicitly empty list
  // is honoured - somebody who deleted every Rule meant it - while absent or corrupt
  // storage falls back to the defaults.
  function mergeRules(defaults, stored) {
    var base = normalizeRules(defaults).rules;
    var overrides = rulesFrom(stored);
    if (overrides === undefined) return base;
    return normalizeRules(overrides).rules;
  }

  // The one decision this script exists to make: which palette slot a Projekt and
  // Vorgang should be coloured with. Rules are tried in order and the first match wins,
  // so a narrow exception placed above a broad family Rule takes precedence. Returns
  // null for "no Rule matched", which every caller reads as "leave the Farbe alone".
  function resolveFarbe(rules, selection) {
    var projekt = selection ? selection.projekt : '';
    var vorgang = selection ? selection.vorgang : '';
    if (foldLabel(projekt) === '') return null;

    var list = Array.isArray(rules) ? rules : [];
    for (var i = 0; i < list.length; i++) {
      var rule = list[i];
      if (!rule || !matchesPrefix(rule.projekt, projekt)) continue;
      // A Rule without a Vorgang covers its Projekt whatever the Vorgang is, including
      // none at all. One with a Vorgang narrows to it, and never matches without one.
      if (normalizeLabel(rule.vorgang) !== '' && !matchesPrefix(rule.vorgang, vorgang)) continue;
      var slot = paletteSlot(rule.farbe);
      if (!slot) continue;
      return { index: i, rule: rule, slot: slot };
    }
    return null;
  }

  // Indices of the Rules that match none of the Projekte currently on offer - a renamed
  // or finished Projekt shows up here. With no known Projekt labels nothing is stale,
  // because there is nothing to compare against.
  function findStaleRules(rules, projektLabels) {
    var labels = (Array.isArray(projektLabels) ? projektLabels : []).filter(function (label) {
      return foldLabel(label) !== '';
    });
    if (!labels.length) return [];

    var list = Array.isArray(rules) ? rules : [];
    var stale = [];
    for (var i = 0; i < list.length; i++) {
      var rule = list[i];
      var covered = !!rule && labels.some(function (label) {
        return matchesPrefix(rule.projekt, label);
      });
      if (!covered) stale.push(i);
    }
    return stale;
  }

  // The wire format for storage, export and the JSON editor - one shape for all three,
  // so anything exported can be imported again unchanged.
  function serializeRules(rules) {
    return JSON.stringify({ version: CONFIG_VERSION, rules: normalizeRules(rules).rules }, null, 2);
  }

  function sameRules(a, b) {
    return JSON.stringify(normalizeRules(a).rules) === JSON.stringify(normalizeRules(b).rules);
  }

  var core = {
    PALETTE: PALETTE,
    DEFAULT_RULES: DEFAULT_RULES,
    STORAGE_KEY: STORAGE_KEY,
    PROJEKTE_KEY: PROJEKTE_KEY,
    CONFIG_VERSION: CONFIG_VERSION,
    normalizeLabel: normalizeLabel,
    paletteSlot: paletteSlot,
    matchesPrefix: matchesPrefix,
    normalizeRule: normalizeRule,
    normalizeRules: normalizeRules,
    rulesFrom: rulesFrom,
    mergeRules: mergeRules,
    resolveFarbe: resolveFarbe,
    findStaleRules: findStaleRules,
    serializeRules: serializeRules,
    sameRules: sameRules
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
  }

  // Everything below needs a browser. Node stops here.
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // ----------------------------------------------------------------------------------
  // DOM adapter
  // ----------------------------------------------------------------------------------

  // Flip DEBUG to true to trace to the console, or set the localStorage key without
  // editing the file: localStorage['zep-auto-color.debug'] = 'true'.
  var DEBUG = false;

  // ZEP names the controls of a new Projektzeit with bare ids and those of an entry
  // opened for editing with `popup_`-prefixed ones, so which pair is on screen is what
  // tells the two dialogs apart. `colourOnOpen` is where ADR 0002 lives: only a new
  // entry is coloured merely for being opened, while a change of Projekt or Vorgang is
  // acted on in both dialogs.
  var MODES = [
    {
      name: 'neu',
      projekt: '#projektId',
      vorgang: '#vorgangId',
      colourOnOpen: true
    },
    {
      name: 'bearbeiten',
      projekt: '#popup_projektId',
      vorgang: '#popup_vorgangId',
      colourOnOpen: false
    }
  ];

  var SEL = {
    modal: '#zep-popup',
    farbe: 'input[type=radio][name=color]'
  };

  // The selection is *watched* rather than subscribed to, because ZEP's change
  // notification cannot be relied on: select2 emits jQuery events, the creation routes
  // (copyVonVorlage / copyVonAGP / copyVonArbeitspaket) fill the form with no event at
  // all, and ZEP's own dispatchZepEvent goes to `window` under names we do not know.
  // Comparing what is on screen with what was there a moment ago depends on none of
  // that. The event handlers further down only make the common case feel instant.
  var WATCH_MS = 250;

  var state = {
    rules: [],
    projektLabels: [],
    farbeTouchedByHand: false,
    // The (mode, Projekt, Vorgang) triple last seen on screen, or null for "no dialog
    // is open", which is what makes the next sighting count as an opening.
    lastSelection: null,
    watchTimer: null,
    button: null,
    editor: null
  };

  function trace() {
    if (!DEBUG) return;
    var args = ['[zep-auto-color]'].concat(Array.prototype.slice.call(arguments));
    try {
      console.log.apply(console, args);
    } catch (err) {
      /* a console that refuses to log must not break booking time */
    }
  }

  // Every entry point is wrapped in this: a missing selector or a changed global logs
  // under DEBUG and does nothing else. Booking time in ZEP must never be blocked by
  // this script.
  function guard(name, fn) {
    return function () {
      try {
        return fn.apply(null, arguments);
      } catch (err) {
        trace('failed in ' + name, err);
        return undefined;
      }
    };
  }

  function readStorage(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      trace('localStorage unreadable', err);
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
      return true;
    } catch (err) {
      trace('localStorage unwritable', err);
      return false;
    }
  }

  function loadRules() {
    state.rules = mergeRules(DEFAULT_RULES, readStorage(STORAGE_KEY));
    trace('rules loaded', state.rules);
    return state.rules;
  }

  function saveRules(rules) {
    var normalized = normalizeRules(rules).rules;
    // Storage holds only the local deviation: a list identical to the shipped defaults
    // drops the key again, so the file stays the source of truth for anyone who has not
    // actually deviated from it.
    var stored = sameRules(normalized, DEFAULT_RULES) ? null : serializeRules(normalized);
    writeStorage(STORAGE_KEY, stored);
    state.rules = normalized;
    trace('rules saved', stored === null ? '(defaults, key cleared)' : normalized);
    return normalized;
  }

  function loadProjektLabels() {
    var raw = parseJson(readStorage(PROJEKTE_KEY) || 'null');
    state.projektLabels = Array.isArray(raw) ? raw.map(normalizeLabel).filter(Boolean) : [];
    return state.projektLabels;
  }

  // --- reading the dialog ---------------------------------------------------------

  // `#zep-popup` is `position: fixed`, so its offsetParent is null even while it is
  // fully visible: visibility is the class Bootstrap sets and nothing else. A control
  // that sits in no modal at all is taken at face value.
  function isVisible(node) {
    var modal = node.closest ? node.closest('.modal') : null;
    if (!modal) return true;
    return modal.classList.contains('show') || modal.classList.contains('in');
  }

  // The label as the person sees it, or '' for "nothing selected" - which includes the
  // placeholder option ZEP renders with an empty value.
  function selectedLabel(select) {
    if (!select || !select.options || select.selectedIndex < 0) return '';
    if (select.value === '') return '';
    var option = select.options[select.selectedIndex];
    return option ? normalizeLabel(option.textContent) : '';
  }

  // Which dialog is on screen, if any: the first mode whose Projekt control is both
  // present and visible. A new-entry form left behind in a hidden modal is skipped, so
  // an edit dialog is never mistaken for it.
  function activeForm() {
    for (var i = 0; i < MODES.length; i++) {
      var projektEl = document.querySelector(MODES[i].projekt);
      if (!projektEl || !isVisible(projektEl)) continue;
      return {
        mode: MODES[i],
        projektEl: projektEl,
        vorgangEl: document.querySelector(MODES[i].vorgang)
      };
    }
    return null;
  }

  function readSelection(form) {
    return {
      projekt: selectedLabel(form.projektEl),
      vorgang: selectedLabel(form.vorgangEl)
    };
  }

  function selectionKey(form, selection) {
    return [form.mode.name, selection.projekt, selection.vorgang].join('\n');
  }

  // The Projekte the dialog offers, cached so that the editor can flag stale Rules and
  // offer the live dropdown even before a dialog has been opened in this page load.
  function rememberProjektLabels(projektEl) {
    var labels = Array.prototype.map.call(projektEl.options, function (option) {
      return option.value === '' ? '' : normalizeLabel(option.textContent);
    }).filter(Boolean);
    if (!labels.length) return;
    state.projektLabels = labels;
    writeStorage(PROJEKTE_KEY, JSON.stringify(labels));
  }

  // --- writing the Farbe ----------------------------------------------------------

  function farbeRadios(projektEl) {
    var scope = (projektEl.closest && projektEl.closest('form')) ||
      document.querySelector(SEL.modal) ||
      document;
    return Array.prototype.slice.call(scope.querySelectorAll(SEL.farbe));
  }

  // The swatches carry no JavaScript behaviour - ProjektzeitFormMgr.js never mentions
  // `color` - so checking the radio is the whole write, and no change event needs
  // synthesizing for ZEP to post it.
  function applyFarbe(projektEl, slot) {
    var radios = farbeRadios(projektEl);
    if (!radios.length) {
      trace('no Farbe radios in the dialog');
      return false;
    }
    for (var i = 0; i < radios.length; i++) {
      if (normalizeLabel(radios[i].value).toLowerCase() === slot.hex.toLowerCase()) {
        radios[i].checked = true;
        return true;
      }
    }
    trace('palette slot not offered by this dialog', slot.name, slot.hex);
    return false;
  }

  // --- the decision ---------------------------------------------------------------

  // `respectManual` is for the one write that is not driven by a Projekt or Vorgang
  // change - saving the editor while a dialog is open - where a swatch clicked in the
  // meantime has to stay put. A change of Projekt or Vorgang always writes: acting last
  // is what makes either choice, ours or a human one, the durable one.
  function writeFarbe(form, reason, respectManual) {
    rememberProjektLabels(form.projektEl);
    var selection = readSelection(form);
    state.lastSelection = selectionKey(form, selection);

    var match = resolveFarbe(state.rules, selection);
    trace(reason, form.mode.name, selection, match ? match.rule : 'no rule matched');
    if (!match) {
      setStatus(null, selection);
      return;
    }
    if (respectManual && state.farbeTouchedByHand) {
      trace('write skipped, the Farbe was set by hand');
      setStatus(match, selection);
      return;
    }
    setStatus(applyFarbe(form.projektEl, match.slot) ? match : null, selection);
  }

  var updateFarbe = guard('updateFarbe', function (reason, respectManual) {
    var form = activeForm();
    if (!form) {
      state.lastSelection = null;
      setStatus(null, null);
      return;
    }
    writeFarbe(form, reason, respectManual);
  });

  // Shown while an existing Projektzeit is open and untouched, so that "the script is
  // deliberately keeping its hands off" does not read as "the script is broken".
  var EXISTING_NOTE = {
    text: 'bestehender Eintrag',
    title: 'ZEP Auto-Color: bestehender Eintrag. Die Farbe bleibt, bis Projekt oder ' +
      'Vorgang geändert wird.\nKlicken zum Konfigurieren.'
  };

  // The whole lifecycle, decided by comparing what is on screen with what was there a
  // moment ago: a dialog appearing, the selection changing, the dialog going away.
  // Nothing here depends on ZEP firing an event.
  var watch = guard('watch', function (reason) {
    var form = activeForm();
    if (!form) {
      if (state.lastSelection !== null) {
        state.lastSelection = null;
        state.farbeTouchedByHand = false;
        setStatus(null, null);
      }
      return;
    }

    var selection = readSelection(form);
    var key = selectionKey(form, selection);
    if (key === state.lastSelection) return;

    var opening = state.lastSelection === null;
    state.lastSelection = key;

    if (opening) {
      state.farbeTouchedByHand = false;
      rememberProjektLabels(form.projektEl);
      if (!form.mode.colourOnOpen) {
        // ADR 0002: an existing Projektzeit keeps the Farbe it has. Only an actual
        // change of Projekt or Vorgang, further down, writes anything here.
        trace('existing entry opened, its Farbe is left alone', selection);
        setStatus(null, selection, EXISTING_NOTE);
        return;
      }
    }

    writeFarbe(form, reason || (opening ? 'dialog opened' : 'selection changed'));
  });

  function startWatch() {
    if (state.watchTimer) return;
    state.watchTimer = window.setInterval(function () { watch('watcher'); }, WATCH_MS);
  }

  // ----------------------------------------------------------------------------------
  // Status light
  // ----------------------------------------------------------------------------------

  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (key) {
      var value = props[key];
      // A null value means "no attribute at all": setAttribute would stringify it, and
      // disabled="null" disables.
      if (value === null || value === undefined) return;
      if (key === 'style') Object.assign(node.style, value);
      else if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    });
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  var STYLE = [
    // Clear of ZEP's own bottom-right button, which otherwise sits on top of this one.
    '.zac-btn{position:fixed;right:84px;bottom:14px;z-index:2147483000;display:flex;',
    'align-items:center;gap:7px;max-width:320px;padding:6px 11px;border:1px solid #c7d0d3;',
    'border-radius:16px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.22);cursor:pointer;',
    'font:12px/1.35 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#243;}',
    '.zac-btn:hover{border-color:#8fa3a8;}',
    '.zac-dot{flex:0 0 auto;width:12px;height:12px;border-radius:50%;border:1px solid #9aa;}',
    '.zac-btn-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.zac-overlay{position:fixed;inset:0;z-index:2147483100;display:flex;align-items:center;',
    'justify-content:center;background:rgba(15,25,30,.45);',
    'font:13px/1.45 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#213;}',
    '.zac-panel{display:flex;flex-direction:column;width:min(860px,94vw);max-height:88vh;',
    'background:#fff;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.35);overflow:hidden;}',
    '.zac-head{display:flex;align-items:baseline;gap:10px;padding:13px 16px;',
    'border-bottom:1px solid #e2e8ea;background:#f6f9f9;}',
    '.zac-head h2{margin:0;font-size:15px;font-weight:600;}',
    '.zac-head p{margin:0;color:#5a6b70;font-size:12px;flex:1;}',
    '.zac-body{padding:12px 16px;overflow:auto;}',
    '.zac-foot{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:11px 16px;',
    'border-top:1px solid #e2e8ea;background:#f6f9f9;}',
    '.zac-foot .zac-spacer{flex:1;}',
    '.zac-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #eef2f3;}',
    '.zac-row-num{flex:0 0 20px;color:#8a9a9f;text-align:right;font-variant-numeric:tabular-nums;}',
    '.zac-row-fields{flex:1;display:flex;flex-wrap:wrap;gap:6px;}',
    '.zac-projekt{flex:2 1 210px;min-width:150px;display:flex;flex-direction:column;gap:3px;}',
    '.zac-vorgang{flex:1 1 130px;min-width:100px;align-self:start;}',
    '.zac-file{flex:1 1 200px;min-width:160px;font:inherit;}',
    '.zac-pick{flex:0 0 auto;align-self:start;}',
    '.zac-swatches{display:flex;gap:2px;}',
    '.zac-swatch{width:19px;height:19px;padding:0;border:1px solid #b6c2c5;border-radius:3px;',
    'cursor:pointer;font:11px/1 system-ui,Arial,sans-serif;color:#1a2b2f;text-align:center;}',
    // The ring is a box-shadow and not an outline, and the tick is a glyph: ZEP sets
    // `outline: none` on a focused button, which made the selection vanish for exactly
    // as long as the swatch kept the focus.
    '.zac-swatch[aria-pressed="true"]{box-shadow:0 0 0 2px #2b6cb0 !important;',
    'border-color:#2b6cb0 !important;}',
    '.zac-swatch.zac-sat{border-color:#7e8c90;}',
    '.zac-stale{flex:0 0 16px;color:#b7791f;cursor:help;text-align:center;}',
    '.zac-btn-sm{padding:3px 7px;border:1px solid #c3ced1;border-radius:4px;background:#fff;',
    'cursor:pointer;font:inherit;line-height:1.1;}',
    '.zac-btn-sm:hover{background:#eef3f4;}',
    '.zac-btn-sm:disabled{opacity:.4;cursor:default;}',
    '.zac-primary{border-color:#2b6cb0;background:#2b6cb0;color:#fff;}',
    '.zac-primary:hover{background:#255d99;}',
    '.zac-input,.zac-select{width:100%;padding:3px 5px;border:1px solid #c3ced1;border-radius:4px;',
    'background:#fff;font:inherit;box-sizing:border-box;}',
    '.zac-json{width:100%;min-height:190px;box-sizing:border-box;padding:7px;',
    'border:1px solid #c3ced1;border-radius:4px;',
    'font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;}',
    '.zac-note{margin:6px 0 0;color:#5a6b70;font-size:12px;}',
    '.zac-error{margin:6px 0 0;color:#9b2c2c;font-size:12px;white-space:pre-wrap;}',
    '.zac-details{margin-top:14px;border-top:1px solid #e2e8ea;padding-top:10px;}',
    '.zac-details summary{cursor:pointer;font-weight:600;}',
    '.zac-io{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0;}',
    '.zac-empty{margin:0;padding:14px 0;color:#5a6b70;}'
  ].join('');

  function injectStyle() {
    if (document.getElementById('zac-style')) return;
    document.head.appendChild(el('style', { id: 'zac-style', text: STYLE }));
  }

  function setDot(dot, slot) {
    dot.style.background = slot ? slot.hex : 'transparent';
    dot.style.borderStyle = slot ? 'solid' : 'dashed';
  }

  // The floating button doubles as the status light: it reports the Rule that matched
  // for the dialog currently open, so "no Rule matched" can be told apart from "the
  // script is broken".
  function setStatus(match, selection, note) {
    var button = state.button;
    if (!button) return;
    var dot = button.querySelector('.zac-dot');
    var text = button.querySelector('.zac-btn-text');

    if (!match && note) {
      setDot(dot, null);
      text.textContent = note.text;
      button.title = note.title;
      return;
    }

    if (match) {
      setDot(dot, match.slot);
      text.textContent = match.rule.projekt +
        (match.rule.vorgang ? ' / ' + match.rule.vorgang : '') +
        ' → ' + match.slot.name;
      button.title = 'ZEP Auto-Color: Rule ' + (match.index + 1) + ' von ' +
        state.rules.length + ' hat gematcht (Farbe ' + match.slot.name + ' ' +
        match.slot.hex + ').\nKlicken zum Konfigurieren.';
      return;
    }

    setDot(dot, null);
    if (selection && selection.projekt) {
      text.textContent = 'keine Rule: ' + selection.projekt;
      button.title = 'ZEP Auto-Color: keine der ' + state.rules.length +
        ' Rules passt auf "' + selection.projekt +
        (selection.vorgang ? '" / "' + selection.vorgang : '') +
        '". Die Farbe bleibt unverändert.\nKlicken zum Konfigurieren.';
      return;
    }
    text.textContent = 'Auto-Color: ' + state.rules.length +
      (state.rules.length === 1 ? ' Rule' : ' Rules');
    button.title = 'ZEP Auto-Color\nKlicken zum Konfigurieren.';
  }

  function mountButton() {
    if (state.button) return state.button;
    var button = el('button', {
      'class': 'zac-btn',
      type: 'button',
      onclick: guard('openEditor', function () { openEditor(); })
    }, [
      el('span', { 'class': 'zac-dot' }),
      el('span', { 'class': 'zac-btn-text' })
    ]);
    document.body.appendChild(button);
    state.button = button;
    setStatus(null, null);
    return button;
  }

  // ----------------------------------------------------------------------------------
  // Configuration editor, injected into the ZEP page - there is no options page for a
  // userscript (ADR 0001)
  // ----------------------------------------------------------------------------------

  function swatchPicker(rule, onPick) {
    var buttons = PALETTE.map(function (slot) {
      return el('button', {
        'class': 'zac-swatch' + (slot.saturated ? ' zac-sat' : ''),
        type: 'button',
        title: slot.name + ' ' + slot.hex + (slot.saturated ? ' (kräftig)' : ''),
        'aria-label': 'Farbe ' + slot.name,
        style: { background: slot.hex },
        onclick: function () {
          rule.farbe = slot.name;
          paint();
          onPick();
        }
      });
    });

    // The tick carries the selection as well as the ring around it, because a page whose
    // CSS fights the ring cannot make a glyph disappear.
    function paint() {
      buttons.forEach(function (button, index) {
        var selected = PALETTE[index].name === rule.farbe;
        button.setAttribute('aria-pressed', String(selected));
        button.textContent = selected ? '✓' : '';
      });
    }

    paint();
    return el('div', { 'class': 'zac-swatches' }, buttons);
  }

  function projektPicker(rule, onPick) {
    // The Projekt is picked from the live dropdown so that it cannot be mistyped into a
    // Rule that silently never matches, and stays editable text so that a full name can
    // be trimmed down to the prefix that covers a family.
    var text = el('input', {
      'class': 'zac-input',
      type: 'text',
      value: rule.projekt,
      placeholder: 'Projekt (Präfix)',
      'aria-label': 'Projekt',
      oninput: function () {
        rule.projekt = this.value;
        onPick();
      }
    });

    var options = [el('option', { value: '', text: state.projektLabels.length ?
      '‹ aus Dialog übernehmen ›' : '‹ noch kein Dialog geöffnet ›' })];
    state.projektLabels.forEach(function (label) {
      options.push(el('option', { value: label, text: label }));
    });

    var select = el('select', {
      'class': 'zac-select',
      'aria-label': 'Projekt aus der Liste übernehmen',
      onchange: function () {
        if (!this.value) return;
        rule.projekt = this.value;
        text.value = this.value;
        this.value = '';
        onPick();
      }
    }, options);

    return el('div', { 'class': 'zac-projekt' }, [text, select]);
  }

  function openEditor() {
    if (state.editor) return;
    injectStyle();

    // Edited on a copy: closing without saving must change nothing.
    var draft = normalizeRules(state.rules).rules.map(function (rule) {
      return Object.assign({}, rule);
    });

    var list = el('div', { 'class': 'zac-list' });
    var errorBox = el('p', { 'class': 'zac-error' });
    var jsonArea = el('textarea', {
      'class': 'zac-json',
      spellcheck: 'false',
      'aria-label': 'Rules als JSON'
    });
    var jsonDetails;

    function renderJson() {
      if (jsonDetails && jsonDetails.open) jsonArea.value = serializeRules(draft);
    }

    function render() {
      list.textContent = '';
      var stale = findStaleRules(draft, state.projektLabels);

      if (!draft.length) {
        list.appendChild(el('p', {
          'class': 'zac-empty',
          text: 'Keine Rules. Ohne Rule bleibt die Farbe jeder Projektzeit unverändert.'
        }));
      }

      draft.forEach(function (rule, index) {
        var row = el('div', { 'class': 'zac-row' }, [
          el('span', { 'class': 'zac-row-num', text: String(index + 1) }),
          el('div', { 'class': 'zac-row-fields' }, [
            projektPicker(rule, function () { renderStale(); renderJson(); }),
            el('input', {
              'class': 'zac-input zac-vorgang',
              type: 'text',
              value: rule.vorgang || '',
              placeholder: 'Vorgang (optional)',
              'aria-label': 'Vorgang',
              oninput: function () {
                if (this.value.trim() === '') delete rule.vorgang;
                else rule.vorgang = this.value;
                renderJson();
              }
            }),
            el('div', { 'class': 'zac-pick' }, [swatchPicker(rule, renderJson)])
          ]),
          el('span', {
            'class': 'zac-stale',
            text: stale.indexOf(index) === -1 ? '' : '⚠',
            title: stale.indexOf(index) === -1 ? '' :
              'Kein aktuell angebotenes Projekt beginnt mit "' + rule.projekt +
              '". Die Rule ist wahrscheinlich veraltet.'
          }),
          el('button', {
            'class': 'zac-btn-sm', type: 'button', title: 'nach oben',
            'aria-label': 'Rule nach oben', text: '↑',
            disabled: index === 0 ? 'disabled' : null,
            onclick: function () { move(index, -1); }
          }),
          el('button', {
            'class': 'zac-btn-sm', type: 'button', title: 'nach unten',
            'aria-label': 'Rule nach unten', text: '↓',
            disabled: index === draft.length - 1 ? 'disabled' : null,
            onclick: function () { move(index, 1); }
          }),
          el('button', {
            'class': 'zac-btn-sm', type: 'button', title: 'löschen',
            'aria-label': 'Rule löschen', text: '✕',
            onclick: function () {
              draft.splice(index, 1);
              render();
              renderJson();
            }
          })
        ]);
        list.appendChild(row);
      });
    }

    // Only the stale markers change while typing, so a keystroke must not rebuild the
    // rows and throw away the caret.
    function renderStale() {
      var stale = findStaleRules(draft, state.projektLabels);
      Array.prototype.forEach.call(list.querySelectorAll('.zac-row'), function (row, index) {
        var marker = row.querySelector('.zac-stale');
        var isStale = stale.indexOf(index) !== -1;
        marker.textContent = isStale ? '⚠' : '';
        marker.title = isStale ? 'Kein aktuell angebotenes Projekt beginnt mit "' +
          (draft[index] ? draft[index].projekt : '') +
          '". Die Rule ist wahrscheinlich veraltet.' : '';
      });
    }

    function move(index, delta) {
      var target = index + delta;
      if (target < 0 || target >= draft.length) return;
      var moved = draft.splice(index, 1)[0];
      draft.splice(target, 0, moved);
      render();
      renderJson();
    }

    function showErrors(errors) {
      errorBox.textContent = errors && errors.length ? errors.join('\n') : '';
    }

    function replaceDraft(rules) {
      draft.length = 0;
      rules.forEach(function (rule) { draft.push(rule); });
      render();
    }

    function applyJson() {
      var parsed = rulesFrom(jsonArea.value);
      if (parsed === undefined) {
        showErrors(['Das ist kein gültiges JSON, oder es enthält keine "rules"-Liste.']);
        return;
      }
      var result = normalizeRules(parsed);
      showErrors(result.errors);
      replaceDraft(result.rules);
    }

    function importFile(file) {
      if (!file) return;
      var reader = new window.FileReader();
      reader.onload = guard('importFile', function () {
        jsonArea.value = String(reader.result);
        if (jsonDetails) jsonDetails.open = true;
        applyJson();
      });
      reader.onerror = function () { showErrors(['Datei konnte nicht gelesen werden.']); };
      reader.readAsText(file);
    }

    function copyJson() {
      var text = serializeRules(draft);
      jsonArea.value = text;
      if (jsonDetails) jsonDetails.open = true;
      if (window.navigator.clipboard && window.navigator.clipboard.writeText) {
        window.navigator.clipboard.writeText(text)['catch'](function () { selectJson(); });
      } else {
        selectJson();
      }
    }

    function selectJson() {
      jsonArea.focus();
      jsonArea.select();
    }

    function downloadJson() {
      var blob = new window.Blob([serializeRules(draft)], { type: 'application/json' });
      var url = window.URL.createObjectURL(blob);
      var link = el('a', { href: url, download: 'zep-auto-color-rules.json' });
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    }

    var fileInput = el('input', {
      type: 'file',
      accept: 'application/json,.json',
      'class': 'zac-file',
      'aria-label': 'Rules aus Datei importieren',
      onchange: function () { importFile(this.files && this.files[0]); this.value = ''; }
    });

    jsonDetails = el('details', { 'class': 'zac-details' }, [
      el('summary', { text: 'Als JSON bearbeiten, exportieren, importieren' }),
      el('div', { 'class': 'zac-io' }, [
        el('button', {
          'class': 'zac-btn-sm', type: 'button', text: 'JSON übernehmen',
          onclick: guard('applyJson', applyJson)
        }),
        el('button', {
          'class': 'zac-btn-sm', type: 'button', text: 'Kopieren',
          onclick: guard('copyJson', copyJson)
        }),
        el('button', {
          'class': 'zac-btn-sm', type: 'button', text: 'Als Datei speichern',
          onclick: guard('downloadJson', downloadJson)
        }),
        fileInput
      ]),
      jsonArea,
      el('p', {
        'class': 'zac-note',
        text: 'Dieses JSON passt genau in die DEFAULT_RULES des Skripts - so wird aus ' +
          'einem lokalen Satz Rules der gemeinsame Standard.'
      })
    ]);
    jsonDetails.addEventListener('toggle', function () { renderJson(); });

    var panel = el('div', { 'class': 'zac-panel', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { 'class': 'zac-head' }, [
        el('h2', { text: 'ZEP Auto-Color' }),
        el('p', {
          text: 'Die erste passende Rule gewinnt. Projekt und Vorgang matchen als Präfix; ' +
            'ohne Vorgang gilt die Rule für das ganze Projekt.'
        }),
        el('button', {
          'class': 'zac-btn-sm', type: 'button', text: '✕',
          'aria-label': 'Schließen', onclick: function () { close(); }
        })
      ]),
      el('div', { 'class': 'zac-body' }, [list, errorBox, jsonDetails]),
      el('div', { 'class': 'zac-foot' }, [
        el('button', {
          'class': 'zac-btn-sm', type: 'button', text: '+ Rule',
          onclick: function () {
            draft.push({ projekt: '', farbe: 'none' });
            render();
            renderJson();
          }
        }),
        el('button', {
          'class': 'zac-btn-sm', type: 'button', text: 'Auf Standard zurücksetzen',
          title: 'Verwirft die lokalen Rules und nimmt wieder die im Skript gelieferten.',
          onclick: function () {
            showErrors(null);
            replaceDraft(normalizeRules(DEFAULT_RULES).rules);
            renderJson();
          }
        }),
        el('span', { 'class': 'zac-spacer' }),
        el('button', {
          'class': 'zac-btn-sm', type: 'button', text: 'Abbrechen',
          onclick: function () { close(); }
        }),
        el('button', {
          'class': 'zac-btn-sm zac-primary', type: 'button', text: 'Speichern',
          onclick: guard('saveEditor', function () {
            var result = normalizeRules(draft);
            if (result.errors.length) {
              showErrors(result.errors);
              return;
            }
            saveRules(result.rules);
            // close() re-resolves, so the dialog behind the editor picks up the new
            // Rules straight away.
            close();
          })
        })
      ])
    ]);

    var overlay = el('div', { 'class': 'zac-overlay' }, [panel]);
    overlay.addEventListener('mousedown', function (event) {
      if (event.target === overlay) close();
    });

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    }

    function close() {
      document.removeEventListener('keydown', onKeydown, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      state.editor = null;
      // Re-resolve so that the status light, and a dialog still open behind the editor,
      // reflect whatever the Rules now say.
      updateFarbe('editor closed', true);
    }

    document.addEventListener('keydown', onKeydown, true);
    document.body.appendChild(overlay);
    state.editor = overlay;
    render();
  }

  // ----------------------------------------------------------------------------------
  // Bootstrap
  // ----------------------------------------------------------------------------------

  // Every selector whose selection feeds the decision, in both dialogs.
  var SELECTION_SELECTOR = MODES.reduce(function (list, mode) {
    return list.concat([mode.projekt, mode.vorgang]);
  }, []).join(', ');

  function matchesSelector(node, selector) {
    return !!node && typeof node.matches === 'function' && node.matches(selector);
  }

  function markFarbeTouched() {
    state.farbeTouchedByHand = true;
    trace('Farbe set by hand');
  }

  // Native listeners in the capture phase. They need nothing from the page, and they
  // catch a plain select being changed even if the page's jQuery is not the instance
  // select2 triggers through.
  function bindNative() {
    document.addEventListener('change', guard('nativeChange', function (event) {
      if (matchesSelector(event.target, SELECTION_SELECTOR)) watch('native change');
      else if (matchesSelector(event.target, SEL.farbe)) markFarbeTouched();
    }), true);

    document.addEventListener('click', guard('nativeClick', function (event) {
      if (matchesSelector(event.target, SEL.farbe)) markFarbeTouched();
    }), true);
  }

  // select2 emits *jQuery* change events, which a native addEventListener('change')
  // never sees, so the page's own jQuery is used as well - available because of
  // @grant none. Everything is delegated from document so that the handlers survive the
  // dialog being destroyed and rebuilt. These bindings are a latency optimisation on top
  // of the watcher, never the only route: if any of them fails to fire, the next tick
  // notices the change anyway.
  function bindJQuery(jq) {
    jq(document)
      .on('shown.bs.modal', SEL.modal, guard('shown', function () {
        // A freshly shown dialog counts as an opening even if it happens to carry the
        // same selection as the one just closed.
        state.lastSelection = null;
        watch('dialog shown');
      }))
      .on('hidden.bs.modal', SEL.modal, guard('hidden', function () {
        state.lastSelection = null;
        state.farbeTouchedByHand = false;
        setStatus(null, null);
      }))
      .on('change', SELECTION_SELECTOR, guard('selectionChanged', function () {
        watch('jQuery change');
      }))
      .on('change click', SEL.farbe, guard('farbeTouched', markFarbeTouched));
    trace('bound to the page jQuery', jq.fn && jq.fn.jquery);
  }

  // jQuery is loaded by ZEP itself, which may not have happened yet at document-idle.
  function whenJQueryReady(attempt) {
    if (window.jQuery) return bindJQuery(window.jQuery);
    if (attempt > 40) {
      trace('window.jQuery never appeared, the watcher carries on alone');
      return undefined;
    }
    return window.setTimeout(function () { whenJQueryReady(attempt + 1); }, 250);
  }

  var start = guard('start', function () {
    DEBUG = DEBUG || readStorage(DEBUG_KEY) === 'true';
    loadRules();
    loadProjektLabels();
    injectStyle();
    mountButton();
    bindNative();
    startWatch();
    whenJQueryReady(0);
    window.ZepAutoColor = Object.assign({}, core, {
      state: state,
      resolveNow: function () { return updateFarbe('called from console'); },
      activeForm: activeForm,
      openEditor: openEditor,
      setDebug: function (on) {
        DEBUG = !!on;
        writeStorage(DEBUG_KEY, on ? 'true' : null);
        return DEBUG;
      }
    });
    trace('ready');
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { start(); });
  } else {
    start();
  }
}());
