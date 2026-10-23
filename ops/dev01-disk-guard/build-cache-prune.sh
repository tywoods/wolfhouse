#!/bin/sh
set -eu
# Build cache only. Deliberately excludes images, volumes and system-wide prune.
docker buildx prune --builder zeroazure-builder --keep-storage 2gb -f
docker buildx prune --builder default --keep-storage 2gb -f
