#!/usr/bin/env bash
# Planted by apps/web/build.sh at box/configure.sh inside the web bundle, standing in for a
# compromised build dependency. shukka-release.sh must never execute a hook from the bundle; if this
# ever runs it leaves /var/tmp/shukkatest-planted-hook-ran, which the acceptance suite looks for.
date -u +%FT%TZ >>/var/tmp/shukkatest-planted-hook-ran
exit 0
