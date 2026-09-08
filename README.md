# ZEP Auto-Color

A userscript that sets the Farbe of a ZEP Projektzeit automatically from the selected
Projekt and Vorgang, so that a colour-coded week view costs nothing to maintain and the
same Projekt always looks the same.

Despite the repository name there is no browser extension here — the whole thing is one
userscript file, for the reasons written down in
[ADR 0001](docs/adr/0001-userscript-not-browser-extension.md).

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) or
   [Tampermonkey](https://www.tampermonkey.net/) in Firefox, Chrome or Edge.
2. Open
   [zep-auto-color.user.js](https://raw.githubusercontent.com/ChristophRettinger/ASC.ZepExtension/main/zep-auto-color.user.js)
   and confirm the installation prompt.

That is the whole installation. The script declares `@updateURL` and `@downloadURL`
pointing at that same raw file, so your userscript manager picks up new versions on its
own. The `@match` pattern is `https://www.zep-online.de/*/view/*`, which covers any ZEP
tenant — nothing has to be edited to use it at a different company.

## How the colouring works

A Rule maps a Projekt, optionally narrowed to a single Vorgang, onto one of the ten
Farben ZEP offers. Rules are an ordered list and **the first match wins**, so a narrow
exception belongs above a broad family Rule.

- The Projekt is matched **by prefix** against the label shown in the dialog, so one Rule
  covering `ASC intern` also colours `ASC intern API` and `ASC intern DB`. Matching
  ignores case and collapses runs of whitespace.
- A Rule that names a Vorgang applies only to that Vorgang — matched by prefix as well —
  and never to an entry booked without one. A Rule that names no Vorgang covers its
  Projekt whatever the Vorgang is, so the many Projekte that have none are not a special
  case.
- A Projekt that no Rule matches is **left alone**. There is no fallback colour and no
  hashing of the name onto a slot: ten slots guarantee collisions between unrelated
  projects, and a missing Rule should be visible rather than silently guessed at.

The colour is written when a new Projektzeit dialog opens and whenever the Projekt or
Vorgang selection changes, in either dialog. Clicking a swatch yourself afterwards
therefore always wins — the script has already had its turn.

An existing Projektzeit that you merely **open** for editing is never re-coloured, so
colours set by hand months ago stay as they are; the status light says
`bestehender Eintrag` while that is what is happening. Changing its Projekt or Vorgang
does re-colour it, because that is a deliberate act on the booking. The reasoning is in
[ADR 0002](docs/adr/0002-never-recolour-an-existing-projektzeit.md).

The selection is **watched**, not subscribed to: every 250 ms the script compares what is
on screen with what was there a moment ago. ZEP's change notification cannot be relied on
— select2 emits jQuery events, the template and work-package routes fill the form with no
event at all, and ZEP's own `dispatchZepEvent` goes to `window` under names we do not
know — so nothing here depends on it. The event handlers that do exist only make the
common case feel instant.

### The palette

ZEP offers exactly ten Farben, so a Rule names one of these rather than a hex value:

| Name    | Hex       | Notes                                  |
| ------- | --------- | -------------------------------------- |
| `none`  | `#e6f2f0` | ZEP's near-white default               |
| `sage`  | `#b5d8d2` |                                        |
| `cream` | `#FFF2D9` |                                        |
| `mint`  | `#DEF6E7` |                                        |
| `ice`   | `#D9F4F9` |                                        |
| `lilac` | `#EADFF7` |                                        |
| `blush` | `#FFE6E0` |                                        |
| `amber` | `#FFD173` | saturated — spend it on what must pop  |
| `green` | `#86DFA7` | saturated                              |
| `cyan`  | `#73D8EA` | saturated                              |

Six slots are pale pastels and only `amber`, `green` and `cyan` genuinely leap out of a
week view, so they are worth saving for the Projekte you most need to spot at a glance.

### What ships by default

The `DEFAULT_RULES` in the script cover the three Projekte the dialog currently offers:
Orchestra gets the calm `sage`, because it is most of most weeks and a wall of one
saturated colour would defeat the point, while its `4500002385_00040` Vorgang, `ASC
intern API` and `ASC Schulung` get the three colours that stand out. Change any of it in
the editor — your local Rules win — or edit the constant and commit if the whole team
should get it.

## Configuring your Rules

The script adds a small button to the bottom right corner of the ZEP page. It doubles as
a status light: while a Projektzeit dialog is open it reports the Rule that matched, or
`keine Rule` when none did, which is how "nothing matched" can be told apart from "the
script is broken".

Clicking it opens the editor, where each Rule is a row:

- The **Projekt** is picked from the same dropdown the dialog offers, so it cannot be
  mistyped into a Rule that silently never matches, and stays editable text so a full
  name can be trimmed down to the prefix that covers a family.
- The **Vorgang** is optional free text, also matched as a prefix.
- The **Farbe** is picked from the real ZEP swatches.
- **↑ / ↓** reorder, deciding which Rule wins when two could match; **✕** deletes.
- A **⚠** marks a Rule that matches none of the Projekte currently on offer — usually a
  renamed or finished project.

`Als JSON bearbeiten, exportieren, importieren` opens the same Rules as JSON for bulk
edits, copying to the clipboard, saving to a file, and importing a set from a colleague.

Your Rules are stored in the browser's `localStorage`, per person and per browser, and
they override the `DEFAULT_RULES` shipped in the script file. Anyone who never opens the
editor gets those defaults; `Auf Standard zurücksetzen` followed by `Speichern` drops the
local copy and follows the shipped ones again.

The exported JSON is the same shape as `DEFAULT_RULES`, so turning a working local set
into the shared baseline is a matter of pasting it into the script and committing.

## Developing

The rule matching and the configuration merging are pure functions over plain data, with
no DOM and no jQuery, and they are covered by `node:test`:

```sh
node --test
```

There are no dependencies and no build step — the tests require the `.user.js` file
directly, which keeps the edit-and-reload loop that motivated choosing a userscript in
the first place. Point your userscript manager at your working copy to develop against
the live application.

The DOM adapter is deliberately not unit-tested. Binding to select2, reading a selected
option label and checking a radio are thin glue over an application whose markup we do
not control; a mock of that markup would assert our own assumptions rather than ZEP's
behaviour, and would keep passing on the day ZEP changes it. It is verified by hand
against the live application instead, which is what the status light and the debug
tracing exist to support.

Every hook is defensive: if a selector or a global is missing, the script traces and does
nothing else. Booking time in ZEP must never be blocked by this script.

### Debugging against the live application

Set `DEBUG = true` in the file, or turn tracing on without editing it:

```js
ZepAutoColor.setDebug(true); // survives page loads; setDebug(false) turns it off again
```

`window.ZepAutoColor` also exposes the pure core, the current `state`, `resolveNow()` to
force a pass over the open dialog, and `openEditor()`.

Note that ZEP carries its session in the URL as a `CLIENTSESSID` query parameter. That
value is a live credential: never paste it into a bug report, a commit or a log.

## Repository layout

| Path                       | What it is                                              |
| -------------------------- | ------------------------------------------------------- |
| `zep-auto-color.user.js`   | The whole script: pure core, then the DOM adapter        |
| `test/`                    | `node:test` coverage of the pure core                    |
| `CONTEXT.md`               | The domain vocabulary, kept in ZEP's own German terms    |
| `docs/adr/`                | The decisions that would otherwise be re-litigated       |
