#!/usr/bin/env bash
set -euo pipefail

OUTPUT_DIR="${1:-./artifacts/nupkg}"
mkdir -p "$OUTPUT_DIR"

dotnet restore UniversalReport.sln
dotnet build UniversalReport.sln -c Release --no-restore
dotnet test tests/UniversalReport.UnitTests/UniversalReport.UnitTests.csproj -c Release --no-build
dotnet pack UniversalReport.sln -c Release --no-build -o "$OUTPUT_DIR"

echo "NuGet packages generated in $OUTPUT_DIR:"
ls -lh "$OUTPUT_DIR"
