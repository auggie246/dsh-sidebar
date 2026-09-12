# CONTEXT

Glossary for the DSH right-sidebar project.

## Sidebar

The user-facing panel docked to the **right** of the DeepSeek Harness web GUI,
opposite the existing left session sidebar. It is a single owner of its region
and hosts an ordered stack of Cards. The whole Sidebar collapses to a Rail and
re-expands from it. Its width is a globally remembered region size (alongside
the Panel's height): user-draggable at its left edge when floating, and
persisted so every workspace and session — including the shell's Details
Column resets — restores the same width.

## Sidebar Package

The `dsh-sidebar` plugin that owns the Sidebar and its Card Manifest. The
package is not Git-specific: Git Status and Commit Graph are its initial Cards,
and future Cards belong to this same Sidebar.

## Rail

The thin strip pinned to the right edge of the GUI that the Sidebar
collapses into. The Rail is a stacked bar of region toggles: one for the
Sidebar, one for the Panel. It is the re-entry point on the hero page, where
no session exists and the Panel toggle is disabled. Session pages use Header
Toggles instead, so the Rail never covers the shell's Turn Navigator — the
right-edge turn-mark lane of the conversation (ADR 0008).

## Header Toggles

The two region toggles (Sidebar and Panel) styled and positioned like the
shell's session-header utilities. While a new session remains blank, DSH
hides its header, so an overlay copy occupies the same top-right position.
Once the session starts, the toggles render as plain inline content inside
the real `conversation.session.header.utilities` row. Both seats use the
same button factory, so their behavior and appearance stay consistent.

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
height is user-draggable and it closes fully, leaving no strip behind. Its
height, like the Sidebar's width, is a globally remembered region size:
one browser-wide value that every workspace and session restores.

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

## Explorer

The view-only file-explorer Card (`id: 'explorer'`, last in the Card Manifest,
visible by default). Unlike the Git Cards it is not git-bound: its tree roots
at the current session's workspace directory — the same path the Git Cards
know as the Working Repository — and it renders in any workspace, git
repository or not. It lists directories lazily, one directory per expansion,
so never-expanded directories cost nothing; while the Card is visible it
re-scans only the directories the user expanded. It hides nothing: dotfiles,
`.git`, and gitignored entries all appear. Selecting a file opens a read-only
preview Panel Tab — one tab per file, a repeat select focuses the open tab —
through the pending-open store of ADR 0007. View-only means exactly that: the
Card renders the tree and opens previews, and every mutating action is
explicitly out of scope.

## Commit Ref Summary

The compact, per-row representation of Git refs in the Commit Graph. It shows
the highest-priority ref and a `+N` overflow affordance; hovering or focusing
shows all refs, while clicking opens an anchored informational popover. Ref
priority is remote-tracking branch, local branch, then tag. A symbolic HEAD
pointer, such as `origin/HEAD`, names a ref the row already shows, so the
summary never shows it. The
visible ref slot is capped at 120px so the commit message remains the row's
primary scan target.
