using QRCoder;
using SkiaSharp;
using SkiaSharp.HarfBuzz;
using UniversalReport.Core;

namespace UniversalReport.Rendering.Skia;

public sealed class SkiaFontPolicy(string defaultFamily = "Noto Sans", string fallbackFamily = "Noto Sans Bengali")
{
    private readonly List<SKTypeface> _customTypefaces = new();

    public void RegisterFontFile(string fontPath)
    {
        if (File.Exists(fontPath))
        {
            var tf = SKTypeface.FromFile(fontPath);
            if (tf is not null) _customTypefaces.Add(tf);
        }
    }

    public void RegisterFontDirectory(string directory)
    {
        if (!Directory.Exists(directory)) return;
        foreach (var file in Directory.EnumerateFiles(directory, "*.*", SearchOption.AllDirectories))
        {
            if (file.EndsWith(".ttf", StringComparison.OrdinalIgnoreCase) ||
                file.EndsWith(".otf", StringComparison.OrdinalIgnoreCase))
            {
                RegisterFontFile(file);
            }
        }
    }

    public SKTypeface ResolveTypeface(string? requestedFamily, string fontWeight)
    {
        var weight = fontWeight.Equals("Bold", StringComparison.OrdinalIgnoreCase)
            ? SKFontStyleWeight.Bold
            : fontWeight.Equals("SemiBold", StringComparison.OrdinalIgnoreCase)
                ? SKFontStyleWeight.SemiBold
                : SKFontStyleWeight.Normal;

        var style = new SKFontStyle(weight, SKFontStyleWidth.Normal, SKFontStyleSlant.Upright);

        if (!string.IsNullOrWhiteSpace(requestedFamily))
        {
            var custom = _customTypefaces.FirstOrDefault(
                t => t.FamilyName.Equals(requestedFamily, StringComparison.OrdinalIgnoreCase));
            if (custom is not null) return custom;
        }

        return SKTypeface.FromFamilyName(requestedFamily ?? defaultFamily, style)
            ?? SKTypeface.FromFamilyName(defaultFamily, style)
            ?? SKTypeface.FromFamilyName(fallbackFamily, style)
            ?? SKTypeface.FromFamilyName("DejaVu Sans", style)
            ?? SKTypeface.FromFamilyName("Liberation Sans", style)
            ?? _customTypefaces.FirstOrDefault()
            ?? SKFontManager.Default.MatchCharacter('A')
            ?? SKTypeface.Default;
    }
}

public static class SkiaVectorHelpers
{
    public static void DrawQrCode(SKCanvas canvas, string payload, RectD bounds)
    {
        if (string.IsNullOrWhiteSpace(payload)) return;
        using var generator = new QRCodeGenerator();
        using var data = generator.CreateQrCode(payload, QRCodeGenerator.ECCLevel.M);
        var matrix = data.ModuleMatrix;
        var count = matrix.Count;
        if (count == 0) return;

        var size = Math.Min(bounds.Width, bounds.Height);
        var cell = (float)(size / count);

        using var bgPaint = new SKPaint { Color = SKColors.White, Style = SKPaintStyle.Fill };
        canvas.DrawRect((float)bounds.X, (float)bounds.Y, (float)size, (float)size, bgPaint);

        using var darkPaint = new SKPaint { Color = SKColor.Parse("#0F172A"), Style = SKPaintStyle.Fill };
        for (var r = 0; r < count; r++)
        {
            for (var c = 0; c < count; c++)
            {
                if (matrix[r][c])
                {
                    canvas.DrawRect(
                        (float)bounds.X + c * cell,
                        (float)bounds.Y + r * cell,
                        cell,
                        cell,
                        darkPaint);
                }
            }
        }
    }

    public static void DrawDataUriImage(SKCanvas canvas, string dataUri, RectD bounds)
    {
        var commaIdx = dataUri.IndexOf(',');
        if (commaIdx < 0) return;
        var base64 = dataUri[(commaIdx + 1)..];
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(base64);
        }
        catch
        {
            return;
        }

