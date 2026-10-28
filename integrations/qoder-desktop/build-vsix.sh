#!/usr/bin/env sh
# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# This component is licensed under MulanPSL-2.0.
# See LICENSE in this directory for the full license text.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/build-vsix.mjs" "$@"
