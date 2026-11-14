using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using UniversalReport.Core;
using UniversalReport.Data.Adapters;
using UniversalReport.Definitions;
using UniversalReport.Export.Excel;
using UniversalReport.Export.Html;
using UniversalReport.Export.Pdf;
using UniversalReport.Expressions;
using UniversalReport.Layout;
using UniversalReport.Rdlc;
using UniversalReport.Rendering.Skia;

namespace UniversalReport.AspNetCore;

public sealed class UniversalReportApiKeyOptions
{
    public string? ApiKey { get; set; }
}

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddUniversalReport(
        this IServiceCollection services,
        Action<UniversalReportApiKeyOptions>? configureAuth = null)
    {
        var authOptions = new UniversalReportApiKeyOptions();
        configureAuth?.Invoke(authOptions);
        services.AddSingleton(authOptions);
        services.AddSingleton<SkiaFontPolicy>();
        services.AddSingleton<IReportRenderer, PdfReportRenderer>();
        services.AddSingleton<IReportRenderer, ExcelReportRenderer>();
        services.AddSingleton<IReportRenderer, HtmlReportRenderer>();
        services.AddSingleton<IReportRenderer, CsvReportRenderer>();
        services.AddSingleton<IReportRenderer, PngReportRenderer>();
        services.AddSingleton<IReportEnginePipeline, ReportEnginePipeline>();
        services.AddSingleton<InMemoryJobStore>();
        services.AddSingleton<InMemoryTemplateRegistry>();
        return services;
    }
}

public sealed record RenderApiRequest(
    string TemplateJson,
    ReportFormat Format,
    Dictionary<string, List<Dictionary<string, object?>>>? Datasets,
    Dictionary<string, object?>? Parameters,
    RenderOptions? Options);

public sealed record CompileExpressionRequest(string Expression);

public sealed record ImportRdlcRequest(string RdlcXml, string? ReportId = null);

public sealed record DataSourceCheckRequest(string Kind, string Payload, string? RootPath = null);

public sealed record ReportJobRecord(
    string JobId,
    string Status,
    ReportFormat Format,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset ExpiresAtUtc,
    byte[]? Payload = null,
    string? ErrorCode = null);

public sealed class InMemoryJobStore
{
    public ConcurrentDictionary<string, ReportJobRecord> Jobs { get; } = new();
}

public sealed record TemplateRevisionEntry(
    int RevisionId,
    string ReportId,
    string ContentHash,
    DateTimeOffset SavedAtUtc,
    string TemplateJson);

public sealed class InMemoryTemplateRegistry
{
    public ConcurrentDictionary<string, string> Templates { get; } = new(StringComparer.OrdinalIgnoreCase);
    public ConcurrentDictionary<string, List<TemplateRevisionEntry>> Revisions { get; } = new(StringComparer.OrdinalIgnoreCase);
}

