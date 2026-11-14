using System.Globalization;
using System.Net;
using System.Text;
using UniversalReport.Core;

namespace UniversalReport.Export.Html;

public sealed class HtmlReportRenderer : IReportRenderer
{
    public ReportFormat Format => ReportFormat.Html;

    public async Task RenderAsync(
        RenderDocument document,
        Stream output,
        RenderOptions options,
        CancellationToken cancellationToken = default)
    {
        var sb = new StringBuilder();
        sb.AppendLine("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\" />");
        sb.AppendLine($"<title>{WebUtility.HtmlEncode(document.Title)}</title>");
        sb.AppendLine("<style>body{font-family:'Noto Sans',system-ui,sans-serif;background:#f8fafc;color:#0f172a;padding:24px;} .page{position:relative;background:#fff;margin:0 auto 24px;border:1px solid #cbd5e1;box-shadow:0 2px 8px rgba(15,23,42,.06);} .node{position:absolute;box-sizing:border-box;overflow:hidden;}</style>");
        sb.AppendLine("</head><body>");

        foreach (var page in document.Pages)
        {
            cancellationToken.ThrowIfCancellationRequested();
            sb.AppendLine($"<section class=\"page\" style=\"width:{page.WidthMm.ToString(CultureInfo.InvariantCulture)}mm;height:{page.HeightMm.ToString(CultureInfo.InvariantCulture)}mm;\">");
            foreach (var node in page.Nodes)
            {
                switch (node)
                {
                    case RectangleDrawNode rect:
                        sb.AppendLine($"<div class=\"node\" style=\"left:{rect.Bounds.X.ToString(CultureInfo.InvariantCulture)}mm;top:{rect.Bounds.Y.ToString(CultureInfo.InvariantCulture)}mm;width:{rect.Bounds.Width.ToString(CultureInfo.InvariantCulture)}mm;height:{rect.Bounds.Height.ToString(CultureInfo.InvariantCulture)}mm;background:{rect.FillColor ?? "transparent"};border:0.25mm solid {rect.StrokeColor ?? "transparent"};\"></div>");
                        break;
                    case LineDrawNode line:
                        sb.AppendLine($"<div class=\"node\" style=\"left:{line.X1.ToString(CultureInfo.InvariantCulture)}mm;top:{line.Y1.ToString(CultureInfo.InvariantCulture)}mm;width:{Math.Max(0.2, line.X2 - line.X1).ToString(CultureInfo.InvariantCulture)}mm;height:{line.ThicknessMm.ToString(CultureInfo.InvariantCulture)}mm;background:{line.Color};\"></div>");
                        break;
                    case ImageDrawNode img:
                        sb.AppendLine($"<img class=\"node\" alt=\"Embedded Report Image\" src=\"{WebUtility.HtmlEncode(img.DataUri)}\" style=\"left:{img.Bounds.X.ToString(CultureInfo.InvariantCulture)}mm;top:{img.Bounds.Y.ToString(CultureInfo.InvariantCulture)}mm;width:{img.Bounds.Width.ToString(CultureInfo.InvariantCulture)}mm;height:{img.Bounds.Height.ToString(CultureInfo.InvariantCulture)}mm;object-fit:contain;\" />");
                        break;
                    case QrCodeDrawNode qr:
                        sb.AppendLine($"<div class=\"node\" title=\"{WebUtility.HtmlEncode(qr.Payload)}\" style=\"left:{qr.Bounds.X.ToString(CultureInfo.InvariantCulture)}mm;top:{qr.Bounds.Y.ToString(CultureInfo.InvariantCulture)}mm;width:{qr.Bounds.Width.ToString(CultureInfo.InvariantCulture)}mm;height:{qr.Bounds.Height.ToString(CultureInfo.InvariantCulture)}mm;border:0.3mm solid #0f172a;display:flex;align-items:center;justify-content:center;font-size:6pt;font-family:monospace;background:#fff;\">QR</div>");
                        break;
                    case TextDrawNode text:
                        var align = text.Style.Align.ToLowerInvariant();
                        var weight = text.Style.FontWeight.Equals("Bold", StringComparison.OrdinalIgnoreCase) ? "700" : "400";
                        sb.AppendLine($"<div class=\"node\" style=\"left:{text.Bounds.X.ToString(CultureInfo.InvariantCulture)}mm;top:{text.Bounds.Y.ToString(CultureInfo.InvariantCulture)}mm;width:{text.Bounds.Width.ToString(CultureInfo.InvariantCulture)}mm;height:{text.Bounds.Height.ToString(CultureInfo.InvariantCulture)}mm;font-size:{text.Style.FontSizePt.ToString(CultureInfo.InvariantCulture)}pt;font-weight:{weight};color:{text.Style.Color};text-align:{align};white-space:pre-wrap;line-height:1.25;\">{WebUtility.HtmlEncode(text.Text)}</div>");
                        break;
                }
            }
            sb.AppendLine("</section>");
        }

        sb.AppendLine("</body></html>");
        var bytes = Encoding.UTF8.GetBytes(sb.ToString());
        await output.WriteAsync(bytes, cancellationToken);
    }
}

public sealed class CsvReportRenderer : IReportRenderer
{
    public ReportFormat Format => ReportFormat.Csv;

    public static string EscapeCsvCell(object? value, bool neutralizeFormulas)
    {
        var raw = Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty;
        if (neutralizeFormulas && raw.Length > 0 && raw[0] is '=' or '+' or '-' or '@' or '\t' or '\r')
        {
            raw = "'" + raw;
        }
        return $"\"{raw.Replace("\"", "\"\"")}\"";
    }

    public async Task RenderAsync(
        RenderDocument document,
        Stream output,
        RenderOptions options,
        CancellationToken cancellationToken = default)
    {
        var sb = new StringBuilder();
        var table = document.SemanticTables.FirstOrDefault();
        if (table is not null)
        {
            sb.AppendLine(string.Join(",", table.Columns.Select(c => EscapeCsvCell(c.Header, options.NeutralizeSpreadsheetFormulas))));
            foreach (var row in table.Rows)
            {
                cancellationToken.ThrowIfCancellationRequested();
                sb.AppendLine(string.Join(",", row.Select(v => EscapeCsvCell(v, options.NeutralizeSpreadsheetFormulas))));
            }
        }

        var preamble = Encoding.UTF8.GetPreamble();
        await output.WriteAsync(preamble, cancellationToken);
        var bytes = Encoding.UTF8.GetBytes(sb.ToString());
        await output.WriteAsync(bytes, cancellationToken);
    }
}
