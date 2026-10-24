name
review-qa-suggest
description
Review a built-rails PR with trusted-review, code-review, or the built-in pass; reproduce each finding in Docker, verify a minimal fix, and put the suggestion and before/after video in one inline thread. Leave the review pending by default or submit in the developer's chosen permitted mode. Use for "review + QA + suggest fixes on PR", "review, QA and suggest", "review-qa-suggest", "trusted review + QA", or requests for verified fix suggestions on a PR.
argument-hint
<pr-url-or-number> [--engine trusted-review|code-review|built-in] [--post pending|comment|approve|request-changes] [--allow-post <comma list>] [--resume-upload] | onboard [--show|--reset]


review-qa-suggest
Find problems, prove them, prove the fix, post the fix as a one-click suggestion. A finding that does not reproduce is dropped. A fix that cannot be verified is posted as a plain finding with no suggestion block.
Usage
/review-qa-suggest <pr> [--engine <name>] [--post <mode>] [--allow-post <list>]
/review-qa-suggest <pr> --resume-upload        # only 4c, for a review the operator has submitted
/review-qa-suggest onboard [--show|--reset]    # save, show or clear your defaults
Setting
Flag
Env
Saved preference
Default
Review engine
--engine trusted-review|code-review|built-in
REVIEW_QA_SUGGEST_ENGINE
engine
ask with AskUserQuestion
Post mode
--post pending|comment|approve|request-changes
none
post
pending
Allowed post modes
--allow-post <comma list>
REVIEW_QA_SUGGEST_ALLOWED_POST
allow
pending,comment
Flag beats env, env beats the saved preference, and that beats the default. prefs.sh resolveapplies that order in step 0, before any work. Preferences come from Onboarding.
Pending by default. 4a always creates the review pending, so GitHub validates every line before publishing the review. With post mode pending the run stops there: the review stays pending, nothing is uploaded, and the dev reads and submits it from GitHub. Only a submitting post mode the developer chose, by --post or as a default they saved and confirmed in onboarding, and that is in the allow-list, submits it, in 4b with the event from 4.0, and only then does 4c upload the videos.
Allow-list. pending is always allowed. A requested mode outside the allow-list stops the run in step 0 with a message naming the list; it is never swapped for another mode. approve and request-changes work only when the dev both adds them to the allow-list and asks for them, by flag or by a saved default they confirmed in onboarding: an approval made by an agent under a person's account counts toward the reviews main requires, and the team's rule is no REQUEST_CHANGES unless asked. Approve guard: approve becomes comment while any P1, P2 or Blocker finding is still open (this run's, or an unresolved thread from anyone), while another reviewer's latest review still requests changes, or while the trusted-review engine returned a HUMAN CHECK item the operator has not seen yet, and the run says so. Every count fails closed: one that cannot be read stops the run instead of counting as 0. An agent never takes an outward action under the operator's account without the operator's say-so.
Submit can be refused. The auto-mode classifier may block a review submit in a Claude session. Pending stays the safe default for that reason. When the skill cannot submit, it prints the full gh api submit command with the ids written out, and the dev runs it.
Delegation: the main loop only orchestrates and judges. Review, QA and fix verification run in subagents with an explicit model: "opus". Anything that drives agent-browser runs in a model: "sonnet" subagent, never the main loop. The one exception is the trusted-reviewengine, which the main loop runs itself because it fans out its own persona subagents. Every subagent prompt repeats the gotchas at the bottom of this file that apply to it.
Skills this one leans on, by name (read them, do not copy them):
Skill
Path
Used for
pr-context
<repo>/.claude/skills/pr-context/SKILL.md
step 1 (built-inengine), the intent brief the review is judged against
code-review
built-in
step 1 (built-in and code-reviewengines)
trusted-review
<repo>/.claude/skills/trusted-review/SKILL.md
step 1 (trusted-reviewengine), minus its posting step
qa-pr
<repo>/.claude/skills/qa-pr/SKILL.md
stack checks, sign-in personas, agent-browsergotchas, viewport, evidence root, --attachread-back
demo-video
<repo>/.claude/skills/demo-video/SKILL.md
scripted takes, cut.shfor dead time
humanizer
optional, user-installed (if missing: short plain sentences, no em dashes, no filler)
every line of posted prose
<skill dir> below is the folder holding this file; it ships prefs.sh, post-mode.sh, human-checks.sh, sync-check.sh, fill-media.sh, check-anchors.jq, open-blockers.jq, changes-requested.jq, review-pages.jqand media-filled.jq.
Onboarding
/review-qa-suggest onboard saves a developer's own defaults, once. It is also offered on a run that finds no preferences file. Nothing in it is specific to one person: the file lives under that developer's home config, outside the repo, at bash <skill dir>/prefs.sh path($REVIEW_QA_SUGGEST_PREFS, else ${XDG_CONFIG_HOME:-$HOME/.config}/review-qa-suggest/prefs, next to the poem list in step 5). It holds key=value lines and is parsed, never sourced. onboard --show prints it (prefs.sh show) and onboard --reset deletes it (prefs.sh reset); the next run then offers onboarding again.
Ask with AskUserQuestion, one question at a time:
    1    "How should review-qa-suggest behave by default?" Options: Use the recommended defaults (engine built-in, post pending, allow-list pending,comment; nothing is ever submitted without a flag) or Choose my own. The first runs bash <skill dir>/prefs.sh recommended and stops there.
    2    Engine: trusted-review, code-review or built-in, described as in step 0.
    3    Default post mode: pending(recommended), comment, approve, request-changes.
    4    Allow-list ceiling: pending,comment(recommended), pending, pending,comment,approve, pending,comment,approve,request-changes. It must contain the default post mode; if it doesn't, say so and ask again.
    5    Only when 3 or 4 includes approve or request-changes, a separate confirmation that names the developer's own login (gh api user --jq .login) and says what it does: "With this default, review-qa-suggest will submit APPROVE (or REQUEST_CHANGES) reviews under your GitHub account without asking each time. An approval counts toward the reviews main requires. It is still lowered to a comment while any P1/P2 or Blocker is open, another reviewer requests changes, or a HUMAN CHECK item is waiting, and never used on your own PR." Options: Yes, save it or No, keep pending,comment. Only a yes passes --confirm-submit.
Then save: bash <skill dir>/prefs.sh save <engine> <post> <allow> (plus --confirm-submit after a yes) and show the saved line. prefs.sh refuses approve or request-changes without --confirm-submit, and on load it treats such a file as invalid, so a hand-edited file cannot skip the confirmation.
0. Resolve the PR, engine, post mode and stack
--resume-upload skips this whole step, and steps 1 to 4b. It is the operator's explicit request to publish the videos for a review they have submitted, often from a fresh session. Run the gh --attach check below, then find and check the existing run state instead of writing a new one; never run the rest of step 0, whose env.sh rewrite and cleanup would drop REVIEW_ID, REVIEW_NODE_ID, urls.txt and the upload marker:
PR=<number from the arg>
[ -f ~/.config/qa-pr/config ] && . ~/.config/qa-pr/config
ENV="${EVIDENCE_ROOT:-$HOME/Desktop/AI-PR-QA}/$PR/env.sh"
[ -f "$ENV" ] || { echo "STOP: no run state at $ENV; nothing to resume"; exit 1; }
. "$ENV"
[ -n "${REVIEW_ID:-}" ] && [ -n "${REVIEW_NODE_ID:-}" ] || { echo "STOP: $ENV has no review ids"; exit 1; }
echo "$ENV"
That printed path is <env.sh> from here on. Go straight to 4c, which refuses a review that is still pending.
Check the tools first. Step 4c uploads the media with gh pr comment --attach, which only exists in gh 2.99 and later, and finding that out at the last step wastes the whole run:
gh pr comment --help 2>&1 | grep -q -- '--attach' || echo "MISSING: gh pr comment --attach (gh >= 2.99, step 4c needs it)"
If it prints MISSING, stop and ask the user to upgrade gh the way they installed it (brew upgrade gh for Homebrew), then rerun the check. Don't work around it.
Preferences, post mode and engine. Run this before anything else, so a refused mode costs nothing. Pass the --engine, --post and --allow-post values, or empty strings when they were not given. prefs.sh resolve applies flag > env > saved preference > default; an invalid preferences file prints a NOTE: and falls back to the recommended defaults, never to a wider mode. post-mode.sh check then refuses a mode outside the allow-list:
bash <skill dir>/prefs.sh resolve "<--engine value>" "<--post value>" "<--allow-post value>" > "${TMPDIR:-/tmp}/rqs-resolve.$$" || exit 1
cat "${TMPDIR:-/tmp}/rqs-resolve.$$"
POST_REQ=$(sed -n 's/^POST_REQ=//p' "${TMPDIR:-/tmp}/rqs-resolve.$$"); ALLOW_REQ=$(sed -n 's/^ALLOW_REQ=//p' "${TMPDIR:-/tmp}/rqs-resolve.$$")
ENGINE=$(sed -n 's/^ENGINE=//p' "${TMPDIR:-/tmp}/rqs-resolve.$$"); rm -f "${TMPDIR:-/tmp}/rqs-resolve.$$"
bash <skill dir>/post-mode.sh check "$POST_REQ" "$ALLOW_REQ" || exit 2
case "$ENGINE" in trusted-review|code-review|built-in) echo "ENGINE=$ENGINE" ;; ASK) echo "ENGINE=ASK" ;; *) echo "REFUSED: unknown engine '$ENGINE' (trusted-review, code-review, built-in)"; exit 2 ;; esac
It prints the resolved values with PREFS=saved|missing|invalid, then POST_MODE= and ALLOWED_POST= (or a REFUSED: line and exit 2), then ENGINE=. On REFUSED, show the message to the dev and stop. Every NOTE: line goes into the final report. On PREFS=missing, and only when the run was not started with --resume-upload, offer Onboarding once before going on (AskUserQuestion: "Use the recommended defaults", "Choose my own", "Not now"); "Not now" carries on with the built-in defaults and asks again next run. Saved preferences only choose what is requested: 4.0's guards, the allow-list and the own-PR rule apply exactly as they do to a flag.
On ENGINE=ASK, ask the dev with AskUserQuestion, one question, three options: trusted-review (persona panel plus Repro, slowest, deepest on authz, perf, migrations and integrations), code-review (the built-in /code-review alone, fastest), built-in (this skill's pass: pr-context brief, then /code-review judged against the goal). On REFUSED, stop and show the line.
PR=<number from the arg>
gh pr view "$PR" --json number,url,headRefOid,headRefName,author,state \
  --jq '{number,url,headRefOid,headRefName,author: .author.login,state}'
headRefOid is the review's commit_id(HEAD_SHA). If the author pushes mid-run, follow Head check instead of starting over.
Run state lives in env.sh. The Bash tool drops shell variables between calls, so step 0 writes the run's values to $EVIDENCE_ROOT/$PR/env.sh once. Evidence root: EVIDENCE_ROOT from ~/.config/qa-pr/config (default ~/Desktop/AI-PR-QA), run folder $EVIDENCE_ROOT/$PR/:
PR=<number from the arg>
ENGINE=<resolved engine>; POST_MODE=<from post-mode.sh>; ALLOWED_POST=<from post-mode.sh>
[ -f ~/.config/qa-pr/config ] && . ~/.config/qa-pr/config
EVIDENCE_ROOT=${EVIDENCE_ROOT:-$HOME/Desktop/AI-PR-QA}
UPLOADING() { [ -e "$EVIDENCE_ROOT/$PR/evidence-uploading" ] && { echo "STOP: $EVIDENCE_ROOT/$PR/evidence-uploading exists, so an earlier run started uploading evidence. Rerun with --resume-upload to finish it, or remove the marker yourself once you have checked the PR. Nothing was changed."; return 0; }; return 1; }
UPLOADING && exit 1
mkdir -p "$EVIDENCE_ROOT/$PR"
ME=$(gh api user --jq .login)
HEAD_SHA=$(gh pr view "$PR" --json headRefOid --jq .headRefOid)
HEAD_REF=$(gh pr view "$PR" --json headRefName --jq .headRefName)
PR_NODE_ID=$(gh pr view "$PR" --json id --jq .id)
AUTHOR=$(gh pr view "$PR" --json author --jq .author.login)
printf 'PR=%q\nME=%q\nAUTHOR=%q\nEVIDENCE_ROOT=%q\nHEAD_SHA=%q\nHEAD_REF=%q\nPR_NODE_ID=%q\nENGINE=%q\nPOST_MODE=%q\nALLOWED_POST=%q\n' \
  "$PR" "$ME" "$AUTHOR" "$EVIDENCE_ROOT" "$HEAD_SHA" "$HEAD_REF" "$PR_NODE_ID" "$ENGINE" "$POST_MODE" "$ALLOWED_POST" > "$EVIDENCE_ROOT/$PR/env.sh.new" || exit 1
UPLOADING && { rm -f "$EVIDENCE_ROOT/$PR/env.sh.new"; exit 1; }
mv "$EVIDENCE_ROOT/$PR/env.sh.new" "$EVIDENCE_ROOT/$PR/env.sh" || exit 1
echo "$EVIDENCE_ROOT/$PR/env.sh"
The evidence-uploading marker means an earlier run's evidence upload started, and its env.sh holds the only copy of REVIEW_ID and REVIEW_NODE_ID that --resume-uploadneeds. So the marker check runs before anything in step 0 writes to the run folder, and again right before the new env.sh replaces the old one. Nothing earlier in step 0 writes there: the gh, post-mode and engine checks only read. The cleanup further down checks the marker a third time before it deletes or archives anything.
<env.sh> below means the absolute path that last line prints, written out literally (e.g. /Users/<you>/Desktop/AI-PR-QA/8134/env.sh), never through a variable, since nothing is set until it is sourced. Every later bash block, in this loop and in every subagent, starts with . <env.sh>, and every subagent prompt carries that path. Later steps append to the file (NOW and HEAD_SHA from the head check, HUMAN_CHECKS in step 1, the review ids in 4a, EVENT in 4.0); sourcing it again picks up the newest line for each. %q keeps a path with a space in it from breaking the file.
GitHub allows one pending review per user per PR, and step 4a creates one. If $ME already has a pending review on this PR, say so and stop; it may be the operator's own draft, so never delete or reuse it:
. <env.sh>
gh api "repos/builtforteams/built-rails/pulls/$PR/reviews" --paginate \
  --jq ".[] | select(.state == \"PENDING\" and .user.login == \"$ME\") | .html_url"
Find the stack already running for this worktree. Do not spin up a new one blindly:
docker compose ps --format json | jq -r '.Service + " " + .State + " " + (.Health // "")'
docker compose port web 3000          # 127.0.0.1:<port>
Compose names the project after the checkout directory (qa-pr, phase 3), so these commands run from the worktree checked out at the PR head. That worktree must be clean: git status --short --untracked-files=no prints nothing. Step 3 reverts each fix with git diff / git apply -R, which would also wipe any uncommitted edits to tracked files already there. Untracked files (compose.override.yml, a stray log) don't count, since neither command touches them. If it isn't clean, say so and stop; the user commits or moves those edits, never this skill.
The worktree must also sit exactly at the PR head GitHub knows. A local commit not pushed yet, or a checkout behind the PR, means the review, the QA and the suggestions would describe code the PR doesn't have:
. <env.sh>
LOCAL=$(git rev-parse HEAD) || exit 1
[ "$LOCAL" = "$HEAD_SHA" ] || { echo "STOP: worktree is at $LOCAL but the PR head on GitHub is $HEAD_SHA. Push your local commits or check out the PR head, then rerun."; exit 1; }
On a STOP, tell the operator; never push or move the branch for them.
Confirm the container serves that head with qa-pr phase 6's in-container diff, never with gitinside the container. This is the sync check: sync-check.sh takes a file holding a list of paths, run from the worktree root, and compares every one that compose watch syncs with the container's copy. It prints in sync: <n> file(s) when all match, out of sync: <path> lines otherwise, and refuses a missing or empty list, so a failed diff never reads as in sync:
. <env.sh>
gh pr diff "$PR" --name-only > "$EVIDENCE_ROOT/$PR/sync.list" || { echo "STOP: gh pr diff failed"; exit 1; }
bash <skill dir>/sync-check.sh "$EVIDENCE_ROOT/$PR/sync.list"
Every later "sync check fed X" means: write X's paths to sync.list the same way (stop if the command that lists them fails), then run sync-check.sh on it. The script's skip list is the source_sync develop.watch ignore list in compose.yml, minus config/; keep the two in step. Watch never syncs the skipped paths, so comparing them would report "out of sync" forever. Any out of sync line means the container is stale; wait for watch to catch up and rerun, and never QA or verify against it until it prints in sync.
config/ is ignored by the source_sync watch but has its own sync+restart watch on the app service (compose.yml), so while docker compose watch runs, a config/ change (locales, routes, initializers) syncs and restarts app. Wait for app to be healthy again before checking. sidekiq is not restarted by it, so a result that depends on a job reading changed config needs docker compose restart sidekiq; ask the user first. config/database.yml and config/sidekiq.yml are container-specific copies that source_init protects; a PR that changes them needs the user's call. .claude/and docs-only changes need no stack at all.
Then the port checks from qa-pr phase 3 (/login and /webpack/js/runtime.js both 200/302; retry a sandbox-blocked curl with dangerouslyDisableSandbox: true). No stack, the wrong branch, or out of sync: say which and stop. Ask the user before docker compose up.
The run folder is reused across runs on the same PR, so clear what a previous run generated before starting, or step 4a slurps stale comments and the video gate passes on stale clips (env.sh was just rewritten, so it starts fresh too). Review files are deleted; the previous run's media and patches (F<n>*: takes, clips, stills, patches) move into a dated prev-* folder, out of the paths this run reads. Step 0 is for a new review only; --resume-upload never reaches this block:
. <env.sh>
D="$EVIDENCE_ROOT/$PR"
[ -e "$D/evidence-uploading" ] && { echo "STOP: $D/evidence-uploading exists, so an earlier run started uploading evidence. Rerun with --resume-upload to finish it, or remove the marker yourself once you have checked the PR."; exit 1; }
find "$D" -maxdepth 1 -type f \( -name 'F[0-9]*.entry.json' -o -name 'F[0-9]*.md' -o -name 'findings*.jsonl' -o -name comments.json -o -name files.json -o -name anchors.txt -o -name review.json -o -name 'review.out' -o -name 'review.err' -o -name review.env -o -name 'summary*.md' -o -name evidence.md -o -name evidence-url.txt -o -name event.txt -o -name threads.json -o -name reviews.json -o -name 'media-*.md' -o -name 'posted*.json' -o -name urls.raw -o -name urls.txt -o -name env.sh.new -o -name sync.list \) -delete
if [ -n "$(find "$D" -maxdepth 1 -type f -name 'F[0-9]*' -print -quit)" ]; then
  P="$D/prev-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$P" || exit 1
  find "$D" -maxdepth 1 -type f -name 'F[0-9]*' -exec mv {} "$P/" \; || exit 1
  echo "moved the previous run's media to $P"
fi
Check agent-browser --version. Below 0.39.1, stop and ask the dev to upgrade with npm i -g agent-browser@latest && agent-browser install (run it with the same node that owns the global install, e.g. under mise). Older versions record at the CSS viewport size and ignore deviceScaleFactor, so the 1024x576 capture in Evidence media would come out at 1024x576 instead of 3840x2160.
Head check
A run takes 30 to 90 minutes and the author can push during it. Posting with a stale commit_idputs suggestions on outdated lines, so compare the PR head against HEAD_SHA at every phase boundary:
. <env.sh>
NOW=$(gh pr view "$PR" --json headRefOid --jq .headRefOid) || exit 1
if [ "$NOW" != "$HEAD_SHA" ]; then
  echo "head moved: $HEAD_SHA -> $NOW"
  printf 'NOW=%q\n' "$NOW" >> "$EVIDENCE_ROOT/$PR/env.sh"
fi
NOW goes into env.sh because the steps below run in later Bash calls, where only sourced values survive.
Run it after step 1, before each finding's QA in step 2, before each fix verification in step 3, right before creating the pending review in 4a, again before the submit in 4b, and once before the upload in 4c (where a moved head is only reported). Step 2 and 3 subagents run long, so their prompts carry this check and the <env.sh> path, and tell them to stop and report back when it fails.
At the same boundaries, look for review comments posted since the step 1 snapshot, and drop any finding that is now raised, replied to or resolved on the lines we are about to comment on. Replies are in gh api repos/builtforteams/built-rails/pulls/$PR/comments --paginate; resolution only shows up in GraphQL:
. <env.sh>
gh api graphql --paginate -F n="$PR" -f query='query($n: Int!, $endCursor: String) { repository(owner: "builtforteams", name: "built-rails") { pullRequest(number: $n) { reviewThreads(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { isResolved path line } } } } }'
When the head moved, don't restart blindly. Every command below starts with . <env.sh>, so HEAD_SHA is still the old head and NOW the new one:
    1    See what changed: . <env.sh>; gh api "repos/builtforteams/built-rails/compare/$HEAD_SHA...$NOW" --jq '{status, files: [.files[] | {filename, status}]}'. If the call fails or status is diverged or behind, the author force-pushed; start over from step 0.
    2    Bring the worktree to the new head. With no fix patch applied and git status --short --untracked-files=no clean, run git fetch origin "pull/$PR/head" then git merge --ff-only FETCH_HEAD. The pull ref lives on the base repo, so this works for fork PRs too, where <headRefName> doesn't exist on origin. Never git reset --hard, never bare git stash. Re-confirm the container with the step 0 sync check, fed every file the new commits touched (. <env.sh>; git diff --name-only "$HEAD_SHA" "$NOW").
    3    For each finding: if the new commits touched its lines or file, re-run its repro. Drop it if it no longer reproduces; if it was partly addressed, keep what is left and say so in the comment. If untouched, keep it but recompute its PR-head line numbers from gh pr diff "$PR" so the suggestion still lands inside a hunk. A saved F<n>.patchmust pass git apply --check on the new head before it is re-applied and re-verified; regenerate it if it doesn't.
    4    Run the step 1 engine again with only the new commits' diff (. <env.sh>; git diff "$HEAD_SHA" "$NOW") as its input, including the step 1 HUMAN CHECK count, and take any fresh findings through steps 2 and 3.
    5    Record the new head with . <env.sh>; printf 'HEAD_SHA=%q\n' "$NOW" >> "$EVIDENCE_ROOT/$PR/env.sh", and carry on where you were.
If the head moves a third time in one run, stop and tell the user the PR is still moving.
1. Review
Run the engine from ENGINE. Whatever it is, the output of this step is $EVIDENCE_ROOT/$PR/findings.jsonl in the format below, and steps 2 to 5 read only that file.
    •    built-in: load pr-context first (full depth) and get its intent brief for the PR. A missing Goal stops the run, as in trusted-review; ask the user instead of guessing. Then one opus subagent, given the whole brief in its prompt, runs Skill("code-review", args: "$PR high") and judges the diff against that goal.
    •    code-review: one opus subagent runs Skill("code-review", args: "$PR high") with no brief. Faster, and blind to the PR's goal.
    •    trusted-review: the main loop runs Skill("trusted-review", args: "$PR")and tells it, before it starts: skip its step 7 and post nothing. GitHub allows one pending review per user per PR and 4a needs that slot; a trusted-review draft would make 4a fail. It still writes its step 8 record, tmp/trusted-review/<pr>-<headsha7>.md, which is the findings source. Its HUMAN CHECK / needs-your-eyes items are not posted by this skill; relay them to the dev in the final report. Because the dev only sees them there, any HUMAN CHECK item also holds approve at comment in 4.0.
For built-in and code-review, never pass --comment or --fix; posting and fixing happen later.
Count the HUMAN CHECK items right after the engine runs, from the worktree root, and add them to env.sh. The other engines write 0. human-checks.sh counts every non-blank line in the brief section, whatever the bullet style, except a lone none; a missing record or section stops the run rather than counting as 0. After a head-check rerun the record has a new name, so the count adds to the earlier one:
. <env.sh>
HC=0
if [ "$ENGINE" = trusted-review ]; then
  REC="tmp/trusted-review/$PR-$(printf %.7s "$HEAD_SHA").md"   # after a head move: "$NOW" instead of "$HEAD_SHA"
  HC=$(bash <skill dir>/human-checks.sh "$REC") || exit 1
fi
echo "HUMAN_CHECKS=$(( ${HUMAN_CHECKS:-0} + HC ))" >> "$EVIDENCE_ROOT/$PR/env.sh"
Normalize every engine's output to one JSON object per line in findings.jsonl, written with jq -n (never by hand):
{"id":"F1","p":"P2","path":"lib/reports/foo.rb","line":120,"start_line":null,"side":"RIGHT","claim":"Totals double-count transfers when a position moves mid-period.","engine":"code-review"}
p is the P-tag guess (P1 blocker or data exposure, P2 real defect, P3 polish, P4 nit), line/start_line are PR-head lines (base-side for side: "LEFT"), and claim is one line. trusted-review uses its own scale (Pn · Disposition, P0 worst); map it like this:
trusted-review
here
P0 (any), or Blocker
P1
P1 Recommendation
P2
P2 Recommendation
P3
Nit, Adjacent, refuted by Repro
not carried over (record only)
Read existing inline comments with gh api repos/builtforteams/built-rails/pulls/$PR/comments --paginate and silently drop findings someone already raised on the same lines.
2. QA each finding
One opus subagent per finding (sonnet when it needs the browser). It reproduces the claim against the running stack:
    •    Server-side probes: docker compose exec --user ubuntu app bundle exec rails runner '<code>'.
    •    UI: agent-browser --session rqs-$PR(own named session; the default one is shared across Claude sessions) at http://127.0.0.1:<port>, personas and gotchas from qa-pr phase 3. Capture per Evidence media.
    •    Evidence to $EVIDENCE_ROOT/$PR/ with neutral names: the raw take F<n>-before-raw.mp4, its annotated version F<n>-before.mp4, F<n>-before.png, F<n>-console.txt. Label a runner or console capture as such; never pass it off as a UI repro.
Video is required. A confirmed finding with any UI surface gets one video, F<n>.mp4: the before take recorded here and the after take from step 3, joined with title cards per Evidence media. A still is a supplement, never the only evidence. A backend finding still gets a video when its effect shows anywhere in the UI, even as one blank table cell. A runner or console capture stands alone only when nothing is visible, and the comment says so in one line.
Each clip shows the repro steps in order, so a reader can follow along without the text. Record it per demo-video: rehearse off camera, then one scripted take with no dead time (page-load waits, typing pauses and idle holds come out), a cut between steps, under about 15s so the combined clip stays under about 40s. Annotate per Evidence media.
Seed data for a video is committed. The page loads it from a separate request, so a rolled-back transaction leaves nothing to film. Seed with a plain rails runner and write down exactly what was created (company, records, ids) in the finding's notes so it can be reused or cleaned up. Probes that only test a theory still run in a transaction that rolls back.
Seeded data only, never a prod restore.Record against the compose db, which starts from db/structure.sql plus db:seed (or the registry image's baked dump of that same seed), and the records you seed yourself. Never record against a database restored from production or customer data, because whatever is on screen ends up in an uploaded video. If the stack's data looks real, stop and ask.
Drop every finding that does not reproduce. Re-tag P-levels from what actually happened, and write the survivors to findings.confirmed.jsonl in the same format. Always write the file, even when nothing survived (: > "$EVIDENCE_ROOT/$PR/findings.confirmed.jsonl"); 4.0 treats a missing file as an error, not as zero findings.
3. Fix and verify
For each confirmed finding, one opus subagent (sonnet for the UI re-check). Run them one finding at a time, never two fix subagents on the same worktree at once: each applies, syncs and reverts its patch on the shared checkout and stack, so a second one would record its after take against the other's code.
    1    Check git status --short --untracked-files=no is clean, then write the smallest patch that fixes it, on the host worktree. The changed lines must sit inside the PR diff's hunks, because GitHub rejects a suggestion on lines outside the diff. A fix that needs lines outside the diff is reported as a plain finding with a fenced diff instead.
    2    Get it into the container. Host edits sync only while docker compose watch runs; start docker compose watch --no-up & if it isn't, then run the step 0 sync check fed every file the fix touches (git diff --name-only). It must print in sync before any repro, spec or after clip runs; otherwise the "verified" result came from unfixed code. A fix that touches config/ restarts app through its watch; wait for it to be healthy, and restart sidekiq too when the result depends on it (ask first), after applying and again after reverting.
    3    Verify: the repro from step 2 no longer reproduces, targeted specs pass inside the container (docker compose exec --user ubuntu app bundle exec rspec <paths>, with the test DATABASE_URL from Gotchas), and the UI around the change is re-checked in the browser. Record the after take (F<n>-after-raw.mp4, annotated to F<n>-after.mp4) while the fix is live: same steps, same seed data and same framing as the before take, so the two halves of F<n>.mp4 read as a pair. F<n>-after.pngis optional.
    4    Revert, never with bare git stash:
. <env.sh>
    5    git diff -- <every file the fix touched, written out> > "$EVIDENCE_ROOT/$PR/F<n>.patch"
    6    git apply -R "$EVIDENCE_ROOT/$PR/F<n>.patch"
    7    git status --short --untracked-files=no          # must be clean

Re-confirm the container is back on the PR head with the step 0 sync check, fed the patch's files (git apply --numstat "$EVIDENCE_ROOT/$PR/F<n>.patch" | cut -f3), before the next finding.
To re-record an after clip later (a take failed, the framing was off), use the saved patch: git apply "$EVIDENCE_ROOT/$PR/F<n>.patch", run the step 0 sync check on every file the patch touches until it prints in sync, record, git apply -R the same patch, check git status --short --untracked-files=no is clean, and run the sync check again.
    8    Return the exact replacement text for the PR-head lines start_line..line on the RIGHT side, plus a one-sentence result.
A fix that fails verification or breaks something adjacent goes back as a finding without a suggestion.
Evidence media
This section is the source of truth for annotated repro clips; demo-video links here rather than repeating it. GitHub shrinks embedded media, so every clip and still points at the problem instead of showing a whole page with a caption.
Keep the take tight. Record each finding as one scripted take (demo-video Mode A) with only the repro steps in it. Sign in during rehearsal; cookies carry across record start, so there is no login on camera. Then remove the dead time: demo-video's cut.sh for takes longer than about 10s, and for shorter ones a plain trim (ffmpeg -ss <start> -to <end> -i raw.webm -c:v libx264 -pix_fmt yuv420p F1-before-raw.mp4), since cut.sh can collapse or crash on short clips. After any click that closes a panel or dropdown, add a wait 1000 before the next step so the close finishes on camera instead of overlapping it. The step labels below need the time each step starts in the trimmed clip; read them off a contact sheet rather than guessing: ffmpeg -i take.mp4 -vf fps=2,scale=640:-2,tile=4x8 -frames:v 1 sheet.png (one cell per 0.5s, left to right; raise the 8 to fit the clip), then read the PNG.
Capture a high-res source, with the UI large.Videos are delivered as Full HD (1920x1080). On agent-browser 0.39.1 the recording follows the viewport times its deviceScaleFactor (DSF), and DSF can be fractional (tested: set viewport 1024 576 3.75 and set viewport 1280 720 3 both recorded 3840x2160). The CSS width decides how big the UI looks: a 1920-wide layout leaves table rows 57px tall in a 1920 export, while 1024 wide gives about 107px, roughly 1.9x. So record at 1024x576 with DSF 3.75:
agent-browser --session "rqs-$PR" set viewport 1024 576 3.75   # a fresh session defaults to 1280x578, so always set it
Check the first frame. If the page clips or reflows at 1024 CSS px (a table losing its last column, a drawer's fields falling below the fold), use set viewport 1280 720 3 instead (1.5x). Never go below 1024 CSS px wide: the Built app switches layouts at its 1000 and Tailwind lg 1024 breakpoints, and at 960 the table clipped its last column. Confirm the first take with ffprobe(width should be 3840). The push-in and any crop come from this 2x source, so a close-up stays sharp, and the final file is scaled down to 1920x1080 Full HD. Stills from the same viewport are 3840x2160 too. CSS zoom (document.documentElement.style.zoom) can still enlarge a small region, but it resets on every navigation and drifted filter dropdowns away from their trigger on PR #8019; size comes from the narrow viewport and sharpness from DSF, not zoom.
Region coordinates.getBoundingClientRect() returns CSS pixels (including any CSS zoom); multiply by the DSF (3.75, or 3 on the fallback) for video and still pixels. The Bash guard refuses eval as a bare word, so the call goes through a wrapper script. Create $EVIDENCE_ROOT/$PR/js.sh once with the Write tool (the guard also refuses some heredocs it can't parse):
#!/bin/bash
# js.sh <session> <file.js>: run the file's JS in the page and print the result
agent-browser --session "$1" eval "$(cat "$2")"
Write the JS to $EVIDENCE_ROOT/$PR/rect.js, also with the Write tool:
(function(){var r=document.querySelector('<selector>').getBoundingClientRect();return [r.x,r.y,r.width,r.height].map(Math.round).join(' ')})()
Then bash "$EVIDENCE_ROOT/$PR/js.sh" "rqs-$PR" "$EVIDENCE_ROOT/$PR/rect.js"prints "x y w h" (tested). The same wrapper runs a DOM .click() or any other page JS. Bash $(( )) is integer-only and DSF 3.75 is not, so convert with awk, which rounds to whole video pixels (tested):
. <env.sh>
DSF=3.75                     # the viewport's deviceScaleFactor; 3 on the 1280x720 fallback
CSS=$(bash "$EVIDENCE_ROOT/$PR/js.sh" "rqs-$PR" "$EVIDENCE_ROOT/$PR/rect.js" | tr -d '"')
read X Y W H <<< "$(echo $CSS | awk -v d=$DSF '{for(i=1;i<=4;i++) printf "%d ", $i*d+0.5}')"
Annotate, animated, about 0.5 to 1s per move. Each step gets its own numbered label, swapped at the step boundary, so the clip reads as the repro list. Each highlighted region gets a box that fades in, an arrow that slides in with ease-out, and both fade out when the region's window ends. On the last region the frame also pushes in, holds, and pulls back at the end. Homebrew ffmpeg has no drawtext filter, so the box, arrow and labels are ImageMagick PNGs overlaid, with fonts given as explicit .ttfpaths (names like Helvetica-Bold fail). This whole chain ran on a 3840x2160 testsrc2dummy clip with two regions, at OW=1920, and the frames were checked. Run it with bash(save it as a script, or bash -c), not zsh: zsh arrays start at 1, so every label would land one step off.
. <env.sh>
cd "$EVIDENCE_ROOT/$PR"
IN=F1-before-raw.mp4; OUT=F1-before.mp4    # the after take: F1-after-raw.mp4 -> F1-after.mp4
S=2                          # overlay size multiplier for a 3840-wide source; DSF only converts coordinates
OW=1920                      # upload width (Full HD); the 3840 source is only for cropping and push-in
STEPS=("Open Reports > Headcount" "Filter to Q3" "Total double-counts the transfer")
AT=(0.3 3.0 5.5)             # when each step starts in the trimmed clip, seconds
FW=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$IN")
FH=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$IN")
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$IN"); FPS=30
# One "X Y W H T0 T1" per highlight, in video pixels (CSS rect times DSF, from the awk step), shown from T0 to T1.
# The push-in lands on the last one, so its T1 is $DUR. A single entry gives the classic clip.
REG=("400 260 900 200 3.0 5.5" "1200 720 640 360 5.5 $DUR")
magick -size $((160*S))x$((100*S)) xc:none -stroke '#E5484D' -strokewidth $((10*S)) -fill none \
  -draw "line $((150*S)),$((10*S)) $((40*S)),$((80*S))" -stroke none -fill '#E5484D' \
  -draw "polygon $((10*S)),$((98*S)) $((66*S)),$((88*S)) $((34*S)),$((58*S))" arrow.png
RIN=(); FC=""; prev="0:v"; k=1
for j in "${!REG[@]}"; do
  read X Y W H T0 T1 <<< "${REG[$j]}"
  magick -size $((W+16*S))x$((H+16*S)) xc:none -fill none -stroke '#E5484D' -strokewidth $((6*S)) \
    -draw "roundrectangle $((3*S)),$((3*S)) $((W+13*S)),$((H+13*S)) $((8*S)),$((8*S))" "box$j.png"
  RIN+=(-loop 1 -i "box$j.png" -loop 1 -i arrow.png)
  FO=$(python3 -c "print(max($T0+0.6, $T1-0.4))")    # fade out over the last 0.4s of the window
  AP="clip((t-$T0-0.3)/0.6,0,1)"
  FC="$FC[$k:v]format=rgba,fade=t=in:st=$T0:d=0.5:alpha=1,fade=t=out:st=$FO:d=0.4:alpha=1[bx$j];"
  FC="$FC[$((k+1)):v]format=rgba,fade=t=out:st=$FO:d=0.4:alpha=1[ar$j];"
  FC="$FC[$prev][bx$j]overlay=x=$((X-8*S)):y=$((Y-8*S)):enable='between(t,$T0,$T1)':shortest=1[b$j];"
  FC="$FC[b$j][ar$j]overlay=x='$((X+W-10*S))+$((220*S))*pow(1-$AP,3)':y='$((Y-96*S))-$((160*S))*pow(1-$AP,3)':enable='between(t,$T0+0.3,$T1)':shortest=1[a$j];"
  prev="a$j"; k=$((k+2))
done
LW=$((960*OW/1920)); LH=$((84*OW/1920)); LP=$((44*OW/1920)); LX=$((26*OW/1920)); LM=$((36*OW/1920))
n=${#STEPS[@]}; LBL_IN=(); LBL="[s]"
for i in $(seq 0 $((n-1))); do
  magick -size ${LW}x${LH} xc:'#0C144B' -fill white -font "/System/Library/Fonts/Supplemental/Arial Bold.ttf" \
    -pointsize $LP -gravity west -annotate +$LX+0 "$((i+1)). ${STEPS[$i]}" "label$i.png"
  LBL_IN+=(-i "label$i.png")
  END=$([ $i -lt $((n-1)) ] && echo "${AT[$((i+1))]}" || echo "$DUR")
  LBL="$LBL[$((k+i)):v]overlay=x=$LM:y=H-h-$LM:enable='between(t,${AT[$i]},$END)'"
  [ $i -lt $((n-1)) ] && LBL="$LBL[l$i];[l$i]"
done
read X Y W H T0 T1 <<< "${REG[$((${#REG[@]}-1))]}"
Z=$(python3 -c "print(round(min($FW/($W+240*$S), $FH/($H+240*$S), 2.5),3))")
CXC=$((X+W/2)); CYC=$((Y+H/2))
ZIN=$(python3 -c "print($T0+0.9)"); ZEND=$(python3 -c "print($DUR-0.7)")
PI="clip((it-$ZIN)/0.8,0,1)"; PO="clip((it-$ZEND)/0.6,0,1)"
ZEXPR="1+($Z-1)*(1-pow(1-$PI,3))*(1-$PO*$PO*(3-2*$PO))"
ffmpeg -y -i "$IN" "${RIN[@]}" "${LBL_IN[@]}" -filter_complex "
$FC
[$prev]zoompan=z='$ZEXPR':x='clip($CXC-iw/zoom/2,0,iw-iw/zoom)':y='clip($CYC-ih/zoom/2,0,ih-ih/zoom)':d=1:s=${FW}x${FH}:fps=$FPS[z];
[z]scale=$OW:-2:flags=lanczos[s];
$LBL
" -c:v libx264 -pix_fmt yuv420p -movflags +faststart -t "$DUR" "$OUT"
S sizes the box stroke, arrow and offsets for the 3840-wide source, so it stays 2 whatever the DSF; DSF only turns CSS coordinates into video pixels. Box and arrow are drawn before zoompan so they zoom with the page; the labels are overlaid after the downscale so they stay put, and their size, font and margins scale with OW so they stay proportional. List the regions in time order without overlapping windows; the push-in only ever targets the last one. Uploads are always 1920x1080 Full HD. Check the file against GitHub's video limit: 100MB on repos owned by a paid-plan org, 10MB on free ones (Attaching files (https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)). builtforteams is on the Team plan (gh api orgs/builtforteams --jq .plan.name), and over 10MB the uploader also has to be an org member, an outside collaborator, or on a paid plan. Check with ls -lh "$OUT". When the region sits near the right or top edge, the arrow lands off frame: mirror the arrow PNG (-flop/-flip) and flip the signs of the +220/-160 slide offsets to match. A last step shorter than about 3s has no room for push-in plus pull-back; drop the zoom and keep box plus arrow. Run the same chain on the after take (IN=F1-after-raw.mp4; OUT=F1-after.mp4) with the same steps and regions, changing only the last label.
One video per finding, before and after in one clip. The upload is F<n>.mp4, built from the two annotated takes in this order, joined with 0.5s crossfades:
    1    Title card naming the finding in plain words ("Pending Approver goes blank after a co-approver approves").
    2    A "BEFORE" card saying what is broken, naming the culprit or the error.
    3    The before take, with its step labels, box and arrow on the culprit.
    4    An "AFTER" card saying what the fix changes ("Suggested fix applied: approver still named").
    5    The after take, with the box and arrow on the corrected spot.
A pill in the top-left corner reads BEFORE (red) or AFTER (green) for the whole of each take, so someone who joins mid-clip knows which half they are watching. It is overlaid on the downscaled take and sized from OW, like the step labels. Cards are 2s each (about 1.5s on screen once the fades overlap), Built navy #0C144B with white text, at the takes' exact size and fps, because xfade needs matching inputs. A finding with no suggestion gets the title card, the BEFORE card and the before take only: leave AFTER empty. Keep the total under about 40s; with three cards, that means takes under about 15s each.
This ran on two 1920x1080 takes scaled down from 3840x2160 testsrc2, with and without an after half, and the frames at each card, mid-take and each crossfade were checked. Run it with bash, not zsh, for the same 0-indexed arrays as the annotate chain:
. <env.sh>
cd "$EVIDENCE_ROOT/$PR"
N=1
TITLE="Pending Approver goes blank after a co-approver approves"
BEFORE="Approve as one co-approver and the other's name disappears"
AFTER="Suggested fix applied: approver still named"   # leave empty for a finding with no suggestion
FONT="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FPS=30; XF=0.5; CARD=2
OW=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "F$N-before.mp4")
OH=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "F$N-before.mp4")
u() { echo $(($1*OW/1920)); }    # size in px at 1920, scaled to the clip width
card() {   # card <out> <line 1> <pointsize 1> <line 2> <pointsize 2>
  magick -size ${OW}x${OH} xc:'#0C144B' \
    \( -size $((OW*8/10))x -background none -fill white -font "$FONT" -pointsize $(u $3) -gravity center caption:"$2" \
       -size $((OW*8/10))x$(u 40) xc:none \
       -size $((OW*8/10))x -background none -fill white -font "$FONT" -pointsize $(u $5) -gravity center caption:"$4" \
       -append \) -gravity center -composite "$1.png"
  ffmpeg -y -v error -loop 1 -t $CARD -r $FPS -i "$1.png" -vf "scale=$OW:$OH,setsar=1,format=yuv420p" -c:v libx264 "$1.mp4"
}
tag() {    # tag <take> <text> <colour>: pinned corner pill on the downscaled take
  magick -background "$3" -fill white -font "$FONT" -pointsize $(u 60) label:"$2" \
    -bordercolor "$3" -border $(u 28)x$(u 14) "$1-tag.png"
  ffmpeg -y -v error -i "$1.mp4" -i "$1-tag.png" -filter_complex \
    "[0:v][1:v]overlay=x=$(u 36):y=$(u 36),fps=$FPS,setsar=1,format=yuv420p" -c:v libx264 "$1-tagged.mp4"
}
card "F$N-title" "$TITLE" 76 "Finding F$N" 44
card "F$N-before-card" "BEFORE" 128 "$BEFORE" 56
tag "F$N-before" BEFORE '#E5484D'
SEG=("F$N-title.mp4" "F$N-before-card.mp4" "F$N-before-tagged.mp4")
if [ -n "$AFTER" ]; then
  card "F$N-after-card" "AFTER" 128 "$AFTER" 56
  tag "F$N-after" AFTER '#12A150'
  SEG+=("F$N-after-card.mp4" "F$N-after-tagged.mp4")
fi
IN=(); FC=""; prev="0:v"; T=0
for s in "${SEG[@]}"; do IN+=(-i "$s"); done
for i in $(seq 1 $((${#SEG[@]}-1))); do
  D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "${SEG[$((i-1))]}")
  T=$(python3 -c "print(round($T+$D-$XF,3))")
  echo "${SEG[$i]} fades in at ${T}s"
  FC="$FC[$prev][$i:v]xfade=transition=fade:duration=$XF:offset=$T[x$i];"; prev="x$i"
done
ffmpeg -y -v error "${IN[@]}" -filter_complex "${FC}[$prev]format=yuv420p[out]" -map "[out]" \
  -c:v libx264 -movflags +faststart "F$N.mp4"
ffprobe -v error -show_entries format=duration -of csv=p=0 "F$N.mp4"    # keep it under about 40s
The script prints when each segment fades in. Verify F<n>.mp4 from those times: one frame inside each card, one mid-take in each half (corner pill visible, right word), and one in the middle of each crossfade. caption: wraps a long title onto a second line on its own; if it needs a third, shorten the title.
Stills (tested), from an agent-browser --session "rqs-$PR" screenshot at the same viewport (3840x2160), with the same video-pixel X Y W H from the awk step, the same S=2 and arrow.png: magick shot.png -fill none -stroke '#E5484D' -strokewidth $((6*S)) -draw "rectangle $X,$Y $((X+W)),$((Y+H))" arrow.png -geometry +$((X+W-20*S))+$((Y-100*S)) -composite -crop $((W+240*S))x$((H+240*S))+$((X-120*S))+$((Y-120*S)) +repage F1-after.png.
Verify every output by extracting frames (ffmpeg -ss <t> -i "$OUT" -frames:v 1 f.png) and reading them: one frame per step with the right label, box on target, arrow tip on the box, text legible at the upload width, no spinner-only stretch.
4. Post
Why media goes through a separate comment, after the submit. Media cannot be attached to a review or a pending review comment through gh or the API (checked 2026-10 on gh 2.103): gh pr review has no --attach (its flags are -a -b -F -c -r), gh api cannot upload, and neither the REST review endpoints nor the GraphQL review mutations take files. Only gh pr comment --attach and gh issue comment --attach upload, and that comment (the vehicle) is public the moment it posts. So the order is: create the review pending with a text note where each video goes (4a), submit it only on the operator's explicit --post(4b), then upload every video once on one vehicle comment and edit each thread's note into its video (4c). In pending mode nothing is uploaded, so nothing public goes out under the operator's account.
One review, one thread per finding. Every finding with a valid diff anchor is an inline thread inside the single review this step creates, with its video in that thread's first comment. The only writes allowed are:
Write
Call
Create the review, pending, with all threads
REST POST /pulls/:n/reviewswith comments[] and no event(4a)
Add one thread to the pending review
GraphQL addPullRequestReviewThread with pullRequestReviewId (4a fallback)
Reply inside an existing thread
GraphQL addPullRequestReviewThreadReplywith pullRequestReviewId and pullRequestReviewThreadId
Remove this run's pending review after a head change, before submit
REST DELETE /pulls/:n/reviews/:id (4b)
Submit
REST POST /pulls/:n/reviews/:id/events(4b, only with an explicit --post)
Upload media, once
gh pr comment --attach (4c)
Put media URLs into this run's thread comments
GraphQL updatePullRequestReviewComment(4c)
Put media URLs into this run's review body
REST PUT /pulls/:n/reviews/:id(4c)
Subscribe the operator
GraphQL updateSubscription (4d)
Never use REST POST /pulls/:n/comments, POST /pulls/:n/comments/:id/replies, gh pr review --comment -b, or the GitHub MCP review and reply tools. Each of those posts outside the pending review: a REST comment or reply is wrapped in its own submitted review, one per call, so findings land as scattered single-comment reviews instead of threads in one review, and the media never reaches them. A finding whose lines are not in a hunk never becomes a file-level comment; it goes in the review body as path:line with a fenced diff.
Video gate. Before creating the pending review, list every confirmed finding and its evidence files. A finding with any UI surface and no F<n>.mp4, or whose F<n>.mp4 has no AFTER half when it carries a suggestion, goes back to step 2 or 3 to be recorded. Screenshots alone never pass. The only exception is a finding with nothing visible in the UI, and its comment says so.
Post once. Every video and still is recorded and checked before the pending review is created. The review goes out in one submit, the media in one upload right after it, and the only later writes are this run's own edits that turn each thread's note into its video. Never upload twice, never post a second evidence comment, and never add evidence or findings the review did not already announce; media that shows up later than the note promised reads as moving the goalposts. If an upload or edit fails after the submit, say so to the user and leave the PR alone.
4.0 Pick the event
Gather three counts. Open blockers: this run's confirmed P1/P2 findings (their suggestions are not applied yet), plus unresolved threads on the PR whose first comment carries a P0/P1/P2 or Blocker tag, read from its heading (after any badge lines, markdown or <img>) or from a line that opens with the tag, or has a line opening with the team's **From Claude Reviewer (<Persona>):** or **HUMAN CHECK From Claude Reviewer prefix. Prose that only mentions a tag does not count: a bold **P3.**heading settles the severity, a team Recommendation counts only when tagged P0 · or P1 ·, and a NIT never does. An unresolved thread whose first comment cannot be read counts too (open-blockers.jq). Changes requested: reviewers other than $MEwhose latest approve, request-changes or dismissal is a request for changes (changes-requested.jq). Human checks: HUMAN_CHECKSfrom step 1. Then let post-mode.sh apply the approve guard, the own-PR rule (GitHub returns 422 for APPROVE or REQUEST_CHANGES on your own PR) and the allow-list. If any command fails, stop before creating or submitting the review; an unavailable count is not zero, and post-mode.sh refuses an empty one:
. <env.sh>
grep -v '^EVENT=' "$EVIDENCE_ROOT/$PR/env.sh" > "$EVIDENCE_ROOT/$PR/env.sh.new" && mv "$EVIDENCE_ROOT/$PR/env.sh.new" "$EVIDENCE_ROOT/$PR/env.sh" || exit 1
rm -f "$EVIDENCE_ROOT/$PR/event.txt"
[ -f "$EVIDENCE_ROOT/$PR/findings.confirmed.jsonl" ] || { echo "STOP: no findings.confirmed.jsonl; step 2 did not finish"; exit 1; }
OURS=$(jq -s '[.[] | select(.p == "P1" or .p == "P2")] | length' "$EVIDENCE_ROOT/$PR/findings.confirmed.jsonl") || exit 1
gh api graphql --paginate -F n="$PR" -f query='query($n: Int!, $endCursor: String) { repository(owner: "builtforteams", name: "built-rails") { pullRequest(number: $n) { reviewThreads(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { isResolved comments(first: 1) { nodes { body } } } } } } }' \
  > "$EVIDENCE_ROOT/$PR/threads.json" || exit 1
THEIRS=$(jq -s -f <skill dir>/open-blockers.jq "$EVIDENCE_ROOT/$PR/threads.json") || exit 1
gh api graphql --paginate -F n="$PR" -f query='query($n: Int!, $endCursor: String) { repository(owner: "builtforteams", name: "built-rails") { pullRequest(number: $n) { reviews(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { state submittedAt author { login } } } } } }' \
  > "$EVIDENCE_ROOT/$PR/reviews.json" || exit 1
CHANGES=$(jq -s --arg me "$ME" -f <skill dir>/changes-requested.jq "$EVIDENCE_ROOT/$PR/reviews.json") || exit 1
OWN=$([ "$AUTHOR" = "$ME" ] && echo yes || echo no)
bash <skill dir>/post-mode.sh event "$POST_MODE" "$ALLOWED_POST" $((OURS+THEIRS)) "$CHANGES" "${HUMAN_CHECKS:-}" "$OWN" > "$EVIDENCE_ROOT/$PR/event.txt" || exit 1
cat "$EVIDENCE_ROOT/$PR/event.txt"
grep '^EVENT=' "$EVIDENCE_ROOT/$PR/event.txt" >> "$EVIDENCE_ROOT/$PR/env.sh"
The block first removes any EVENT line an earlier pass left in env.sh, so a rerun that fails leaves no event behind and 4b refuses to submit. Every NOTE: line it prints (approve downgraded for open blockers, changes requested or HUMAN CHECK items; request-changes downgraded with no P1/P2 or Blocker open; own PR; comment not allowed) goes into the final report verbatim. It never raises a mode, only lowers one.
4a. Create the pending review
Build it with jq -n (hand-written JSON breaks on suggestion blocks). Comment body shape:
🤖 *Not a human. This is Claude, writing the way a person would.*

**P2.** Totals double-count transfers when a position moves mid-period. Verified in the Docker stack: this fixes the total and keeps the period filter and CSV export correct.

<!-- rqs-media:F1.mp4 --> *Before/after video coming right after this review posts.*

```suggestion
<exact replacement for start_line..line>
```

<details><summary>Repro steps</summary>

1. Sign in as `companyadmin@example.com` / `password`, open /reports/headcount.
2. ...

Seeded: one Q3 transfer on company 1 (position 4812).
Specs: `spec/libs/foo_spec.rb` 12/0 in the container.
</details>
Each media note is one line starting with <!-- rqs-media:<file> -->, naming a file in $EVIDENCE_ROOT/$PR/. The HTML comment is invisible on GitHub, so the review reads fine with the text note alone, and 4c replaces the whole line with that file's user-attachments URL (fill-media.sh). The note sits on its own line, right under the finding and outside any <details>, because GitHub renders a bare user-attachments video URL as a player in the thread. The <details> block holds only repro steps, seed notes and specs.
Every comment Claude posts (inline comments, the review body, the 4c evidence comment) opens with the bot line above, verbatim, on its own line. The prose after it follows humanizer: a sentence or two, no em dashes, no other reviewers or bots, nothing about prior threads or resolutions. A finding without a verified fix drops the suggestion block and says what was confirmed; its video has the BEFORE half only. A finding with no UI surface replaces the video line with its runner capture and the line "Nothing in the UI shows this, so the evidence is a runner capture."
Each entry in comments.json: {path, line, side, body}, plus start_line and start_side only for multi-line suggestions. side is RIGHT for added or context lines and LEFT for a deleted line (then line is the base-side line number). Write each body to F<n>.mdfirst, then build the entry from the file so newlines, quotes and backticks survive:
. <env.sh>
jq -n --rawfile body "$EVIDENCE_ROOT/$PR/F1.md" --arg path "<file>" --argjson line <n> --arg side RIGHT \
  '{path: $path, line: $line, side: $side, body: $body}' > "$EVIDENCE_ROOT/$PR/F1.entry.json"
# multi-line: add --argjson start_line <m> and  start_line: $start_line, start_side: $side
# find, not a glob: with no findings a glob fails (zsh) or reaches jq literally (bash); this yields []
find "$EVIDENCE_ROOT/$PR" -maxdepth 1 -name 'F*.entry.json' -exec cat {} + | jq -s . > "$EVIDENCE_ROOT/$PR/comments.json"
jq -e 'type == "array"' "$EVIDENCE_ROOT/$PR/comments.json" >/dev/null || echo "comments.json is not one array"
Suggestion-block rules, or GitHub rejects the comment or applies the wrong thing:
    •    line and start_line are PR-head line numbers on the RIGHT side, and every line in start_line..line sits inside one diff hunk. Lines outside the diff go in the review body with a fenced diff.
    •    start_line < line. A single-line suggestion sends line only, never start_line == line.
    •    The block replaces start_line..lineexactly: same indentation, nothing more or less. An empty block deletes those lines.
    •    One contiguous range per comment. Two separate spots need two comments.
Anchor check. One bad anchor makes GitHub reject the whole review with 422, and an agent that then posts the comments one by one puts them outside the review. Check every entry against the PR's hunks first (tested on PR #8242's patches: in-hunk RIGHT and LEFT lines pass; a line past the hunk, a range across two hunks, start_line == line and a file outside the PR each fail with a reason):
. <env.sh>
gh api "repos/builtforteams/built-rails/pulls/$PR/files" --paginate --jq '.[] | {filename, patch}' | jq -s . > "$EVIDENCE_ROOT/$PR/files.json"
jq -n -r --slurpfile files "$EVIDENCE_ROOT/$PR/files.json" --slurpfile comments "$EVIDENCE_ROOT/$PR/comments.json" \
  -f <skill dir>/check-anchors.jq | tee "$EVIDENCE_ROOT/$PR/anchors.txt"
grep -c '^BAD' "$EVIDENCE_ROOT/$PR/anchors.txt"     # must print 0
Fix every BAD entry (recompute the line from gh pr diff "$PR", or move the finding into the review body) and rerun until it prints 0.
The review body is step 5's summary, written with the Write tool to $EVIDENCE_ROOT/$PR/summary.md (a file, like the comment bodies, so the bot line's newline and emoji survive). With no event, GitHub creates the review as PENDING ("To create a pending review for a pull request, leave the event parameter blank", Create a review (https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request)). comments.json is already one array, so --slurpfile wraps it once and $comments[0] is that array. The review ids get appended to env.sh for 4b and 4c:
. <env.sh>
jq -n --arg commit_id "$HEAD_SHA" --rawfile body "$EVIDENCE_ROOT/$PR/summary.md" \
  --slurpfile comments "$EVIDENCE_ROOT/$PR/comments.json" \
  '{commit_id: $commit_id, body: $body, comments: $comments[0]}' \
  > "$EVIDENCE_ROOT/$PR/review.json"
gh api -X POST "repos/builtforteams/built-rails/pulls/$PR/reviews" \
  --input "$EVIDENCE_ROOT/$PR/review.json" \
  --jq '"REVIEW_ID=\(.id)\nREVIEW_NODE_ID=\(.node_id)\nREVIEW_URL=\(.html_url)\nREVIEW_STATE=\(.state)"' \
  > "$EVIDENCE_ROOT/$PR/review.out" 2> "$EVIDENCE_ROOT/$PR/review.err"
RC=$?
OK=$(grep -cxE 'REVIEW_ID=[0-9]+|REVIEW_NODE_ID=[A-Za-z0-9_-]+|REVIEW_URL=https://github\.com/[^[:space:]]+|REVIEW_STATE=PENDING' "$EVIDENCE_ROOT/$PR/review.out")
if [ "$RC" -ne 0 ] || [ "$OK" != 4 ] || [ "$(wc -l < "$EVIDENCE_ROOT/$PR/review.out" | tr -d ' ')" != 4 ]; then
  echo "STOP: review not created (gh exit $RC); env.sh untouched"; cat "$EVIDENCE_ROOT/$PR/review.out" "$EVIDENCE_ROOT/$PR/review.err"; exit 1
fi
[ -z "$(tail -c 1 "$EVIDENCE_ROOT/$PR/env.sh")" ] || echo >> "$EVIDENCE_ROOT/$PR/env.sh"
cat "$EVIDENCE_ROOT/$PR/review.out" >> "$EVIDENCE_ROOT/$PR/env.sh"
tail -4 "$EVIDENCE_ROOT/$PR/env.sh"
Only validated KEY=value lines ever reach env.sh. On a failure GitHub's error body lands in review.out, never in env.sh, where it would glue itself to the next line and corrupt the file. Before the fallback, check with the PR's reviews list that no review from $ME was created after all; if one was, use its ids rather than creating a second.
On a 422 with a clean anchor check, do not fall back to separate comments. Create the review empty (the same jq -n without comments, posted and validated with the same block), then add each finding as a thread in it, one call per entry, so the one GitHub rejects names itself and the rest still land inside the review:
. <env.sh>
gh api graphql -F rid="$REVIEW_NODE_ID" -f path="<file>" -F line=<n> -f side=RIGHT -F body=@"$EVIDENCE_ROOT/$PR/F1.md" \
  -f query='mutation($rid: ID!, $path: String!, $line: Int!, $side: DiffSide!, $body: String!) { addPullRequestReviewThread(input: {pullRequestReviewId: $rid, path: $path, line: $line, side: $side, body: $body}) { thread { id comments(first: 1) { nodes { id } } } } }'
# multi-line: add -F start=<m> -f sside=RIGHT, declare $start: Int!, $sside: DiffSide!, and pass startLine: $start, startSide: $sside
Input fields checked by schema introspection: AddPullRequestReviewThreadInput takes pullRequestReviewId, path, line, side, startLine, startSide, subjectType and body (required). A reply to an existing thread uses addPullRequestReviewThreadReply(input: {pullRequestReviewId: $rid, pullRequestReviewThreadId: $tid, body: $body}) { comment { id } }, so it too stays in the pending review.
Go straight on to 4b. Until 4c runs, each thread shows only its text note, so never submit from GitHub's UI while the run is still going.
4b. Submit, or leave it pending
Run the Head check immediately before submission. If the head moved, delete this run's pending review (gh api -X DELETE "repos/builtforteams/built-rails/pulls/$PR/reviews/$REVIEW_ID"; nothing has been uploaded yet, so nothing public is lost), follow the head-check steps, and redo 4a against the new head. Head moved or not, rerun 4.0 now to refresh the counts and EVENT; another reviewer may have added a blocker or requested changes since. A failed check leaves the review pending.
    •    EVENT=PENDING: the operator did not pass a submitting --post, or 4.0 lowered it to pending. Do not submit, do not upload, and do not subscribe: skip 4c and 4d, so nothing goes out under the operator's account. Report the pending review URL, list the local videos ($EVIDENCE_ROOT/$PR/F<n>.mp4), and print the submit command with every value written out, e.g. gh api -X POST repos/builtforteams/built-rails/pulls/8134/reviews/3311234567/events -f event=COMMENT. Tell the operator the threads carry a text note where each video goes; after they submit, they can rerun with --resume-upload to upload the videos and fill them in, or attach them by hand.
    •    Any other event: submit right away (Submit a review (https://docs.github.com/en/rest/pulls/reviews#submit-a-review-for-a-pull-request)), then go on to 4c and 4d. The block refuses when the verdict line in summary.md contradicts the event; fix the line per step 5, update the pending body with gh api -X PUT "repos/builtforteams/built-rails/pulls/$PR/reviews/$REVIEW_ID" -F body=@"$EVIDENCE_ROOT/$PR/summary.md", and rerun:
. <env.sh>
    •    case "${EVENT:-}" in COMMENT|APPROVE|REQUEST_CHANGES) ;; *) echo "STOP: no submitting EVENT in env.sh; rerun 4.0"; exit 1 ;; esac
    •    V=$(grep -m1 '^# Verdict:' "$EVIDENCE_ROOT/$PR/summary.md")
    •    case "$EVENT:$V" in
    •      APPROVE:*Approve|REQUEST_CHANGES:*"Request changes"|COMMENT:*) ;;
    •      *) echo "STOP: verdict '${V:-none}' contradicts EVENT=$EVENT"; exit 1 ;;
    •    esac
    •    gh api -X POST "repos/builtforteams/built-rails/pulls/$PR/reviews/$REVIEW_ID/events" \
    •      -f event="$EVENT" --jq '{id, state, html_url}'

If the submit fails or is refused (a classifier refusal, anything else), do not retry another way and skip 4c. Say the review is still pending and nothing was uploaded, and print the one command that submits it, in full, with the PR number, review id and event written out, never as variables: gh api -X POST repos/builtforteams/built-rails/pulls/<PR>/reviews/<REVIEW_ID>/events -f event=<EVENT>. Post nothing else.
4c. Upload and fill in, after the submit
Runs only once the review is submitted: by 4b in this run, or by the operator, who then asks for this step. It uploads exactly once.
Resuming at 4c only. When the operator submitted a pending review themselves and asks for the videos, or a 4c run stopped part way, they pass --resume-upload, which enters here through the check at the top of step 0 and never runs the rest of it. Step 0 rewrites env.shand clears the run folder, which would drop REVIEW_ID, REVIEW_NODE_ID and the upload marker below, and with them the only guard against a second upload.
Run the Head check once. If the head moved after the submit, do not rebuild the review or re-upload; carry on, and put one line in the final report saying the review covers HEAD_SHA and the PR has moved on to NOW.
    1    Upload the media with one PR comment and pair each file with its URL. Run it from inside the repo checkout; from ~/Desktopit fails with "not a git repository". Every confirmed UI finding attaches its one F<n>.mp4, plus any still it cites. List the same files, in the same order, in FILES and in the --attach flags. The block refuses while the review is still pending, and writes the evidence-uploading marker before the upload, so a run that dies mid-upload can never upload again:
. <env.sh>
    2    D="$EVIDENCE_ROOT/$PR"
    3    [ -n "${REVIEW_ID:-}" ] || { echo "STOP: no REVIEW_ID in env.sh"; exit 1; }
    4    STATE=$(gh api "repos/builtforteams/built-rails/pulls/$PR/reviews/$REVIEW_ID" --jq .state) || exit 1
    5    case "$STATE" in ''|PENDING) echo "STOP: review $REVIEW_ID is '${STATE:-unknown}', not submitted; nothing uploaded"; exit 1 ;; esac
    6    ( set -o noclobber; date -u +%Y-%m-%dT%H:%M:%SZ > "$D/evidence-uploading" ) 2>/dev/null || { echo "STOP: an upload already started at $(cat "$D/evidence-uploading")"; exit 1; }
    7    FILES=(F1.mp4 F1-after.png)
    8    printf '🤖 *Not a human. This is Claude, writing the way a person would.*\n\nEvidence uploads for the review comments on this PR.\n' > "$EVIDENCE_ROOT/$PR/evidence.md"
    9    URL=$(gh pr comment "$PR" --body-file "$EVIDENCE_ROOT/$PR/evidence.md" \
    10      --attach "$EVIDENCE_ROOT/$PR/F1.mp4" \
    11      --attach "$EVIDENCE_ROOT/$PR/F1-after.png#F1, totals after the fix") || exit 1
    12    echo "$URL" > "$EVIDENCE_ROOT/$PR/evidence-url.txt"
    13    gh api "repos/builtforteams/built-rails/issues/comments/${URL##*issuecomment-}" --jq .body \
    14      | grep -oE 'https://github\.com/user-attachments/(assets|files)/[^ )\"]+' > "$EVIDENCE_ROOT/$PR/urls.raw" || exit 1
    15    [ "$(wc -l < "$EVIDENCE_ROOT/$PR/urls.raw" | tr -d ' ')" = "${#FILES[@]}" ] || { echo "STOP: ${#FILES[@]} files, $(wc -l < "$EVIDENCE_ROOT/$PR/urls.raw") URLs"; exit 1; }
    16    paste -d ' ' <(printf '%s\n' "${FILES[@]}") "$EVIDENCE_ROOT/$PR/urls.raw" > "$EVIDENCE_ROOT/$PR/urls.txt"
    17    cat "$EVIDENCE_ROOT/$PR/urls.txt"

The files land on github.com/user-attachments. GitHub's Attaching files (https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)page: "In the case of private and internal repositories, only people with access to the repository can view the uploaded files." built-rails is private. #alt is images only; a video with #alt fails outright, so .mp4paths go bare. --attach takes images and video only, never .txt or .log; quote runner output inline instead. Captions describe what the frame shows, not a verdict. Up to 50 files per command. One URL must come back per file, in --attachorder; never cite an attachment whose URL is missing.
After a STOP here, never upload again.The marker stays, and only the operator removes it.
    ◦    Marker plus a complete urls.txt: skip to step 2 (edits only).
    ◦    Marker but no evidence-url.txt: the upload may or may not have landed. Look for the bot's evidence comment on the PR (gh pr view "$PR" --comments). If it is there, save its URL to evidence-url.txt and re-derive urls.txt as below; if not, tell the operator and stop.
    ◦    Count mismatch: re-derive urls.txtfrom the comment in evidence-url.txt. Read its body (gh api "repos/builtforteams/built-rails/issues/comments/<id from the URL>" --jq .body), match each user-attachments URL to its file by order and alt text, and write one <file> <url> line per file that did upload. A file with no URL keeps its note; step 2 refuses that comment, and the report names it.
    18    Turn each note into its media. fill-media.sh replaces every <!-- rqs-media:<file> --> line with that file's URL and refuses, printing nothing, when a file has no URL. Edit each of this run's comments that holds a note, then the review body if it holds one:
. <env.sh>
    19    D="$EVIDENCE_ROOT/$PR"
    20    gh api graphql --paginate -F id="$REVIEW_NODE_ID" -f query='query($id: ID!, $endCursor: String) { node(id: $id) { ... on PullRequestReview { state body comments(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { id body } } } } }' > "$D/posted.pages.json" || exit 1
    21    jq -s -f <skill dir>/review-pages.jq "$D/posted.pages.json" > "$D/posted.json" || exit 1
    22    for id in $(jq -r '.data.node.comments.nodes[] | select(.body | contains("<!-- rqs-media:")) | .id' "$D/posted.json"); do
    23      jq -j --arg id "$id" '.data.node.comments.nodes[] | select(.id == $id) | .body' "$D/posted.json" > "$D/media-$id.md"
    24      bash <skill dir>/fill-media.sh "$D/media-$id.md" "$D/urls.txt" > "$D/media-$id.final.md" || { echo "STOP: $id"; exit 1; }
    25      gh api graphql -F id="$id" -F body=@"$D/media-$id.final.md" \
    26        -f query='mutation($id: ID!, $body: String!) { updatePullRequestReviewComment(input: {pullRequestReviewCommentId: $id, body: $body}) { pullRequestReviewComment { id } } }' >/dev/null || exit 1
    27    done
    28    if jq -e '.data.node.body | contains("<!-- rqs-media:")' "$D/posted.json" >/dev/null; then
    29      jq -j '.data.node.body' "$D/posted.json" > "$D/summary.posted.md"
    30      bash <skill dir>/fill-media.sh "$D/summary.posted.md" "$D/urls.txt" > "$D/summary.final.md" || exit 1
    31      gh api -X PUT "repos/builtforteams/built-rails/pulls/$PR/reviews/$REVIEW_ID" -F body=@"$D/summary.final.md" --jq .state || exit 1
    32    fi

    33    Check the result. It prints true only when no note is left and every uploaded URL sits in a thread comment or the review body; a URL that only lives in the vehicle comment does not count:
. <env.sh>
    34    D="$EVIDENCE_ROOT/$PR"
    35    gh api graphql --paginate -F id="$REVIEW_NODE_ID" -f query='query($id: ID!, $endCursor: String) { node(id: $id) { ... on PullRequestReview { state body comments(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { id body } } } } }' > "$D/posted.pages.json" || exit 1
    36    jq -s -f <skill dir>/review-pages.jq "$D/posted.pages.json" > "$D/posted.json" || exit 1
    37    jq -e --rawfile urls "$D/urls.txt" -f <skill dir>/media-filled.jq "$D/posted.json"

If the upload worked but an edit failed, retry only the edits, never the upload. If they still fail, tell the operator which comments still show the note, and post nothing else.
4d. Subscribe
Runs only after 4b submitted the review (or on --resume-upload, after 4c). It is a write under the operator's account, so a pending run skips it. Subscribe the operator to the PR so later pushes and replies reach them. This is separate from the poem list in step 5. updateSubscription takes the PR's node id (PR_NODE_ID from step 0) and state: SUBSCRIBED (checked against the schema: UpdateSubscriptionInput is subscribableId: ID!, state: SubscriptionState!); the result must print SUBSCRIBED:
. <env.sh>
gh api graphql -F id="$PR_NODE_ID" \
  -f query='mutation($id: ID!) { updateSubscription(input: {subscribableId: $id, state: SUBSCRIBED}) { subscribable { viewerSubscription } } }' \
  --jq .data.updateSubscription.subscribable.viewerSubscription
A failed subscribe changes nothing public; just report it.
5. Summary and verdict
body (summary.md in 4a) is the bot line from 4a, then an H1 verdict, then one humanizer line. Any confirmed finding without a valid diff anchor follows as path:line, its explanation, its <!-- rqs-media:<file> --> note line and fenced diff when a fix was verified. The optional poem toggle comes last. No qa-pr verdict block, no counts, no checklist. The verdict is exactly one of these, picked after 4.0 from the final EVENT first and the findings second:
EVENT / findings
Verdict line
EVENT=REQUEST_CHANGES
# Verdict: ❌ Request changes
EVENT=APPROVE
# Verdict: ✅ Approve
otherwise, any P1 or P2
# Verdict: ❌ Request changes
otherwise, only P3/P4, or none
# Verdict: ✅ Approve
otherwise, worth discussing but not blocking, or unsure
# Verdict: 💬 Comment
The verdict is a recommendation in text and never sets the event; 4.0 does. post-mode.shlowers request-changes to comment when no P1/P2 or Blocker is open, so a PR with only P3 findings never gets a REQUEST_CHANGES event under an Approve verdict, and 4b refuses to submit when the line contradicts the event.
🤖 *Not a human. This is Claude, writing the way a person would.*

# Verdict: ❌ Request changes

A couple of things worth fixing, suggestions inline.
Another summary line: "Looks good, only P3/P4 nits."
Poem toggle, opt-in. Operators keep a local list at ~/.config/review-qa-suggest/poem-subscribers.txt (same pattern as ~/.config/qa-pr/config): one GitHub login per line, # comments allowed. When that file exists and lists the PR author's login, the body ends with a collapsed toggle; no file or no match means no toggle:
<details><summary>For the subscribers</summary>

*Posted from @<operator login>'s GitHub account by Claude.*

<a short original piece about this PR or its findings>
</details>
. <env.sh>
LIST=~/.config/review-qa-suggest/poem-subscribers.txt
[ -f "$LIST" ] && sed 's/#.*//' "$LIST" | tr -d ' \t' | grep -qixF "$AUTHOR" && echo "poem: yes" || echo "poem: no"
cat "$EVIDENCE_ROOT/last-poem-form" 2>/dev/null || echo "none yet"
Rotate the form haiku, then a few rap bars, then an original stoic one-liner in the spirit of Marcus Aurelius or Seneca (never a real quote), then back to haiku. Take the form after the one in $EVIDENCE_ROOT/last-poem-form (haiku when the file is missing), write fresh text every run, and after the review is created save the form used with echo rap > "$EVIDENCE_ROOT/last-poem-form" (or haiku / stoic). Keep it kind and workplace-safe, and never mock the author.
Report to the user in a few sentences once step 4 is done: the review URL and whether it is pending or submitted (and as what), every NOTE: line from 4.0, the engine used, the submit command and local video paths when the review is pending, the evidence comment URL and the 4c check result when it was submitted, a head that moved after the submit, and, for trusted-review, its needs-your-eyes items. When those held an approval at comment, say the dev can approve once they have checked them.
Gotchas
    •    Never run rspec or rails on the host from a worktree: the copied .envDATABASE_URL points at host built_development and DatabaseCleaner wipes it. Specs and runners go through docker compose exec.
    •    App container can't reach MySQL (unable to connect to /tmp/mysql.sock): host DATABASE_URL from .env. Use a worktree compose.override.yml setting DATABASE_URL: trilogy://root:root@db:3306/built_development for app, setup and sidekiq. The file isn't gitignored, so when you create it, add it to the exclude file. In a worktree that file lives in the shared git dir, not the worktree's own: git rev-parse --path-format=absolute --git-common-dirprints it (e.g. /Users/<you>/Developer/built-rails/.git), then grep -qx compose.override.yml <that>/info/exclude || echo compose.override.yml >> <that>/info/exclude with the printed path written out.
    •    mysqldump: Can't create/write to file '/app/db/structure.sql' or /webpack/* read timeouts: watch wrote /app as uid 502. Fix with docker compose exec -u root app chown -R 1000:1000 /app.
    •    A manual source_init resync deletes public/uploads and webpack/v2/i18n-manifest.json. Before one, add a public/uploads exclude to the resync, and regenerate the manifest afterwards.
    •    Host port 3000 already taken by another stack: BUILT_WEB_PORT=<free port> docker compose up -d app sidekiq web.
    •    Container rspec picks up .env's DATABASE_URL even under RAILS_ENV=test, so it hits the dev database. Point it at a test database on the compose db service instead. A fresh stack only has built_development, so prepare the test database once with the same -eflags and bundle exec rails db:create db:environment:set db:test:prepare, then run specs: docker compose exec -e RAILS_ENV=test -e TEST_ENV_NUMBER=19 -e DATABASE_URL=trilogy://root:root@db:3306/built_test19 -e DATABASE_CLEANER_ALLOW_REMOTE_DATABASE_URL=true --user ubuntu app bundle exec rspec <paths>.
    •    Cookies carry across agent-browser record start, so sign in once during rehearsal; no re-login on camera. record start records the page already open, with no new context.
    •    A fresh agent-browser session's viewport is 1280x578. Always set viewport 1024 576 3.75 (or the 1280 720 3 fallback when the page clips at 1024) before recording or taking stills. Never go below 1024 CSS px wide, where the app's breakpoints switch layouts.
    •    record start needs an extension on the output path (.webm or .mp4); an extensionless path is rejected. agent-browser doctor checks the ffmpeg dependency.
    •    On 0.39.1 a mutating command whose daemon response was lost returns outcome_unknown instead of retrying. Check the page state (snapshot or a DOM read) before repeating a click, or it may fire twice.
    •    A native agent-browser click sometimes does not register. A DOM .click()through a small JS wrapper does. Scroll the target into view first so the click lands on camera.
    •    Bash permission guards (the auto-mode classifier, worktree guards) refuse some commands. Two refusals are known false positives, and only those two go through a small wrapper script under the evidence folder, called by absolute path: eval as a bare word (agent-browser ... eval "<js>", via js.sh in Evidence media) and Go-template {{...}} arguments (gh --template). Write everything else so it doesn't trip a guard in the first place: git as plain, separate commands, absolute paths instead of cd X && <cmd>, program names and flags written out instead of taken from a variable, files written with the Write tool instead of heredocs. Any other refusal gets reported to the user, never wrapped or worked around. A refused review submit is the case 4b covers: print the command, never route around it.
    •    GitHub review writes go through gh apionly, with the calls in step 4's table. The GitHub MCP review and reply tools, REST /pulls/:n/comments and gh pr reviewall post outside the pending review.
    •    One pending review per user per PR. The trusted-review engine must skip its own posting step, and an existing pending review from $ME stops the run in step 0.
    •    Never bare git stash; the stash stack is shared across worktrees.
    •    Never commit or push evidence to any branch of any repo. It lives in $EVIDENCE_ROOT/$PR/ and reaches GitHub only through --attach.
    •    Never name a zsh loop variable path; it is tied to $PATH.
    •    No emojis in posted text except the 🤖 that opens the bot line and the ✅ / 💬 / ❌ in the verdict heading.