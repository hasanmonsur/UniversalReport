using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using UniversalReport.Core;

namespace UniversalReport.Definitions;

public sealed record UReportDefinition
{
    [JsonPropertyName("schemaVersion")]
    public string SchemaVersion { get; init; } = "1.0";

    [JsonPropertyName("reportId")]
    public string ReportId { get; init; } = string.Empty;

    [JsonPropertyName("title")]
    public string? Title { get; init; }

    [JsonPropertyName("page")]
    public PageDefinition Page { get; init; } = new();

    [JsonPropertyName("parameters")]
    public IReadOnlyList<ParameterDefinition> Parameters { get; init; } = [];

    [JsonPropertyName("datasets")]
    public IReadOnlyList<DatasetDefinition> Datasets { get; init; } = [];

    [JsonPropertyName("bands")]
    public IReadOnlyList<BandDefinition> Bands { get; init; } = [];
}

public sealed record PageDefinition
{
    [JsonPropertyName("size")]
    public string Size { get; init; } = "A4";

    [JsonPropertyName("unit")]
    public string Unit { get; init; } = "mm";

    [JsonPropertyName("orientation")]
    public string Orientation { get; init; } = "Portrait";

    [JsonPropertyName("width")]
    public double? Width { get; init; }

    [JsonPropertyName("height")]
    public double? Height { get; init; }

    [JsonPropertyName("margins")]
    public MarginsDefinition Margins { get; init; } = new();

    [JsonPropertyName("watermark")]
    public string? Watermark { get; init; }

    public (double WidthMm, double HeightMm) ResolveDimensionsMm()
    {
        var (baseW, baseH) = Size.ToUpperInvariant() switch
        {
            "A4" => (210.0, 297.0),
            "LETTER" => (215.9, 279.4),
            "LEGAL" => (215.9, 355.6),
            "CUSTOM" => (Width ?? 210.0, Height ?? 297.0),
            _ => (210.0, 297.0)
        };

        return Orientation.Equals("Landscape", StringComparison.OrdinalIgnoreCase)
            ? (baseH, baseW)
            : (baseW, baseH);
    }
}

public sealed record MarginsDefinition
{
    [JsonPropertyName("top")] public double Top { get; init; } = 12;
    [JsonPropertyName("right")] public double Right { get; init; } = 12;
    [JsonPropertyName("bottom")] public double Bottom { get; init; } = 12;
    [JsonPropertyName("left")] public double Left { get; init; } = 12;
}

public sealed record ParameterDefinition
{
    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;
    [JsonPropertyName("type")] public string Type { get; init; } = "String";
    [JsonPropertyName("required")] public bool Required { get; init; }
    [JsonPropertyName("defaultValue")] public object? DefaultValue { get; init; }
}

public sealed record DatasetDefinition
{
    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;
    [JsonPropertyName("source")] public string Source { get; init; } = "External";
    [JsonPropertyName("queryId")] public string? QueryId { get; init; }
    [JsonPropertyName("fields")] public IReadOnlyList<FieldDefinition> Fields { get; init; } = [];
}

public sealed record FieldDefinition
{
    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;
    [JsonPropertyName("type")] public string Type { get; init; } = "String";
}

public sealed record BandDefinition
{
    [JsonPropertyName("id")] public string? Id { get; init; }
    [JsonPropertyName("type")] public string Type { get; init; } = "Detail";
    [JsonPropertyName("dataset")] public string? Dataset { get; init; }
    [JsonPropertyName("groupBy")] public string? GroupBy { get; init; }
    [JsonPropertyName("height")] public double? Height { get; init; }
    [JsonPropertyName("keepTogether")] public bool KeepTogether { get; init; }
    [JsonPropertyName("repeatOnEveryPage")] public bool RepeatOnEveryPage { get; init; }
    [JsonPropertyName("elements")] public IReadOnlyList<ElementDefinition> Elements { get; init; } = [];
}

public sealed record ElementDefinition
{
    [JsonPropertyName("id")] public string? Id { get; init; }
    [JsonPropertyName("type")] public string Type { get; init; } = "Text";
    [JsonPropertyName("x")] public double X { get; init; }
    [JsonPropertyName("y")] public double Y { get; init; }
    [JsonPropertyName("width")] public double? Width { get; init; }
    [JsonPropertyName("height")] public double? Height { get; init; }
    [JsonPropertyName("value")] public string? Value { get; init; }
    [JsonPropertyName("expression")] public string? Expression { get; init; }
    [JsonPropertyName("format")] public string? Format { get; init; }
    [JsonPropertyName("align")] public string? Align { get; init; }
    [JsonPropertyName("fontSizePt")] public double? FontSizePt { get; init; }
    [JsonPropertyName("fontWeight")] public string? FontWeight { get; init; }
    [JsonPropertyName("color")] public string? Color { get; init; }
    [JsonPropertyName("colorExpression")] public string? ColorExpression { get; init; }
    [JsonPropertyName("backgroundColor")] public string? BackgroundColor { get; init; }
    [JsonPropertyName("backgroundColorExpression")] public string? BackgroundColorExpression { get; init; }
    [JsonPropertyName("borderColor")] public string? BorderColor { get; init; }
    [JsonPropertyName("canGrow")] public bool CanGrow { get; init; }
    [JsonPropertyName("repeatHeaders")] public bool? RepeatHeaders { get; init; }
    [JsonPropertyName("columns")] public IReadOnlyList<TableColumnDefinition> Columns { get; init; } = [];
}

