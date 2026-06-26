#!/usr/bin/env bash
# Cursor "stop" hook — ralph-style goal continuation.
#
# When an agent stops, this hook checks whether a goal is set for the current
# project/working directory and, if so, asks the agent to keep working toward
# it using `projects next` suggestions. Modeled on the codewith `/goal` slash
# command (set/view a long-running goal) but driven as a Cursor stop hook.
#
# Goal sources (first one wins):
#   1. ./.hasna/goal.md            (project-local, checked into the repo)
#   2. $HASNA_GOAL_FILE            (explicit override)
#   3. ~/.hasna/goal.md            (user-global goal)
#
# Output: Cursor stop-hook JSON. When a goal is active and incomplete we block
# the stop with a `reason` that nudges the agent to continue; otherwise we allow
# the stop. `stop_hook_active=true` guards against infinite continuation loops.
#
# Env:
#   HASNA_GOAL_SKIP=1              disable the hook entirely
#   HASNA_GOAL_CONTINUE=0          disable continuation nudge (still emits status)
#   HASNA_GOAL_MAX_SUGGESTIONS=N   cap suggestion count (default 4)

set -euo pipefail

if [[ "${HASNA_GOAL_SKIP:-0}" == "1" ]]; then
  printf '{"decision": "allow"}\n'
  exit 0
fi

input="$(cat)"

# jq is required; fail open (allow stop) if unavailable so a missing
# dependency never breaks the agent.
if ! command -v jq >/dev/null 2>&1; then
  printf '{"decision": "allow"}\n'
  exit 0
fi

cwd="$(printf '%s' "$input" | jq -r '.cwd // empty')"
stop_active="$(printf '%s' "$input" | jq -r '.stop_hook_active // false')"

# Avoid infinite stop-loop: if Cursor already re-invoked us because a prior
# stop hook blocked the stop, allow it this time.
if [[ "$stop_active" == "true" ]]; then
  printf '{"decision": "allow"}\n'
  exit 0
fi

# Resolve the goal text.
goal_file=""
if [[ -n "${cwd}" && -f "${cwd}/.hasna/goal.md" ]]; then
  goal_file="${cwd}/.hasna/goal.md"
elif [[ -n "${HASNA_GOAL_FILE:-}" && -f "${HASNA_GOAL_FILE}" ]]; then
  goal_file="${HASNA_GOAL_FILE}"
elif [[ -f "${HOME}/.hasna/goal.md" ]]; then
  goal_file="${HOME}/.hasna/goal.md"
fi

goal_text=""
if [[ -n "$goal_file" ]]; then
  goal_text="$(sed 's/[[:space:]]*$//' "$goal_file" | tr '\n' ' ' | sed 's/  */ /g')"
fi

# No goal set -> nothing to continue toward. Allow stop.
if [[ -z "$goal_text" ]]; then
  printf '{"decision": "allow"}\n'
  exit 0
fi

# Ask the projects CLI for next-action suggestions scoped to this cwd.
suggestions=""
if command -v projects >/dev/null 2>&1; then
  max="${HASNA_GOAL_MAX_SUGGESTIONS:-4}"
  # `projects next` is the agent-assist command added in this package.
  # It resolves the current project from cwd and derives next actions.
  suggestions="$(projects next --cwd "${cwd}" --json --limit "$max" 2>/dev/null || true)"
fi

# If the goal file contains a completion marker line, treat the goal as done.
done_marker=0
if [[ -f "$goal_file" ]]; then
  if grep -qi '^<!-- done -->' "$goal_file" 2>/dev/null; then
    done_marker=1
  fi
fi

if [[ "${HASNA_GOAL_CONTINUE:-1}" == "0" || "$done_marker" == "1" ]]; then
  # Surface status to the user but do not force another turn.
  if [[ "$done_marker" == "1" ]]; then
    msg="Goal marked complete (<!-- done --> in $goal_file). No continuation."
  else
    msg="Goal active but continuation disabled (HASNA_GOAL_CONTINUE=0)."
  fi
  printf '{"decision": "allow", "systemMessage": %s}\n' \
    "$(printf '%s' "$msg" | jq -Rs .)"
  exit 0
fi

# Build a compact continuation prompt. Keep it small to respect token budgets.
{
  printf 'You stopped, but a goal is still active for this project.\n'
  printf '\nGoal: %s\n' "$goal_text"
  if [[ -n "$suggestions" ]]; then
    printf '\nSuggested next actions (from `projects next`):\n'
    printf '%s\n' "$suggestions"
  else
    printf '\nNo `projects next` suggestions available. Re-read the goal, pick the next concrete step toward it, and continue.\n'
  fi
  printf '\nIf the goal is genuinely complete, write `<!-- done -->` on its own line in %s and stop.\n' "$goal_file"
  printf 'Do not repeat work already finished. Pick the highest-leverage unfinished step and proceed.\n'
} | {
  sys_msg="$(jq -Rs .)"
  printf '{"decision": "block", "reason": %s}\n' "$sys_msg"
  exit 0
}
