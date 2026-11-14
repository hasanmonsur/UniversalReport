using SkiaSharp;
using UniversalReport.Core;
using UniversalReport.Rendering.Skia;

namespace UniversalReport.Export.Pdf;

public sealed class PdfReportRenderer(SkiaFontPolicy? fontPolicy = null) : IReportRenderer
{
    private const double MmToPt = 72.0 / 25.4;
    private readonly SkiaFontPolicy _fontPolicy = fontPolicy ?? new SkiaFontPolicy();

    public ReportFormat Format => ReportFormat.Pdf;

    public Task RenderAsync(
        RenderDocument document,
        Stream output,
        RenderOptions options,
        CancellationToken cancellationToken = default)
    {
        var metadata = new SKDocumentPdfMetadata
        {
            Title = document.Title,
            Creator = "UniversalReport.NET 1.0",
            Producer = "UniversalReport.Export.Pdf (SkiaSharp)",
            Creation = DateTime.UtcNow
        };

        using var pdf = SKDocument.CreatePdf(output, metadata);
        foreach (var page in document.Pages)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var widthPt = (float)(page.WidthMm * MmToPt);
            var heightPt = (float)(page.HeightMm * MmToPt);
            using var canvas = pdf.BeginPage(widthPt, heightPt);
            canvas.Scale((float)MmToPt);

            foreach (var node in page.Nodes)
            {
                switch (node)
                {
                    case RectangleDrawNode rect:
                        if (!string.IsNullOrWhiteSpace(rect.FillColor) && SKColor.TryParse(rect.FillColor, out var fill))
                        {
                            using var p = new SKPaint { Color = fill, Style = SKPaintStyle.Fill };
                            canvas.DrawRect((float)rect.Bounds.X, (float)rect.Bounds.Y, (float)rect.Bounds.Width, (float)rect.Bounds.Height, p);
                        }
                        if (!string.IsNullOrWhiteSpace(rect.StrokeColor) && SKColor.TryParse(rect.StrokeColor, out var stroke))
                        {
                            using var p = new SKPaint { Color = stroke, Style = SKPaintStyle.Stroke, StrokeWidth = (float)rect.StrokeWidthMm };
                            canvas.DrawRect((float)rect.Bounds.X, (float)rect.Bounds.Y, (float)rect.Bounds.Width, (float)rect.Bounds.Height, p);
                        }
                        break;
                    case LineDrawNode line:
                        SKColor.TryParse(line.Color, out var lc);
                        using (var p = new SKPaint { Color = lc, StrokeWidth = (float)line.ThicknessMm })
                            canvas.DrawLine((float)line.X1, (float)line.Y1, (float)line.X2, (float)line.Y2, p);
                        break;
                    case QrCodeDrawNode qr:
                        SkiaVectorHelpers.DrawQrCode(canvas, qr.Payload, qr.Bounds);
                        break;
                    case ImageDrawNode img:
                        SkiaVectorHelpers.DrawDataUriImage(canvas, img.DataUri, img.Bounds);
                        break;
                    case TextDrawNode text:
                        var tf = _fontPolicy.ResolveTypeface(text.Style.FontFamily, text.Style.FontWeight);
                        SKColor.TryParse(text.Style.Color, out var tc);
                        using (var font = new SKFont(tf, (float)(text.Style.FontSizePt * 0.352778)))
                        using (var p = new SKPaint { Color = tc, IsAntialias = true })
                        {
                            SkiaVectorHelpers.DrawTextLines(canvas, font, p, text.Bounds, text.Text, text.Style.Align);
                        }
                        break;
                }
            }

            pdf.EndPage();
        }

        pdf.Close();
        return Task.CompletedTask;
    }
}
