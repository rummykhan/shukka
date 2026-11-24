# The image `shukka diff` and `shukka deploy` run a project's own code in (npm ci, cdk synth, checks, build, bundle,
# smoke). Built locally by the CLI and tagged shukka-project:<first 16 hex of this file's SHA-256>, so it is rebuilt
# only when this file changes. The base is node:22 (Debian bookworm) pinned by its multi-platform index digest; the
# CLI builds and runs it for linux/amd64. It holds what node:22 brings (Node 22, npm, npx, bash, git, curl, python3,
# make, gcc, g++) and jq, curl, git and ca-certificates installed here.
FROM node:22@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb
RUN apt-get update \
  && apt-get install -y --no-install-recommends jq curl git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
