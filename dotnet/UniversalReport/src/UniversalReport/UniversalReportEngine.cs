using UniversalReport.Core;
using UniversalReport.Export.Excel;
using UniversalReport.Export.Html;
using UniversalReport.Export.Pdf;
using UniversalReport.Layout;
using UniversalReport.Rendering.Skia;

namespace UniversalReport;

/// <summary>
/// Zero-configuration factory for consuming UniversalReport.NET from any .NET Core Console, Worker, Desktop, or Web project.
/// </summary>
public static class UniversalReportEngine
{
    public static IReportEnginePipeline CreateDefault(SkiaFontPolicy? fontPolicy = null)
    {
        var policy = fontPolicy ?? new SkiaFontPolicy();
        IReportRenderer[] renderers =
        [
            new PdfReportRenderer(policy),
            new ExcelReportRenderer(),
            new HtmlReportRenderer(),
            new CsvReportRenderer(),
            new PngReportRenderer(policy)
        ];
        return new ReportEnginePipeline(renderers);
    }

    public static Report CreateFromJson(string templateJson, SkiaFontPolicy? fontPolicy = null) =>
        new(templateJson, CreateDefault(fontPolicy));

    public static Task<Report> LoadFileAsync(
        string filePath,
        SkiaFontPolicy? fontPolicy = null,
        CancellationToken cancellationToken = default) =>
        Report.LoadAsync(filePath, CreateDefault(fontPolicy), cancellationToken);
}
