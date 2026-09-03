#!/usr/bin/env bash
# Decides whether a push to main is worth a Vercel deployment.
#
# ═══════════════════════════════════════════════════════════════════════════
# WHY THIS EXISTS
#
# The archiver commits every ~5 minutes and marks the pure-data ones with
# [skip ci], on the understanding that Vercel honours it. MEASURED 2026-08-26:
# it does not. Deployments per hour that day ran 8, 10, 11, 12, 13 — one per
# archive commit — against a Hobby ceiling of 100 a day. The ceiling was hit
# and Vercel began refusing every deployment with "Deployment rate limited —
# retry in 24 hours", which is why perfectly good pushes stopped appearing.
#
# `ignoreCommand` is the supported, deterministic version of the same idea.
#
#   exit 0  → skip this build
#   exit 1  → build it
#
# ═══════════════════════════════════════════════════════════════════════════
# AND WHY IT CHANGED — A REAL CHANGE CAN BE BURIED BY DATA COMMITS
#
# MEASURED 2026-09-03. The deals page redesign landed and never deployed:
#
#     18:40:42  build   68e2fdc94   <- last build
#     18:41:24  commit  40353a95e   <- the redesign
#     18:43:20  commit  bbf684790   archive [skip ci]
#     18:48:26  commit  c348335bc   archive [skip ci]
#
# The old rule read one thing: the message of the NEWEST commit. Vercel had
# not yet processed the redesign when the archiver pushed two minutes later,
# so every push it saw afterwards said "skip" — and the change sat on main,
# correct and deployed nowhere, until the next hourly publish commit happened
# to carry it. Zero deployments were ever created for that SHA.
#
# For anybody iterating on the site that is a miserable property: push, wait
# up to an hour, or ask somebody to nudge it.
#
# THE RULE NOW: a [skip ci] commit still skips, EXCEPT when it is the first
# one to land on top of a real change. Then it builds, because that is the
# case where the real change may never have been seen.
#
# The asymmetry is deliberate. Building when we did not need to costs one
# deployment out of a hundred. NOT building when we should costs a change that
# silently never ships, and the only way anyone finds out is by staring at an
# unchanged page wondering what they did wrong. When those two are the choices
# and the evidence is ambiguous, build.
#
# The cost is bounded to ONE extra deployment per real change: only the FIRST
# data commit after it rescues it. The second and every one after skip as
# before, so a quiet afternoon of archiving still costs nothing.
# ═══════════════════════════════════════════════════════════════════════════

set -u
msg="${VERCEL_GIT_COMMIT_MESSAGE:-}"

# No message means no evidence. Build, rather than silently skipping a real
# change because an environment variable was missing.
[ -z "$msg" ] && exit 1

case "$msg" in
  *"[skip ci]"*) ;;
  *) exit 1 ;;                      # a real commit — always build
esac

# ── HEAD is a data commit. Is it burying something? ───────────────────────
# Only the first one after a real change gets to rescue it, so the parent
# must itself be a real commit. Anything deeper and we assume the change has
# had its chance.
parent_msg="$(git log -1 --format=%s HEAD~1 2>/dev/null)" || exit 0
case "$parent_msg" in
  *"[skip ci]"*) exit 0 ;;          # a run of data commits — nothing to rescue
esac

# What did that real commit actually touch? A commit that only moved data is
# not worth a deployment however it was worded.
changed="$(git diff --name-only HEAD~2 HEAD~1 2>/dev/null)" || exit 1
[ -z "$changed" ] && exit 0         # an empty commit changes nothing to serve

while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    web/data/*) ;;                  # archive payload, not the site
    *) exit 1 ;;                    # anything else is a real change: BUILD
  esac
done <<< "$changed"

exit 0
