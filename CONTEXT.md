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
When the overlay Sidebar opens, that copy shifts left by the remembered
Sidebar width and stays beside it. Once the session starts, the toggles render
as plain inline content inside the real
`conversation.session.header.utilities` row. Both seats use the same button
factory, so their behavior and appearance stay consistent.

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
leaves the Panel open but empty. Not to be confused with a Tab Type, which
belongs to the shipped Rightbar.

## File Preview

A read-only Panel Tab that displays one file from the current workspace. A File
Preview has one explicit presentation type: HTML Preview, Markdown Preview,
Text Preview, or Diff Preview. The Explorer chooses that type from the file
extension. The Panel picker lets the user choose it directly. Legacy saved
Panel state without `schema: 1` migrates once by the Explorer rules. Marked
state keeps its saved presentation authoritative.

## Text Preview

The safe source-text presentation for a File Preview. It preserves the file's
line structure and whitespace without interpreting the content as HTML or
Markdown. When the file extension names a programming language, the Text
Preview colours the source for that language; otherwise it stays plain. A file
that is neither HTML nor Markdown uses this presentation by default. One row
carries one source line with its own number in the gutter, so a wrapped line
keeps its number beside it. A toolbar row carries the path, a copy control, a
wrap toggle, and a hint at the browser's own find. At most 512 KB is coloured:
a larger file renders plain and the toolbar says so. When a caller reports a
line — a chip on the Files Changed Row does — the Text Preview marks that row
and brings it into view. A rendered HTML Preview or Markdown Preview has no
source row to mark, so it opens unmarked.

## Diff Preview

The change presentation for a File Preview. It shows one unified change between
the file as the last commit holds it and the file as the working repository
holds it now, as rows that carry the old number, the new number, and the
`-`/`+`/space marker. A Source Control file name and the Panel picker both ask
for it, and one path has one Diff Preview whatever mix of staged and unstaged
change it holds. Git considers an untracked file to have no change, so a diff
for such a file shows the Text Preview instead, under the same tab type and
identity.

## Sidebar Settings

The affordance inside the Sidebar where the user toggles each Card visible or
hidden. This is the mechanism that fulfills "modular cards" from the original
request.

## Details Column

DSH shell's pre-0.1.5 name for the built-in right column of the 3-column
layout (left session sidebar / center conversation / right details). DSH
0.1.5 renamed it the **Rightbar**: the slot is `rightbar`, the layout
service is `openRightbar` / `closeRightbar`, the drag handle is
`[data-side="rightbar"]`, and the zeroed-column marker is
`data-rightbar-collapsed`. The plugin speaks both dialects (ADR 0009) and
owns the right column on every supported shell. On 0.1.5 the shipped Rightbar
is a working tabbed sidebar with its own Files tree; the plugin still shadows
its visible seat, because the shipped Rightbar cannot stack views vertically
(ADR 0010). The expand control of the shipped Rightbar is not part of the
column: it is a button in the conversation header, in the
`conversation.session.header.corner` seat. The plugin shadows that seat with
an empty entry, so the shipped control never renders and exactly one
right-region control set — ours — stays on screen (ADR 0011). The plugin
also keeps that column shut whenever its own Sidebar does not dock into it:
on the hero, on a blank session, and on a started session while the Sidebar
is closed. The column is empty in all three states (ADR 0011).

## Pane

One bounded box below the Rightbar's tab strip, with its own strip. The
Rightbar starts with one Pane and splits it into at most two, always side by
side, with a draggable divider between 20% and 80% width. There is no vertical
split and no bottom region. This limit is why the plugin keeps its own column
(ADR 0010), and the word Pane is never used for the plugin's own surfaces.

## Tab Type

The Rightbar's extension unit. A Tab Type is declared once with its kind, its
address patterns, and its guide entry, and its body is registered separately
into the keyed tab seat. A Tab Type is not a Panel Tab: a Tab Type belongs to
the shipped Rightbar, and a Panel Tab belongs to this plugin's bottom Panel.

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
preview Panel Tab. Path and presentation form tab identity, so a repeat select
focuses the extension-selected tab while picker overrides stay separate. Opens
use the pending-open store of ADR 0007. View-only means exactly that: the
Card renders the tree and opens previews, and every mutating action is
explicitly out of scope.

## Files Changed Row

The shipped surface below a conversation turn that lists the files the session
created or changed. A chip on that row asks the shell's Rightbar to open its
file. This plugin owns the right column, so it answers that request with a
Panel Tab instead of a Rightbar tab (ADR 0012), and it marks the line the row
reported.

## Commit Ref Summary

The compact, per-row representation of Git refs in the Commit Graph. It shows
the highest-priority ref and a `+N` overflow affordance; hovering or focusing
shows all refs, while clicking opens an anchored informational popover. Ref
priority is remote-tracking branch, local branch, then tag. A symbolic HEAD
pointer, such as `origin/HEAD`, names a ref the row already shows, so the
summary never shows it. The
visible ref slot is capped at 120px so the commit message remains the row's
primary scan target.
