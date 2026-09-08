# Ship as a userscript, not a browser extension

Despite the repository name, there is no manifest and no XPI here: the whole thing is a
single userscript for Violentmonkey/Tampermonkey. Firefox refuses to permanently install
unsigned extensions on the release channel, so shipping an extension to colleagues would
put an AMO signing round-trip in front of every change, whereas a userscript installs and
auto-updates from a raw GitHub URL and works in Chrome and Edge for free.

## Consequences

The core logic is kept free of userscript-manager APIs — `@grant none`, configuration in
`localStorage` — so it can be wrapped in a content script later without a rewrite.
`@grant none` is also required for a second reason: the Projekt and Vorgang dropdowns are
select2 widgets whose change events are jQuery events, which a sandboxed script listening
with `addEventListener` would never receive.

There is no extension options page, so the configuration UI has to be injected into the
ZEP page itself.