public sealed record TableColumnDefinition
{
    [JsonPropertyName("header")] public string Header { get; init; } = string.Empty;
    [JsonPropertyName("expression")] public string Expression { get; init; } = string.Empty;
    [JsonPropertyName("width")] public double? Width { get; init; }
    [JsonPropertyName("align")] public string? Align { get; init; }
    [JsonPropertyName("format")] public string? Format { get; init; }
    [JsonPropertyName("summary")] public string? Summary { get; init; }
    [JsonPropertyName("canGrow")] public bool CanGrow { get; init; }
    [JsonPropertyName("colorExpression")] public string? ColorExpression { get; init; }
    [JsonPropertyName("backgroundColorExpression")] public string? BackgroundColorExpression { get; init; }
}

public static class UReportLoader
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip
    };

    private static readonly HashSet<string> AllowedBandTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "ReportHeader", "PageHeader", "GroupHeader", "Detail", "GroupFooter", "ReportFooter", "PageFooter"
    };

    private static readonly HashSet<string> AllowedElementTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "Text", "Table", "Line", "Rectangle", "Image", "QrCode"
    };

    public static (UReportDefinition? Definition, IReadOnlyList<ReportError> Errors, string ContentHash) ParseAndValidate(string json)
    {
        var errors = new List<ReportError>();
        if (string.IsNullOrWhiteSpace(json))
        {
            errors.Add(new ReportError("UREPORT_EMPTY", "Template payload must not be empty."));
            return (null, errors, string.Empty);
        }

        if (json.Length > 2 * 1024 * 1024)
        {
            errors.Add(new ReportError("UREPORT_SIZE_LIMIT", "Template payload exceeds 2 MB security limit."));
            return (null, errors, string.Empty);
        }

        var hashBytes = SHA256.HashData(Encoding.UTF8.GetBytes(json));
        var contentHash = Convert.ToHexString(hashBytes).ToLowerInvariant();

        UReportDefinition? def;
        try
        {
            def = JsonSerializer.Deserialize<UReportDefinition>(json, JsonOptions);
        }
        catch (JsonException ex)
        {
            errors.Add(new ReportError("UREPORT_JSON_INVALID", $"Invalid JSON syntax: {ex.Message}"));
            return (null, errors, contentHash);
        }

        if (def is null)
        {
            errors.Add(new ReportError("UREPORT_NULL", "Template deserialized to null."));
            return (null, errors, contentHash);
        }

        if (def.SchemaVersion != "1.0")
        {
            errors.Add(new ReportError("UREPORT_SCHEMA_VERSION", $"Unsupported schemaVersion '{def.SchemaVersion}'. Expected '1.0'.", "schemaVersion"));
        }

        if (string.IsNullOrWhiteSpace(def.ReportId))
        {
            errors.Add(new ReportError("UREPORT_ID_REQUIRED", "reportId is required.", "reportId"));
        }

        if (def.Bands.Count == 0)
        {
            errors.Add(new ReportError("UREPORT_BANDS_EMPTY", "At least one report band is required.", "bands"));
        }

        for (var i = 0; i < def.Bands.Count; i++)
        {
            var band = def.Bands[i];
            if (!AllowedBandTypes.Contains(band.Type))
            {
                errors.Add(new ReportError("UREPORT_BAND_TYPE", $"Unsupported band type '{band.Type}'.", $"bands[{i}].type"));
            }

            for (var j = 0; j < band.Elements.Count; j++)
            {
                var el = band.Elements[j];
                if (!AllowedElementTypes.Contains(el.Type))
                {
                    errors.Add(new ReportError("UREPORT_ELEMENT_TYPE", $"Unsupported element type '{el.Type}'.", $"bands[{i}].elements[{j}].type"));
                }

                // SSRF and local file isolation check (Blueprint Section 13)
                if (el.Type.Equals("Image", StringComparison.OrdinalIgnoreCase) &&
                    !string.IsNullOrWhiteSpace(el.Value) &&
                    (el.Value.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                     el.Value.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
                     el.Value.StartsWith("file://", StringComparison.OrdinalIgnoreCase)))
                {
                    errors.Add(new ReportError("UREPORT_RESOURCE_ISOLATION", "External URLs and local file paths are blocked in sandboxed templates.", $"bands[{i}].elements[{j}].value"));
                }
            }
        }

        return (errors.Count == 0 ? def : null, errors, contentHash);
    }
}
