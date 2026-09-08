# Never re-colour a Projektzeit that was opened for editing

The script sets a Farbe when a new Projektzeit dialog opens and whenever Projekt or
Vorgang changes, but deliberately does nothing when an existing entry is opened. Applying
a Rule on open would silently overwrite a colour a person chose by hand, and an existing
entry that is merely uncoloured cannot be told apart from a new one by its colour alone.

## Consequences

Because the script only ever writes at Projekt/Vorgang-change time, clicking a swatch
afterwards is already a durable manual override — whoever acts last wins — so no
"this colour was set by a human" flag needs storing or honouring anywhere.

This will look like a bug to anyone who opens an old uncoloured entry and watches nothing
happen. It is not.
