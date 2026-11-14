# UniversalReport.NET

Cross-platform RDLC-like reporting SDK for **.NET 8, .NET 9, and .NET 10** on Windows, Linux, and Docker without `System.Drawing.Common` or Windows-only `ReportViewer` dependencies.

## Install from NuGet

Install the all-in-one SDK package in any .NET Core project (Console, Worker, Blazor, ASP.NET Core, Desktop):

```bash
dotnet add package UniversalReport
```

Or install modular packages independently:

- `UniversalReport.Core` — Models, contracts, `Report` SDK
- `UniversalReport.Definitions` — `.ureport` v1.0 JSON schema validation
- `UniversalReport.Expressions` — Sandboxed AST expression compiler & evaluator
- `UniversalReport.Data` — Universal adapters for C# objects, `DataTable`, `IDataReader`, ADO.NET (`SqlConnection`, `Npgsql`, `MySql`, `Oracle`, `Sqlite`), JSON, REST APIs, and CSV
- `UniversalReport.Layout` — Deterministic Measure → Arrange → Paginate engine
- `UniversalReport.Rendering.Skia` — SkiaSharp + HarfBuzz text shaping and PNG export
- `UniversalReport.Export.Pdf` — Multi-page searchable PDF exporter
- `UniversalReport.Export.Excel` — Semantic OpenXML `.xlsx` exporter with formula-injection protection
- `UniversalReport.Export.Html` — HTML preview and UTF-8 CSV exporter
- `UniversalReport.AspNetCore` — `AddUniversalReport()` DI & `MapUniversalReportApi()` endpoints

## Quick Start (Any .NET Core Project)

```csharp
using UniversalReport;
using UniversalReport.Core;

var report = await Report.LoadFileAsync("Reports/account-statement.ureport");
report.SetDataSource("Transactions", transactions);          // C# IEnumerable<T>
// report.SetDataSource("Transactions", dataTable);          // System.Data.DataTable
// report.SetJsonDataSource("Transactions", jsonString);     // JSON array / REST payload
// report.SetCsvDataSource("Transactions", csvString);       // CSV stream or text
report.SetParameter("AccountNo", "1040-883920-001");

byte[] pdf = await report.RenderAsync(ReportFormat.Pdf);
byte[] xlsx = await report.RenderAsync(ReportFormat.Excel);
```

## Pack NuGet Packages Locally

```bash
chmod +x pack.sh
./pack.sh
# Outputs .nupkg and .snupkg files into ./artifacts/nupkg
```

## Running on Linux & Docker

- **Native Skia/HarfBuzz Assets**: `UniversalReport.Rendering.Skia` bundles `SkiaSharp.NativeAssets.Linux.NoDependencies` and `HarfBuzzSharp.NativeAssets.Linux`, so Linux hosts do not need X11, Mesa, or manual `.so` installs.
- **System Fonts (Recommended for Unicode/Bengali/CJK)**:
  ```bash
  sudo apt-get update && sudo apt-get install -y fontconfig fonts-noto-core fonts-noto-extra fonts-dejavu-core
  ```
- **Run Console or ASP.NET Core Sample on Linux**:
  ```bash
  dotnet run --project samples/Console/UniversalReport.Samples.Console.csproj
  dotnet run --project samples/AspNetCoreHost/UniversalReport.Samples.AspNetCoreHost.csproj
  ```
- **Run via Linux Docker Container**:
  ```bash
  docker build -f deploy/Dockerfile -t universalreport-api .
  docker run --rm -p 8080:8080 universalreport-api
  ```

## IDE Compatibility: Visual Studio 2017+ & VS Code

- **Visual Studio 2017 (15.9), Visual Studio 2019, Visual Studio 2022+**:
  - Open `UniversalReport.sln` (`Format Version 12.00`) directly in Visual Studio.
  - To consume the compiled NuGet packages in any `.NET Core` project (`net8.0`, `net9.0`, `net10.0`), run `./pack.sh` and point a local NuGet Package Source to `./artifacts/nupkg`, or run `dotnet add package UniversalReport`.
  - Teams still on legacy Visual Studio 2017 `.NET Core 2.1` or `.NET Framework` hosts can also call the containerized `UniversalReport.AspNetCore` sidecar (`POST /api/v1/reports/render`) over HTTP while migrating services to `.NET 8/9/10`.
- **Visual Studio Code (Windows, Linux, macOS)**:
  - Open `dotnet/UniversalReport` in VS Code (`code dotnet/UniversalReport`).
  - Preconfigured `.vscode/settings.json`, `extensions.json`, `tasks.json`, and `launch.json` provide `.ureport` JSON Schema IntelliSense (`schemas/ureport-v1.schema.json`), `Ctrl+Shift+B` build, Test Explorer integration, and `F5` CoreCLR debugging for Console, Banking, and ASP.NET Core Host.
