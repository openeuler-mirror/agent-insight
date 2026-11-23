# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# This component is licensed under MulanPSL-2.0.
# See LICENSE in this directory for the full license text.

$ErrorActionPreference = "Stop"
$Builder = Join-Path $PSScriptRoot "build-vsix.mjs"
& node $Builder @args
if ($LASTEXITCODE -ne 0) { throw "VSIX packaging failed." }
