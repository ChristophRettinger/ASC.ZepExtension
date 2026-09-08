# ZEP Auto-Color

A userscript that sets the Farbe of a ZEP Projektzeit automatically from the selected
Projekt and Vorgang, so the colour never has to be clicked by hand.

## Language

### ZEP's own vocabulary

Kept in German, matching the labels in the ZEP UI, so a term in the code always names
the thing visible on screen.

**Projektzeit**:
A single recorded block of work — what the "Projektzeit erfassen" dialog creates.
_Avoid_: booking, time entry, timesheet row

**Projekt**:
The top-level work assignment a Projektzeit is booked to.
_Avoid_: job, engagement

**Vorgang**:
An optional subdivision of a Projekt. Not every Projekt has one; where it does, several
are available.
_Avoid_: task, sub-project, activity

**Tätigkeit**:
ZEP's third classification level. Present in the dialog but unused at this company, and
never an input to the colour decision.
_Avoid_: activity

**Farbe**:
The colour stored on a Projektzeit, chosen from a fixed set of swatches in the dialog.
Persisted by ZEP and visible to everyone, not a local styling effect.
_Avoid_: highlight, label, tag

### This project's vocabulary

**Palette slot**:
One of the exactly ten colours ZEP offers for a Farbe, identified by its hex value. The
colour space is closed: arbitrary hex is not representable.

**Rule**:
A mapping from a Projekt, optionally narrowed to a single Vorgang, onto a palette slot.
