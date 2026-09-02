# CONTEXT

Glossary for the DSH right-sidebar project.

## Sidebar

The user-facing panel docked to the **right** of the DeepSeek Harness web GUI,
opposite the existing left session sidebar. It is a single owner of its region
and hosts an ordered stack of Cards. The whole Sidebar collapses to a Rail and
re-expands from it.

## Sidebar Package

The `dsh-sidebar` plugin that owns the Sidebar and its Card Manifest. The
package is not Git-specific: Git Status and Commit Graph are its initial Cards,
and future Cards belong to this same Sidebar.

## Rail

The thin, always-visible strip pinned to the right edge of the GUI that the
Sidebar collapses into. The Rail is the re-entry point: clicking it re-expands
the Sidebar. It is a stacked bar of region toggles: one for the Sidebar, one
for the Panel. The Rail never disappears, even when the Sidebar is closed.

## Card

One modular content unit inside the Sidebar (e.g. "Git Status", "Commit Graph").
Cards are independent of one another: adding, removing, or hiding a Card must
not affect other Cards. Cards are not collapsible — modularity is achieved by
show/hide, not by folding.

## Card Manifest

The Sidebar's internal ordered list of Cards
(`{ id, title, order, render }` entries). The single seam through which future
Cards are added.

## Panel

The user-facing region docked to the **bottom** of the center conversation
column, modeled on the VS Code terminal panel. It holds an ordered strip of
Panel Tabs and shows the active tab's content. The Panel is independent of
the Sidebar: each has its own toggle, and both can be open at once. Its
height is user-draggable and it closes fully, leaving no strip behind.

## Panel Tab

One closable, switchable content unit inside the Panel, modeled on VS Code
editor tabs. Every Panel Tab has a type (e.g. interactive shell, browser
preview, rendered preview). The user creates tabs with a "+" picker inside
the Panel and closes each tab with its own control. Closing the last tab
leaves the Panel open but empty.

## Sidebar Settings

The affordance inside the Sidebar where the user toggles each Card visible or
hidden. This is the mechanism that fulfills "modular cards" from the original
request.

## Details Column

DSH shell's name for the built-in right column of the 3-column layout
(left session sidebar / center conversation / right details). Today it is owned
by the built-in tool-call output viewer — which in the current shipped GUI has no
entry point and is never opened — so the Sidebar occupies it without displacing
any reachable UI.

## Working Repository

The git repository a session's Cards operate on, defined as the current
session's workspace root. When the workspace root is not a git repository,
the Cards render a "not a git repository" empty state.

## Commit Ref Summary

The compact, per-row representation of Git refs in the Commit Graph. It shows
the highest-priority ref and a `+N` overflow affordance; hovering or focusing
shows all refs, while clicking opens an anchored informational popover. Ref
priority is local branch, remote-tracking branch, symbolic HEAD, then tag. The
visible ref slot is capped at 120px so the commit message remains the row's
primary scan target.
