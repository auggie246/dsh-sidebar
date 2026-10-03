# The Branch Picker lets git refuse unsafe switches; the card never stashes, forces or pre-checks

Issue #28. The Source Control card's branch label opens a Branch Picker, and
picking a branch changes the user's checkout. A future reader will wonder why
a surface that edits the working tree has no stash-and-switch, no force, and
no greyed-out rows for branches that cannot be checked out.

We decided the card runs a plain `git switch --no-guess <name>` through the
sandboxed git path of ADR 0006 and does nothing around it. Git already knows
every reason a switch is unsafe: local changes that a checkout would
overwrite, a branch checked out in another worktree, a merge or rebase in
progress, a repository with no commits. It refuses each with an exact
message, and the card shows that message in its existing dismissible error
line. Changes that do not conflict travel with the user to the new branch,
which is what `git switch` does in a terminal. `--no-guess` keeps a local pick
from silently creating a tracking branch: that is the remote-only pick's job,
and it names its remote explicitly (issue #29). A branch name that begins with
`-` is rejected before git sees it, so a name can never be read as an option.
The picker is disabled while another card action is busy, like Fetch, Pull and
Push.

Rejected alternatives. Blocking the picker while the tree is dirty: git would
have allowed most of those switches, so the guard would refuse safe work.
Offering stash-and-switch on refusal: it adds a mutating flow with its own
failure mode (a stash that conflicts on re-apply) and a path to lost work, in
a card whose other destructive action, discard, already needs a confirmation
step. Pre-checking and annotating rows, for example by parsing
`git worktree list` to disable branches another worktree holds: it duplicates
git's own rules in the plugin, drifts from them, and costs a second git call
on every open, for an error git already words well.

Consequence: the picker has no state to keep consistent with git. A refusal
costs the user one click and a readable message; they resolve it in their
terminal or the Source Control card (commit, discard) and pick again. If a
later ticket wants stash-and-switch or worktree annotations, it is a
deliberate addition on top of this seam, not a correction of it.
