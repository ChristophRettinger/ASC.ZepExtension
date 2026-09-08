# Never re-colour a Projektzeit that was opened for editing

The script sets a Farbe when a new Projektzeit dialog opens and whenever Projekt or
Vorgang changes, but deliberately does nothing when an existing entry is merely opened.
Applying a Rule on open would silently overwrite a colour a person chose by hand, and an
existing entry that is merely uncoloured cannot be told apart from a new one by its
colour alone.

## Consequences

"Opened" is the whole of the exception. Changing the Projekt or the Vorgang of an
existing entry does re-colour it, because that is a deliberate act on a booking whose
colour should follow what it is now booked to, and because the colour is nothing but a
readable restatement of the Projekt.

Because the script only ever writes when the dialog opens or the selection changes,
clicking a swatch afterwards is already a durable manual override — whoever acts last
wins — so no "this colour was set by a human" flag needs storing or honouring anywhere.

The two dialogs are told apart by the ids of their controls: ZEP names the new-entry ones
`#projektId` / `#vorgangId` and the edit-mode ones `#popup_projektId` /
`#popup_vorgangId`. Whichever pair is on screen decides whether opening writes a colour,
which is a single flag on one table of selectors rather than a heuristic.

An earlier version bound *only* to the bare ids, on the theory that a script structurally
incapable of seeing an edit dialog cannot get this wrong. That was too blunt: it also
made a deliberate change of Projekt on an existing entry do nothing at all, which reads
as a plain defect rather than as a policy.

Opening an old uncoloured entry and watching nothing happen still looks like a bug. It is
not — and the status light says `bestehender Eintrag` while that is what is going on.
