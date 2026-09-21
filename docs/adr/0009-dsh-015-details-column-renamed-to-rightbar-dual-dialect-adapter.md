# DSH 0.1.5 Details Column renamed to Rightbar: dual-dialect layout adapter

DSH 0.1.5-rc.2 restructured the shell layout. The session-scoped `details`
slot is gone, replaced by a root-scoped single-kind `rightbar` seat that the
new built-in right Sidebar (`ui-sidebar-right`) occupies. The layout service
lost `openDetails()`/`closeDetails()` and gained `openRightbar(track,
fullscreen)`/`closeRightbar()`. The frame's drag handle moved from
`[data-side="details"]` to `[data-side="rightbar"]`, and the zeroed-column
marker from `data-details-collapsed` to `data-rightbar-collapsed`. Against
the dsh-sidebar 0.5.3 client, every one of those renames was fatal: the
docked Sidebar never mounted, and the Rail's layout effect threw
`layout.openDetails is not a function`.

Two facts shaped the response. First, the structure underneath did not move:
the frame still serializes its grid as `<sidebar>px minmax(0px, 1fr)
<right>px`, the overlay layer is still the frame's direct child, and the
center column is still its second element child. The width-follow, the
persisted-release capture, and the overlay padding rules therefore port as
renames, not rewrites. Second, the built-in right Sidebar cannot simply be
disabled: `dsh-client-ui-chat` hard-injects the `sidebarRight` service and
calls `ctx.sidebarRight.openResource(...)` on file links, so disabling
`ui-sidebar-right` keeps Chat from mounting at all. Install-time disable
patches (which the bundle patch language does support) were rejected for
that reason.

We decided the plugin feature-detects the layout service face once at boot
(`typeof layout.openRightbar === 'function'`) and speaks both dialects
everywhere, so one build serves 0.1.1, 0.1.2 and 0.1.5 shells without
version sniffing. Region toggles and the Rail layout effect route through
`openRightRegion()`/`closeRightRegion()` helpers that call the detected
face (`openRightbar(true, false)` reserves the track and keeps fullscreen
off, matching the docked Details behavior). The plugin registers the new
`RightbarDock` component into the `rightbar` seat with priority -1: a
single-kind seat renders its lowest-priority entry, so the Workspace
Sidebar shadows the shipped right Sidebar exactly the way it shadowed the
Details Column's occupant before. `ui-sidebar-right` stays installed and
still provides its service for Chat; only its visible seat loses. Because
the rightbar seat is root-scoped and carries no framework sessionId,
`RightbarDock` resolves the current session from the root props like the
Header Toggles do, and renders nothing while the Sidebar is closed or the
session has not started — the blank-session floating overlay (ADRs 0001 and
0005) is unchanged. The drag-persist capture accepts both handle
selectors, and the stylesheet carries the stale-handle hide rule and the
overlay padding rule in both the old and new attribute forms; on either
shell one half simply matches nothing.

Consequences. On 0.1.5 the plugin regains its docked Sidebar, its
width persistence, its drag handles, and its fresh-session overlay with no
user-visible change from 0.5.3 behavior. On older shells every legacy
code path and selector remains byte-identical, pinned by
`scripts/test-rightbar-layout-compat.mjs` against both simulated service
faces. The shipped right Sidebar's visible seat is shadowed: Chat file
links still reach `ctx.sidebarRight`, but no occupant renders the result;
whether to disable the overlapping `ui-sidebar-documentpreview` and
`ui-sidebar-files` rows is a later product decision, not part of this
adapter. The `@deepseek-ai/dsh-typert-protocol` peer range gains
`^0.1.5-rc.0` to cover the 0.1.5 runtime. Rejected alternatives: disabling
the built-in right Sidebar at install time (breaks Chat mounting, and does
not repair the renames even where it is safe); registering our content as
tab types inside `ctx.sidebarRightTabs` (a full redesign that discards the
plugin's own column behavior); and host-version sniffing (feature detection
is exact, while versions lie about which shell actually mounts).
