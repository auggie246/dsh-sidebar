# Plain-text file preview design

Status: approved design, partially implemented by issue #22.

Delivery is split across three tickets. Issue #22 adds picker-based Text Preview.
Issue #23 adds Explorer routing. Issue #24 adds legacy Panel-state migration.

## Problem

The Explorer currently opens every non-Markdown file as an HTML Preview.
Files such as `.gitignore` therefore render as HTML instead of source text.
The browser gives that document a white background and collapses its line breaks.

## Vocabulary

`CONTEXT.md` defines **File Preview** and **Text Preview**.
A File Preview is a read-only Panel Tab for one workspace file.
A Text Preview shows source text without interpreting HTML or Markdown.

## File type selection

Explorer selection uses case-insensitive file extensions:

- `.html` and `.htm` open as HTML Preview.
- `.md` and `.markdown` open as Markdown Preview.
- Every other path opens as Text Preview.

The fallback includes dotfiles, extensionless files, source files, data files, and unknown extensions.
Examples include `.gitignore`, `LICENSE`, `config.json`, `main.js`, `.svg`, and `.xml`.

The Panel `+` picker adds a `Text file` choice beside `HTML file` and `Markdown file`.
Picker choices are explicit overrides and do not depend on the path extension.
For example, a user can open `template.txt` as HTML or `page.html` as Text.

File-tab identity remains scoped by path and presentation type.
The same path can therefore have separate HTML, Markdown, and Text Preview tabs.
Explorer selection focuses the matching extension-selected tab.

## Text Preview behavior

A Text Preview has these presentation rules:

- Use the application theme colors.
- Use a monospace font.
- Preserve line breaks, spaces, and tabs.
- Do not wrap long lines.
- Provide vertical and horizontal scrolling.
- Do not show line numbers.
- Do not apply syntax highlighting.
- Do not show a hint bar.
- Show `File is empty.` when the file has no content.

Render content as text, not as HTML `srcdoc`.
Markup and scripts in a Text Preview must remain inert source text.

## Binary content

A Text Preview treats content containing any NUL byte as binary.
It shows an unsupported-binary message instead of decoded content.
No download action or file metadata is added.

This check applies only to Text Preview.
An explicit HTML or Markdown picker choice remains an override.

## Limits and errors

The existing `2 MB` file preview limit remains unchanged.
Existing loading and read-error states remain unchanged.
The Explorer remains view-only.

## Persisted Panel state

Existing Panel state uses the `dsh.rsidebar.panels.v1.<sessionId>` key without a schema marker.
It classifies most files as `html-file`.
The new implementation performs one legacy migration for each saved Panel state.

During that migration:

- Legacy `.html` and `.htm` file tabs remain HTML Preview.
- Legacy `.md` and `.markdown` file tabs become Markdown Preview.
- Every other legacy file tab becomes Text Preview.
- Non-file Panel Tabs keep their existing type and state.
- The active tab remains active when its migrated tab survives.

The upgraded state receives a schema marker and persists immediately.
After migration, saved presentation types are authoritative.
Later explicit picker overrides must survive Panel remounts and page reloads.

This migration intentionally reclassifies old explicit overrides once.
That trade-off fixes existing broken `.gitignore` tabs immediately.

## Distribution forms

The composition package and dynamic bundle must have matching behavior.
Changes therefore apply to both `lib/client.js` and `dynamic/client.js`.
The generated dynamic bundle must be rebuilt through the repository's existing script.

## Acceptance checks

Tests must verify these cases:

1. Explorer selection maps the four supported rendered extensions correctly.
2. Explorer selection maps dotfiles, extensionless paths, and other extensions to Text Preview.
3. Extension matching ignores letter case.
4. Text Preview preserves whitespace and cannot execute markup or scripts.
5. Text Preview supplies vertical and horizontal scrolling without wrapping.
6. Empty content shows `File is empty.`.
7. Any NUL byte shows the unsupported-binary state for Text Preview.
8. HTML and Markdown explicit overrides bypass Text Preview binary handling.
9. The picker lists `Text file` and treats all three file choices as explicit overrides.
10. Legacy Panel state migrates once by extension and keeps its active tab.
11. New explicit overrides persist unchanged after migration.
12. The `2 MB` limit and existing load errors still apply.
13. Composition and dynamic forms satisfy the same checks.
