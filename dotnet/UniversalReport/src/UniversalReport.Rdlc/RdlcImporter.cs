using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using UniversalReport.Definitions;

namespace UniversalReport.Rdlc;

public sealed record RdlcDiagnostic(string Severity, string Code, string Message, string? SourceElement = null);

public sealed record RdlcImportResult(
    UReportDefinition Definition,
    string TemplateJson,
    IReadOnlyList<RdlcDiagnostic> Diagnostics);

public static partial class RdlcImporter
{
    [GeneratedRegex(@"^=Fields!([a-zA-Z0-9_]+)\.Value$", RegexOptions.IgnoreCase)]
    private static partial Regex RdlcFieldRegex();

    [GeneratedRegex(@"^=Parameters!([a-zA-Z0-9_]+)\.Value$", RegexOptions.IgnoreCase)]
    private static partial Regex RdlcParamRegex();

    public static RdlcImportResult Convert(string rdlcXml, string? reportIdOverride = null)
    {
        var diagnostics = new List<RdlcDiagnostic>();
        var doc = XDocument.Parse(rdlcXml);
        var root = doc.Root ?? throw new InvalidOperationException("RDLC XML root element is missing.");
        var ns = root.Name.Namespace;

        var reportId = reportIdOverride ?? "imported-rdlc-report";
        var datasets = new List<DatasetDefinition>();
        var parameters = new List<ParameterDefinition>();
        var bands = new List<BandDefinition>();

        // Detect embedded VB <Code> blocks which are prohibited in UniversalReport sandbox
        if (root.Element(ns + "Code") is not null)
        {
            diagnostics.Add(new RdlcDiagnostic(
                "Warning",
                "RDLC_CUSTOM_CODE_DROPPED",
                "Embedded VB <Code> blocks are not executed in UniversalReport.NET sandbox. Replace with built-in AST functions.",
                "Code"));
        }

        // Parse ReportParameters
        var paramsNode = root.Element(ns + "ReportParameters");
        if (paramsNode is not null)
        {
            foreach (var p in paramsNode.Elements(ns + "ReportParameter"))
            {
                var pName = p.Attribute("Name")?.Value;
                if (string.IsNullOrWhiteSpace(pName)) continue;
                var dataType = p.Element(ns + "DataType")?.Value ?? "String";
                parameters.Add(new ParameterDefinition { Name = pName, Type = MapRdlcType(dataType) });
            }
        }

        // Parse DataSets
        var datasetsNode = root.Element(ns + "DataSets");
        if (datasetsNode is not null)
        {
            foreach (var ds in datasetsNode.Elements(ns + "DataSet"))
            {
                var dsName = ds.Attribute("Name")?.Value ?? "DataSet1";
                var fields = new List<FieldDefinition>();
                var fieldsNode = ds.Element(ns + "Fields");
                if (fieldsNode is not null)
                {
                    foreach (var f in fieldsNode.Elements(ns + "Field"))
                    {
                        var fName = f.Attribute("Name")?.Value;
                        if (!string.IsNullOrWhiteSpace(fName))
                            fields.Add(new FieldDefinition { Name = fName, Type = "String" });
                    }
                }
                datasets.Add(new DatasetDefinition { Name = dsName, Source = "External", Fields = fields });
            }
        }

        // Parse PageHeader & PageFooter
        var pageNode = root.Element(ns + "Page") ?? root;
        var pageHeader = pageNode.Element(ns + "PageHeader");
        if (pageHeader is not null)
        {
            bands.Add(new BandDefinition
            {
                Id = "page-header",
                Type = "PageHeader",
                Height = 14,
                RepeatOnEveryPage = true,
                Elements = ExtractTextboxes(pageHeader, ns, diagnostics)
            });
        }

        // Parse Body elements (Textboxes & Tablix/Tables)
        var body = root.Element(ns + "Body") ?? pageNode.Element(ns + "Body");
        var reportItems = body?.Element(ns + "ReportItems");
        var headerElements = new List<ElementDefinition>();

        if (reportItems is not null)
        {
            headerElements.AddRange(ExtractTextboxes(reportItems, ns, diagnostics));
            if (headerElements.Count > 0)
            {
                bands.Add(new BandDefinition
                {
                    Id = "report-header",
                    Type = "ReportHeader",
                    Height = 24,
                    Elements = headerElements
                });
            }

            foreach (var tablix in reportItems.Elements(ns + "Tablix"))
            {
                var dsName = tablix.Element(ns + "DataSetName")?.Value
                    ?? datasets.FirstOrDefault()?.Name
                    ?? "DataSet1";
                var cols = ExtractTablixColumns(tablix, ns, diagnostics);
                bands.Add(new BandDefinition
                {
                    Id = "detail-band",
                    Type = "Detail",
                    Dataset = dsName,
                    Elements =
                    [
                        new ElementDefinition
                        {
                            Id = tablix.Attribute("Name")?.Value ?? "imported-table",
                            Type = "Table",
                            X = 0,
                            Y = 0,
                            Width = 182,
                            RepeatHeaders = true,
                            Columns = cols
                        }
                    ]
                });
            }
        }

        var pageFooter = pageNode.Element(ns + "PageFooter");
        if (pageFooter is not null)
        {
            bands.Add(new BandDefinition
            {
                Id = "page-footer",
                Type = "PageFooter",
                Height = 12,
                RepeatOnEveryPage = true,
                Elements = ExtractTextboxes(pageFooter, ns, diagnostics)
            });
        }

        if (bands.Count == 0)
        {
            bands.Add(new BandDefinition
            {
                Id = "report-header",
                Type = "ReportHeader",
                Height = 20,
                Elements = [new ElementDefinition { Type = "Text", Value = "Imported RDLC Report", FontSizePt = 12, FontWeight = "Bold" }]
            });
            diagnostics.Add(new RdlcDiagnostic("Info", "RDLC_DEFAULT_BAND", "No Body or Page bands found; inserted fallback ReportHeader."));
        }

        var def = new UReportDefinition
        {
            SchemaVersion = "1.0",
            ReportId = reportId,
            Title = $"Imported RDLC ({reportId})",
            Page = new PageDefinition { Size = "A4", Unit = "mm", Orientation = "Portrait" },
            Parameters = parameters,
            Datasets = datasets,
            Bands = bands
        };

        var json = JsonSerializer.Serialize(def, new JsonSerializerOptions { WriteIndented = true });
        return new RdlcImportResult(def, json, diagnostics);
    }

