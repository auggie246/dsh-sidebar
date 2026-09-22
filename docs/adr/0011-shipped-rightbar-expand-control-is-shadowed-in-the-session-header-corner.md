# The shipped Rightbar expand control is shadowed in the session-header corner

DSH 0.1.5 gave its built-in right Sidebar an expand control for the collapsed
state. The control is `ExpandButton` in `dsh-client-ui-sidebar-right`, and it
registers into the single-kind, session-scoped seat
`conversation.session.header.corner`. It returns `null` once the session's
rightbar is expanded, and its click calls `setExpanded(sessionId, true)` —
expand only, never collapse. Because the plugin owns that same right column
(ADR 0009), a fresh load showed two right-region control sets: our Region
Toggles and the shipped expand control. One click on the shipped control hid
it and left an empty shell column open beside an unexpanded Sidebar, and a
reload brought it back, since the shipped sidebar persists no state.

## Status

Accepted. It closes issue #26 and extends the seat-shadowing decision of ADR
0009 to the session-header corner.

## Decision

The plugin registers an `EmptyCornerSeat` component into
`conversation.session.header.corner` at priority `-1`. A single-kind seat
renders only its lowest-priority entry, so the empty component becomes the
winner and the shipped expand control never renders. The registration sits
behind the `HAS_RIGHTBAR` dialect check, so a shell without the rightbar
service face receives no entry at all. `HAS_RIGHTBAR` reads the same one-shot
layout snapshot that every other layout call in the plugin uses; a shell
whose layout service arrived after this plugin applied would already lose the
docked Sidebar, so the seat follows the same gate rather than a weaker one.

The column itself is closed in every state where our Sidebar does not dock
into it: the hero page, a blank session whether the floating overlay Sidebar
shows or not, and a started session with the Sidebar closed. Two places do
that: a `ctx.effect` at boot, which reports the column hidden before the
first Rail render, and the Rail layout effect, whose old guard skipped the
hero page and blank sessions. Both are behind `HAS_RIGHTBAR`; on older shells
the effective behavior of every page state is unchanged, call for call.

## What was verified

These facts came from the installed DSH 0.1.5-rc.2 packages.

- The seat is declared `{ kind: 'single', scope: 'session' }` in
  `dsh-client-ui-conversation`, and `dsh-client-ui-sidebar-right` registers
  `ExpandButton` there without a `priority`.
- `SlotRegistry.entriesOfSlot` documents the winner as "the first live
  (non-abdicated) entry of each cell in priority order", and ADR 0009 already
  relies on `-1` outranking a priority-less shipped registration.
- `dsh-client-ui-chat` calls `ctx.sidebarRight.openResource(...)` and
  hard-injects that service, so the `ui-sidebar-right` row must stay
  installed; only its visible seats lose.
- `LayoutController.closeRightbar()` only writes layout flags —
  `rightbarShown = false`, `rightbarTrack = false`, `rightbarFullscreen =
  false`, plus the instant-commit flag when the column was shown. It is safe
  at boot and idempotent when the column is already shut.
- No other package registers into the corner seat, so the entry has no
  unrelated occupant to displace.

## Consequences

- Exactly one right-region control set renders on the hero page, on a blank
  session, and on a started session, and it is ours.
- A reload restores the same single set, because the shadow is a
  registration, not a rendered state.
- The empty column can no longer be opened by a user click, and any column
  left open by an earlier state is closed at the next boot or Rail render.
- The plugin depends on one shell slot name and one priority convention. If a
  later shell renames the seat, the inject wait never fires and the duplicate
  control returns — a visible regression, not a crash.
- `scripts/test-single-toggle-set.mjs` pins the seat, its priority, the
  empty render, the boot close, a reload, the three page states, and the
  legacy no-op behavior against both distribution twins.

## Rejected alternatives

- **Hiding the button with CSS on `data-sidebar-right-expand`.** Rejected
  because it keeps the shell's expand path alive behind a hidden element, and
  it couples the plugin to a DOM marker the shell does not document.
  Removing the entry from the registry is the same change at the level the
  shell actually owns.
- **Putting our own toggle pair in the corner.** Rejected because the Region
  Toggles already own two seats, one of them the session-header utilities row
  (ADR 0008). A third seat would either duplicate the pair or move it, and it
  would sit in a cell the shell sizes for its own control.
- **Stopping at the corner registration and never closing the column.**
  Rejected because the shipped control may already have been pressed before
  the new build loads, and the hero and blank sessions would still show an
  empty column.
- **Closing the column on every shell, without the `HAS_RIGHTBAR` gate.**
  Rejected because older shells zero that column themselves; the extra
  `closeDetails()` calls would be new behavior for them, against the
  compatibility rule of ADR 0009.
