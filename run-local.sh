#!/usr/bin/env bash
set -eu

if ! command -v dotnet >/dev/null 2>&1; then
  echo 'Install the .NET 10 SDK first: https://dotnet.microsoft.com/download/dotnet/10.0' >&2
  exit 1
fi

if ! dotnet --list-sdks | grep -qE '^10\.'; then
  echo 'The .NET 10 SDK is required: https://dotnet.microsoft.com/download/dotnet/10.0' >&2
  exit 1
fi

if [ -z "${YouTube__ApiKey:-}" ]; then
  read -r -s -p 'Paste your YouTube Data API key (input is hidden): ' YouTube__ApiKey
  echo
  export YouTube__ApiKey
fi

if [ -z "${YouTube__ApiKey:-}" ]; then
  echo 'No API key was entered. Run the script again and paste your YouTube Data API key.' >&2
  exit 1
fi

dotnet run --launch-profile http