        using var image = SKImage.FromEncodedData(bytes);
        if (image is null) return;
        canvas.DrawImage(image, SKRect.Create((float)bounds.X, (float)bounds.Y, (float)bounds.Width, (float)bounds.Height));
    }

    public static float AlignTextX(RectD bounds, string align, float measuredWidth)
    {
        if (align.Equals("Right", StringComparison.OrdinalIgnoreCase))
            return (float)(bounds.X + bounds.Width - measuredWidth);
        if (align.Equals("Center", StringComparison.OrdinalIgnoreCase))
            return (float)(bounds.X + (bounds.Width - measuredWidth) / 2.0);
        return (float)bounds.X;
    }

    public static void DrawTextLines(
        SKCanvas canvas,
        SKFont font,
        SKPaint paint,
        RectD bounds,
        string text,
        string align,
        SKShaper? shaper = null)
    {
        var lines = text.Split('\n');
        var lineHeightMm = font.Size * 1.25f;
        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            var x = AlignTextX(bounds, align, font.MeasureText(line));
            var y = (float)bounds.Y + font.Size + i * lineHeightMm;
            if (shaper is not null)
                canvas.DrawShapedText(shaper, line, x, y, font, paint);
            else
                canvas.DrawText(line, x, y, font, paint);
        }
    }
}

public sealed class PngReportRenderer(SkiaFontPolicy? fontPolicy = null) : IReportRenderer
{
    private readonly SkiaFontPolicy _fontPolicy = fontPolicy ?? new SkiaFontPolicy();

    public ReportFormat Format => ReportFormat.Png;

    public Task RenderAsync(
        RenderDocument document,
        Stream output,
        RenderOptions options,
        CancellationToken cancellationToken = default)
    {
        var page = document.Pages.FirstOrDefault()
            ?? throw new InvalidOperationException("Document contains no rendered pages.");

        var pxPerMm = options.Dpi / 25.4;
        var widthPx = Math.Max(1, (int)Math.Ceiling(page.WidthMm * pxPerMm));
        var heightPx = Math.Max(1, (int)Math.Ceiling(page.HeightMm * pxPerMm));

        using var surface = SKSurface.Create(new SKImageInfo(widthPx, heightPx, SKColorType.Rgba8888, SKAlphaType.Premul));
        var canvas = surface.Canvas;
        canvas.Clear(SKColors.White);
        canvas.Scale((float)pxPerMm);

        foreach (var node in page.Nodes)
        {
            cancellationToken.ThrowIfCancellationRequested();
            switch (node)
            {
                case RectangleDrawNode rect:
                    if (!string.IsNullOrWhiteSpace(rect.FillColor) && SKColor.TryParse(rect.FillColor, out var fill))
                    {
                        using var paint = new SKPaint { Color = fill, Style = SKPaintStyle.Fill };
                        canvas.DrawRect((float)rect.Bounds.X, (float)rect.Bounds.Y, (float)rect.Bounds.Width, (float)rect.Bounds.Height, paint);
                    }
                    if (!string.IsNullOrWhiteSpace(rect.StrokeColor) && SKColor.TryParse(rect.StrokeColor, out var stroke))
                    {
                        using var paint = new SKPaint { Color = stroke, Style = SKPaintStyle.Stroke, StrokeWidth = (float)rect.StrokeWidthMm };
                        canvas.DrawRect((float)rect.Bounds.X, (float)rect.Bounds.Y, (float)rect.Bounds.Width, (float)rect.Bounds.Height, paint);
                    }
                    break;
                case LineDrawNode line:
                    SKColor.TryParse(line.Color, out var lineColor);
                    using (var paint = new SKPaint { Color = lineColor, StrokeWidth = (float)line.ThicknessMm })
                        canvas.DrawLine((float)line.X1, (float)line.Y1, (float)line.X2, (float)line.Y2, paint);
                    break;
                case QrCodeDrawNode qr:
                    SkiaVectorHelpers.DrawQrCode(canvas, qr.Payload, qr.Bounds);
                    break;
                case ImageDrawNode img:
                    SkiaVectorHelpers.DrawDataUriImage(canvas, img.DataUri, img.Bounds);
                    break;
                case TextDrawNode text:
                    var typeface = _fontPolicy.ResolveTypeface(text.Style.FontFamily, text.Style.FontWeight);
                    SKColor.TryParse(text.Style.Color, out var textColor);
                    using (var font = new SKFont(typeface, (float)(text.Style.FontSizePt * 0.352778)))
                    using (var shaper = new SKShaper(typeface))
                    using (var paint = new SKPaint { Color = textColor, IsAntialias = true })
                    {
                        SkiaVectorHelpers.DrawTextLines(canvas, font, paint, text.Bounds, text.Text, text.Style.Align, shaper);
                    }
                    break;
            }
        }

        using var image = surface.Snapshot();
        using var encoded = image.Encode(SKEncodedImageFormat.Png, 100);
        encoded.SaveTo(output);
        return Task.CompletedTask;
    }
}
