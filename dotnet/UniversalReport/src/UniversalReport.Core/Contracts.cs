namespace UniversalReport.Core;

public enum ReportFormat
{
    Pdf,
    Excel,
    Html,
    Csv,
    Png
}

public readonly record struct SizeD(double Width, double Height)
{
    public static SizeD Empty => new(0, 0);
}

public readonly record struct RectD(double X, double Y, double Width, double Height);

public readonly record struct ThicknessD(double Top, double Right, double Bottom, double Left)
{
    public static ThicknessD Uniform(double value) => new(value, value, value, value);
}

public sealed record ReportError(string Code, string Message, string? Path = null);

public sealed class ReportValidationException(IReadOnlyList<ReportError> errors)
    : Exception($"Report validation failed with {errors.Count} error(s): {string.Join("; ", errors.Select(e => e.Message))}")
{
    public IReadOnlyList<ReportError> Errors { get; } = errors;
}

public sealed record RenderOptions(
    int Dpi = 150,
    string DefaultFontFamily = "Noto Sans",
    string FallbackFontFamily = "Noto Sans Bengali",
    bool EmbedFonts = true,
    bool NeutralizeSpreadsheetFormulas = true,
    string? TitleOverride = null);

public sealed record ReportRow(IReadOnlyDictionary<string, object?> Values)
{
    public object? this[string fieldName] =>
        Values.TryGetValue(fieldName, out var value) ? value : null;
}

public sealed record ReportDataQuery(
    string DatasetName,
    string? QueryId,
    int? MaxRows = null);

public interface IReportDataProvider
{
    string ProviderName { get; }

    IAsyncEnumerable<ReportRow> ExecuteAsync(
        ReportDataQuery query,
        IReadOnlyDictionary<string, object?> parameters,
        CancellationToken cancellationToken = default);
}

public interface IReportElement
{
    SizeD Measure(LayoutContext context, SizeD available);
    void Arrange(LayoutContext context, RectD bounds);
    void Render(IRenderCanvas canvas, RenderContext context);
}

public interface IReportRenderer
{
    ReportFormat Format { get; }

    Task RenderAsync(
        RenderDocument document,
        Stream output,
        RenderOptions options,
        CancellationToken cancellationToken = default);
}

public interface IRenderCanvas
{
    void DrawText(string text, RectD bounds, TextDrawStyle style);
    void DrawLine(double x1, double y1, double x2, double y2, string color, double thicknessMm);
    void DrawRectangle(RectD bounds, string? fillColor, string? strokeColor, double strokeWidthMm);
    void DrawQrCode(string payload, RectD bounds);
    void DrawImage(string dataUri, RectD bounds);
}

public sealed record TextDrawStyle(
    string FontFamily,
    double FontSizePt,
    string FontWeight,
    string Color,
    string Align);

public sealed class LayoutContext
{
    public required int PageNumber { get; init; }
    public required int TotalPages { get; init; }
    public required string FontFamily { get; init; }
    public required string FallbackFontFamily { get; init; }
}

public sealed class RenderContext
{
    public required int PageNumber { get; init; }
    public required int TotalPages { get; init; }
    public required IReadOnlyDictionary<string, object?> Parameters { get; init; }
}

public sealed record RenderPage(
    int PageNumber,
    double WidthMm,
    double HeightMm,
    IReadOnlyList<PositionedDrawNode> Nodes);

public abstract record PositionedDrawNode(RectD Bounds);

public sealed record TextDrawNode(
    RectD Bounds,
    string Text,
    TextDrawStyle Style) : PositionedDrawNode(Bounds);

public sealed record LineDrawNode(
    RectD Bounds,
    double X1,
    double Y1,
    double X2,
    double Y2,
    string Color,
    double ThicknessMm) : PositionedDrawNode(Bounds);

public sealed record RectangleDrawNode(
    RectD Bounds,
    string? FillColor,
    string? StrokeColor,
    double StrokeWidthMm) : PositionedDrawNode(Bounds);

public sealed record QrCodeDrawNode(
    RectD Bounds,
    string Payload) : PositionedDrawNode(Bounds);

public sealed record ImageDrawNode(
    RectD Bounds,
    string DataUri) : PositionedDrawNode(Bounds);

public sealed record SemanticTableColumn(string Header, string Align, string? Format);

public sealed record SemanticTable(
    string DatasetName,
    IReadOnlyList<SemanticTableColumn> Columns,
    IReadOnlyList<IReadOnlyList<object?>> Rows,
    IReadOnlyList<object?>? SummaryRow = null);

public sealed record RenderDocument(
    string ReportId,
    string Title,
    string ContentHash,
    double PageWidthMm,
    double PageHeightMm,
    IReadOnlyList<RenderPage> Pages,
    IReadOnlyList<SemanticTable> SemanticTables);
