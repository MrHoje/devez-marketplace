#!/usr/bin/env pwsh
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $ForwardedArgs
)

& node (Join-Path $PSScriptRoot '..\scripts\hoje-runtime.js') @ForwardedArgs
exit $LASTEXITCODE
