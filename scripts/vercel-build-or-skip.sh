#!/usr/bin/env bash
# Decides whether a push to main is worth a Vercel deployment.
#
# WHY THIS EXISTS
#
# The archiver commits every ~5 minutes and marks the ones that are pure data
# with [skip ci], on the understanding that Vercel honours it. Measured
# 2026-08-26: it does not. Deployments per hour that day ran 8, 10, 11, 12, 13
# — one per archive commit — against a Hobby plan ceiling of 100 a day. The
# ceiling was hit and Vercel began refusing every deployment with "Deployment
# rate limited — retry in 24 hours", which is why perfectly good pushes stopped
# appearing on the site.
#
# `ignoreCommand` is the supported, deterministic version of the same idea, and
# it runs here rather than inside Vercel's own heuristics.
#
#   exit 0  → skip this build
#   exit 1  → build it
#
# Data still reaches the site without a deployment: /api/profile and
# /api/recent read the archive straight from the repository, so the numbers on
# a card are current within a commit. The deployed copy under /data is a
# fallback, and the archiver's hourly "publish" commit refreshes it.
msg="${VERCEL_GIT_COMMIT_MESSAGE:-}"

# No message means no evidence. Build, rather than silently skipping a real
# change because an environment variable was missing.
[ -z "$msg" ] && exit 1

case "$msg" in
  *"[skip ci]"*) exit 0 ;;
esac
exit 1