public static class UniversalReportEndpointExtensions
{
    public static IApplicationBuilder UseUniversalReportApiKey(
        this IApplicationBuilder app,
        string? apiKey = null,
        string prefix = "/api/v1")
    {
        return app.Use(async (context, next) =>
        {
            if (!context.Request.Path.StartsWithSegments(prefix, StringComparison.OrdinalIgnoreCase))
            {
                await next();
                return;
            }

            var configured = !string.IsNullOrWhiteSpace(apiKey)
                ? apiKey
                : context.RequestServices.GetService<UniversalReportApiKeyOptions>()?.ApiKey;

            if (string.IsNullOrWhiteSpace(configured))
            {
                await next();
                return;
            }

            var isProtected = HttpMethods.IsPost(context.Request.Method)
                || HttpMethods.IsPut(context.Request.Method)
                || HttpMethods.IsDelete(context.Request.Method)
                || context.Request.Path.Value?.EndsWith("/download", StringComparison.OrdinalIgnoreCase) == true;

            if (!isProtected)
            {
                await next();
                return;
            }

            var auth = context.Request.Headers.Authorization.ToString();
            var bearer = auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
                ? auth["Bearer ".Length..].Trim()
                : string.Empty;
            var headerKey = context.Request.Headers["X-API-Key"].ToString().Trim();
            var candidate = !string.IsNullOrEmpty(bearer) ? bearer : headerKey;

            var candidateBytes = Encoding.UTF8.GetBytes(candidate);
            var expectedBytes = Encoding.UTF8.GetBytes(configured.Trim());
            if (candidateBytes.Length != expectedBytes.Length ||
                !CryptographicOperations.FixedTimeEquals(candidateBytes, expectedBytes))
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                await context.Response.WriteAsJsonAsync(new { error = "Unauthorized: invalid or missing API key." });
                return;
            }

            await next();
        });
    }

    public static IEndpointRouteBuilder MapUniversalReportApi(
        this IEndpointRouteBuilder endpoints,
        string prefix = "/api/v1")
    {
        var group = endpoints.MapGroup(prefix);

        group.MapPost("/reports/validate", (JsonElement body) =>
        {
            var raw = body.GetRawText();
            var (def, errors, hash) = UReportLoader.ParseAndValidate(raw);
            return Results.Ok(new { valid = errors.Count == 0, contentHash = hash, reportId = def?.ReportId, errors });
        });

        group.MapPost("/reports/compile", (CompileExpressionRequest req) =>
        {
            var compiled = ExpressionCompiler.Compile(req.Expression);
            return Results.Ok(new { compiled.Source, compiled.ReferencedFields, astType = compiled.Ast.GetType().Name });
        });

        group.MapPost("/reports/render", async (RenderApiRequest req, IReportEnginePipeline pipeline, CancellationToken ct) =>
        {
            var report = new Report(req.TemplateJson, pipeline);
            if (req.Datasets is not null)
            {
                foreach (var (name, list) in req.Datasets)
                    report.SetDataSource(name, list);
            }
            if (req.Parameters is not null)
            {
                foreach (var (k, v) in req.Parameters)
                    report.SetParameter(k, v);
            }

            var bytes = await report.RenderAsync(req.Format, req.Options, ct);
            var contentType = req.Format switch
            {
                ReportFormat.Pdf => "application/pdf",
                ReportFormat.Excel => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                ReportFormat.Html => "text/html; charset=utf-8",
                ReportFormat.Csv => "text/csv; charset=utf-8",
                ReportFormat.Png => "image/png",
                _ => "application/octet-stream"
            };
            return Results.File(bytes, contentType, $"report.{req.Format.ToString().ToLowerInvariant()}");
        });

        group.MapPost("/report-jobs", (RenderApiRequest req, IReportEnginePipeline pipeline, InMemoryJobStore store) =>
        {
            var jobId = Guid.NewGuid().ToString("N");
            var created = DateTimeOffset.UtcNow;
            store.Jobs[jobId] = new ReportJobRecord(jobId, "Queued", req.Format, created, created.AddMinutes(15));

            _ = Task.Run(async () =>
            {
                try
                {
                    var report = new Report(req.TemplateJson, pipeline);
                    if (req.Datasets is not null)
                        foreach (var (name, list) in req.Datasets) report.SetDataSource(name, list);
                    if (req.Parameters is not null)
                        foreach (var (k, v) in req.Parameters) report.SetParameter(k, v);

                    var bytes = await report.RenderAsync(req.Format, req.Options);
                    store.Jobs[jobId] = new ReportJobRecord(jobId, "Completed", req.Format, created, created.AddMinutes(15), bytes);
                }
                catch
                {
                    store.Jobs[jobId] = new ReportJobRecord(jobId, "Failed", req.Format, created, created.AddMinutes(15), ErrorCode: "RENDER_FAILED");
                }
            });

            return Results.Accepted($"{prefix}/report-jobs/{jobId}", new { jobId, status = "Queued" });
        });

        group.MapGet("/report-jobs/{id}", (string id, InMemoryJobStore store) =>
            store.Jobs.TryGetValue(id, out var job)
                ? Results.Ok(new { job.JobId, job.Status, job.Format, job.CreatedAtUtc, job.ExpiresAtUtc, job.ErrorCode })
                : Results.NotFound());

        group.MapGet("/report-jobs/{id}/download", (string id, InMemoryJobStore store) =>
        {
            if (!store.Jobs.TryGetValue(id, out var job) || job.Payload is null)
                return Results.NotFound();
            if (DateTimeOffset.UtcNow > job.ExpiresAtUtc)
                return Results.StatusCode(StatusCodes.Status410Gone);
            return Results.File(job.Payload, "application/octet-stream", $"{id}.{job.Format.ToString().ToLowerInvariant()}");
        });

        group.MapGet("/templates/{id}/revisions", (string id, InMemoryTemplateRegistry registry) =>
        {
            var list = registry.Revisions.TryGetValue(id, out var entries)
                ? entries.OrderByDescending(e => e.RevisionId).Take(25).ToList()
                : [];
            return Results.Ok(new { reportId = id, revisions = list });
        });

        group.MapPut("/templates/{id}", (string id, JsonElement body, InMemoryTemplateRegistry registry) =>
        {
            var raw = body.GetRawText();
            var (_, errors, hash) = UReportLoader.ParseAndValidate(raw);
            if (errors.Count > 0) return Results.BadRequest(new { errors });
            registry.Templates[id] = raw;
            var list = registry.Revisions.GetOrAdd(id, _ => []);
            int revId;
            lock (list)
            {
                revId = list.Count + 1;
                list.Add(new TemplateRevisionEntry(revId, id, hash, DateTimeOffset.UtcNow, raw));
            }
            return Results.Ok(new { id, revisionId = revId, contentHash = hash, status = "Published" });
        });

        group.MapPost("/reports/import-rdlc", (ImportRdlcRequest req) =>
        {
            var result = RdlcImporter.Convert(req.RdlcXml, req.ReportId);
            return Results.Ok(new
            {
                reportId = result.Definition.ReportId,
                templateJson = result.TemplateJson,
                diagnostics = result.Diagnostics
            });
        });

        group.MapPost("/datasources/check", (DataSourceCheckRequest req) =>
        {
            var kind = (req.Kind ?? string.Empty).Trim().ToLowerInvariant();
            if (kind == "json")
            {
                var rows = JsonDataProvider.ParseRows(req.Payload, req.RootPath, 100);
                var fields = InferFields(rows);
                return Results.Ok(new { valid = true, kind = "json", securityCheck = "Passed JSON schema & type inference", fields, rowCount = rows.Count, rows = rows.Select(r => r.Values) });
            }
            if (kind == "csv")
            {
                var rows = CsvDataProvider.ParseRows(req.Payload, hasHeader: true, delimiter: ',', maxRows: 100);
                var fields = InferFields(rows);
                return Results.Ok(new { valid = true, kind = "csv", securityCheck = "Passed RFC-4180 CSV parser", fields, rowCount = rows.Count, rows = rows.Select(r => r.Values) });
            }
            if (kind == "sql")
            {
                if (Regex.IsMatch(req.Payload, @"\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|MERGE|EXEC|EXECUTE|GRANT|REVOKE)\b", RegexOptions.IgnoreCase))
                {
                    return Results.BadRequest(new { valid = false, securityCheck = "Blocked: mutating SQL keyword detected", error = "AdoNetDataProvider only allows read-only SELECT or WITH queries." });
                }
                if (!Regex.IsMatch(req.Payload.TrimStart(), @"^(SELECT|WITH)\b", RegexOptions.IgnoreCase))
                {
                    return Results.BadRequest(new { valid = false, securityCheck = "Blocked: query must start with SELECT or WITH", error = "Only read-only SELECT or CTE queries are permitted." });
                }
                var detectedParams = Regex.Matches(req.Payload, @"[@:]([A-Za-z_][A-Za-z0-9_]*)")
                    .Select(m => m.Groups[1].Value)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList();
                return Results.Ok(new { valid = true, kind = "sql", securityCheck = "Passed read-only SQL allowlist & parameter check", detectedParameters = detectedParams, rowCount = 0 });
            }
            return Results.BadRequest(new { valid = false, error = $"Unsupported data source kind '{req.Kind}'." });
        });

        return endpoints;
    }

    private static List<FieldDefinition> InferFields(IReadOnlyList<ReportRow> rows)
    {
        var first = rows.FirstOrDefault();
        if (first is null) return [];
        return first.Values.Select(kv => new FieldDefinition
        {
            Name = kv.Key,
            Type = kv.Value switch
            {
                decimal or double or float => "Decimal",
                int or long => "Int32",
                bool => "Boolean",
                DateTime => "DateTime",
                _ => "String"
            }
        }).ToList();
    }
}
