# The plugin keeps its own right column: native Rightbar tabs are rejected because panes cannot stack vertically

DSH 0.1.5 ships a built-in right Sidebar (`dsh-client-ui-sidebar-right`, the
`rightbar` seat) with a real extension API: a plugin registers tab types into
`ctx.sidebarRightTabs` and their bodies into the keyed
`sidebar.right.pane.tab` slot. We investigated migrating this plugin onto that
API — Source Control and Commit Graph as tab types, the built-in Files tree
replacing our Explorer Card, and file previews opening in the built-in
document viewer. The investigation was stopped on one finding: the built-in
sidebar splits a pane **horizontally only**. Two panes always sit side by
side, the limit is two, and there is no vertical stacking and no bottom
region. Our Sidebar stacks its Cards vertically in one scrolling column. That
shape is the product, so the migration fails, and the plugin keeps registering
its own component into the `rightbar` seat at priority -1, as ADR 0009
established.

## Status

Accepted. It affirms the shadowing decision of ADR 0009 and records why the
tab-type route was rejected.

## What was verified

These facts came from the installed DSH 0.1.5-rc.2 packages, not from
documentation alone. They are the evidence for the decision, and they are
worth keeping because a future attempt should not have to rediscover them.

- **Panes are horizontal.** The split planner compares
  `dockPaneIds(state).length >= 2` before splitting, and the drop zones are
  declared `horizontal`. The package README states it plainly: "The product
  allows two horizontal panes, initially equal, with divider ratios limited
  to 20%–80%."
- **A tab type registers in two stages.** Stage one is
  `ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?,
  title, guide? })`. Stage two is
  `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body)`.
  A page type omits `patterns` and is opened by `kind`. The body reads
  `useTabInfo()` for `{ sidebar, panel, tab }`.
- **A page type can carry a guide entry**, so a tab is creatable from the
  guide page and the "+" control.
- **Our Git layer needs no change.** The plugin's 14 Typert methods
  (`status`, `log`, `stage`, `unstage`, `commit`, `discard`, `sync`,
  `readFile`, `listDir`, and the PTY group) each take `cwd` as an explicit
  first argument, so a tab body can pass the session workspace exactly as the
  Card does today.
- **The seat shadowing is reversible in one line.** Removing the plugin's
  `rightbar` registration lets the built-in sidebar render with no other
  change, because that package registers the seat itself.
- **The built-in Files tab is a near-equivalent of our Explorer.** It lists
  one directory level at a time, lazily, from the session workspace root. It
  has no filesystem watching, search, rename, or context menu.
- **An extension can take over the `files` kind but not the `text` kind.**
  A `fallback` band type shares its kind with nothing, so the built-in text
  preview cannot be replaced by kind. A new viewer must claim the address
  with its own pattern.

## Consequences

- The plugin keeps its own `RightbarDock`, its docked-width follow, its
  `--rsb-panel-w` drag handling, and the CSS rules that hide the shell's own
  drag handle. The built-in right Sidebar's visible seat stays shadowed while
  its service stays live for Chat, exactly as ADR 0009 described.
- The bottom Panel is unaffected in either direction: it is plugin-local
  because the shell has no bottom row, and its space reservation keys off the
  frame's center column.
- The plugin still owes the user the two features that motivated the
  investigation: Source Control and Commit Graph are already present, and
  neither the built-in sidebar nor this decision adds them.
- Deprecating pre-0.1.5 shells stays an independent decision. Because the
  plugin keeps owning the column, the dual-dialect adapter of ADR 0009 is
  still what serves both shells, and dropping it is a separate change with
  its own cost.

## Rejected alternatives

- **Migrating to tab types.** Rejected on the pane constraint above. It would
  have deleted the Card Manifest, the docked-width machinery, and the
  dual-dialect adapter, at the cost of the stacked column.
- **One "Git" tab stacking both views vertically inside its own body.** This
  does reproduce the vertical shape, and it was a real candidate. Rejected
  because it collapses two independent, separately hideable views into one
  tab, and it still cannot show the file tree above them.
- **Two tabs in two horizontal panes.** Rejected because side-by-side is not
  the requested shape, and the 20%–80% divider ratio makes each half narrow.
- **Rebuilding the bottom Panel as a first-class shell region.** Rejected
  because the shell exposes no bottom seat, so this is a new build, not a
  migration.