    private static List<ElementDefinition> ExtractTextboxes(XElement container, XNamespace ns, List<RdlcDiagnostic> diagnostics)
    {
        var items = container.Element(ns + "ReportItems") ?? container;
        var list = new List<ElementDefinition>();
        double yCursor = 0;

        foreach (var tb in items.Elements(ns + "Textbox"))
        {
            var rawVal = tb.Descendants(ns + "Value").FirstOrDefault()?.Value ?? string.Empty;
            var translated = TranslateExpression(rawVal, diagnostics);
            var isExpr = translated.StartsWith('=');
            list.Add(new ElementDefinition
            {
                Id = tb.Attribute("Name")?.Value ?? $"tb-{list.Count + 1}",
                Type = "Text",
                X = ParseMm(tb.Element(ns + "Left")?.Value, 0),
                Y = ParseMm(tb.Element(ns + "Top")?.Value, yCursor),
                Width = ParseMm(tb.Element(ns + "Width")?.Value, 90),
                Height = ParseMm(tb.Element(ns + "Height")?.Value, 6),
                Value = isExpr ? null : translated,
                Expression = isExpr ? translated : null,
                FontSizePt = 9.5
            });
            yCursor += 7;
        }
        return list;
    }

    private static List<TableColumnDefinition> ExtractTablixColumns(XElement tablix, XNamespace ns, List<RdlcDiagnostic> diagnostics)
    {
        var cols = new List<TableColumnDefinition>();
        var rows = tablix.Descendants(ns + "TablixRow").ToList();
        if (rows.Count >= 2)
        {
            var headerCells = rows[0].Descendants(ns + "Textbox").ToList();
            var detailCells = rows[1].Descendants(ns + "Textbox").ToList();
            for (var i = 0; i < Math.Max(headerCells.Count, detailCells.Count); i++)
            {
                var headerText = i < headerCells.Count ? headerCells[i].Descendants(ns + "Value").FirstOrDefault()?.Value ?? $"Column {i + 1}" : $"Column {i + 1}";
                var exprRaw = i < detailCells.Count ? detailCells[i].Descendants(ns + "Value").FirstOrDefault()?.Value ?? string.Empty : string.Empty;
                cols.Add(new TableColumnDefinition
                {
                    Header = headerText,
                    Expression = TranslateExpression(exprRaw, diagnostics),
                    Width = 36,
                    Align = "Left"
                });
            }
        }
        return cols;
    }

    private static string TranslateExpression(string raw, List<RdlcDiagnostic> diagnostics)
    {
        if (string.IsNullOrWhiteSpace(raw) || !raw.StartsWith('=')) return raw;
        var fieldMatch = RdlcFieldRegex().Match(raw.Trim());
        if (fieldMatch.Success) return $"=Fields.{fieldMatch.Groups[1].Value}";

        var paramMatch = RdlcParamRegex().Match(raw.Trim());
        if (paramMatch.Success) return $"=Parameters.{paramMatch.Groups[1].Value}";

        var converted = raw.Replace("!", ".").Replace(".Value", string.Empty, StringComparison.OrdinalIgnoreCase);
        if (converted.Contains("Globals.PageNumber", StringComparison.OrdinalIgnoreCase) ||
            converted.Contains("Fields.", StringComparison.OrdinalIgnoreCase) ||
            converted.Contains("Parameters.", StringComparison.OrdinalIgnoreCase))
            return converted;

        diagnostics.Add(new RdlcDiagnostic("Warning", "RDLC_EXPR_REVIEW", $"Review migrated expression '{raw}' against UniversalReport AST allowlist."));
        return converted;
    }

    private static double ParseMm(string? dimension, double fallback)
    {
        if (string.IsNullOrWhiteSpace(dimension)) return fallback;
        var trimmed = dimension.Trim().ToLowerInvariant();
        if (trimmed.EndsWith("mm") && double.TryParse(trimmed[..^2], NumberStyles.Float, CultureInfo.InvariantCulture, out var mm))
            return Math.Round(mm, 2);
        if (trimmed.EndsWith("in") && double.TryParse(trimmed[..^2], NumberStyles.Float, CultureInfo.InvariantCulture, out var inches))
            return Math.Round(inches * 25.4, 2);
        if (trimmed.EndsWith("cm") && double.TryParse(trimmed[..^2], NumberStyles.Float, CultureInfo.InvariantCulture, out var cm))
            return Math.Round(cm * 10.0, 2);
        return fallback;
    }

    private static string MapRdlcType(string rdlcType) => rdlcType.ToLowerInvariant() switch
    {
        "integer" => "Int32",
        "float" => "Decimal",
        "datetime" => "DateTime",
        "boolean" => "Boolean",
        _ => "String"
    };
}
