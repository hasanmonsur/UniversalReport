using System.Globalization;
using UniversalReport.Core;
using UniversalReport.Data;
using UniversalReport.Definitions;
using UniversalReport.Expressions;

namespace UniversalReport.Layout;

public sealed class ReportEnginePipeline(IEnumerable<IReportRenderer> renderers) : IReportEnginePipeline
{
    private readonly Dictionary<ReportFormat, IReportRenderer> _renderers =
        renderers.ToDictionary(r => r.Format, r => r);

    public RenderDocument BuildDocument(
        string templateJson,
        IReadOnlyDictionary<string, IReadOnlyList<ReportRow>> dataSources,
        IReadOnlyDictionary<string, object?> parameters,
        RenderOptions options)
    {
        var (definition, errors, contentHash) = UReportLoader.ParseAndValidate(templateJson);
        if (definition is null || errors.Count > 0)
            throw new ReportValidationException(errors);

        var (pageWidthMm, pageHeightMm) = definition.Page.ResolveDimensionsMm();
        var margins = definition.Page.Margins;
        var printableWidthMm = pageWidthMm - margins.Left - margins.Right;
        var evalCtx = new RequestEvaluationContext(dataSources, parameters);

        var pageHeaderBand = definition.Bands.FirstOrDefault(b => b.Type.Equals("PageHeader", StringComparison.OrdinalIgnoreCase));
        var pageFooterBand = definition.Bands.FirstOrDefault(b => b.Type.Equals("PageFooter", StringComparison.OrdinalIgnoreCase));
        var pageHeaderHeight = pageHeaderBand?.Height ?? (pageHeaderBand is null ? 0 : 12);
        var pageFooterHeight = pageFooterBand?.Height ?? (pageFooterBand is null ? 0 : 12);

        var contentTopMm = margins.Top + pageHeaderHeight;
        var contentBottomMm = pageHeightMm - margins.Bottom - pageFooterHeight;

        var draftPages = new List<List<PositionedDrawNode>>();
        var semanticTables = new List<SemanticTable>();

        var currentNodes = new List<PositionedDrawNode>();
        draftPages.Add(currentNodes);
        var cursorY = contentTopMm;

        void NewPage()
        {
            currentNodes = new List<PositionedDrawNode>();
            draftPages.Add(currentNodes);
            cursorY = contentTopMm;
        }

        var groupHeaderBand = definition.Bands.FirstOrDefault(b => b.Type.Equals("GroupHeader", StringComparison.OrdinalIgnoreCase));
        var groupFooterBand = definition.Bands.FirstOrDefault(b => b.Type.Equals("GroupFooter", StringComparison.OrdinalIgnoreCase));

        for (var bIdx = 0; bIdx < definition.Bands.Count; bIdx++)
        {
            var band = definition.Bands[bIdx];
            if (band.Type.Equals("PageHeader", StringComparison.OrdinalIgnoreCase) ||
                band.Type.Equals("PageFooter", StringComparison.OrdinalIgnoreCase) ||
                band.Type.Equals("GroupHeader", StringComparison.OrdinalIgnoreCase) ||
                band.Type.Equals("GroupFooter", StringComparison.OrdinalIgnoreCase))
                continue;

            var bandHeight = band.Height ?? 18.0;
            if (!band.Type.Equals("Detail", StringComparison.OrdinalIgnoreCase))
            {
                if (cursorY + bandHeight > contentBottomMm) NewPage();
                RenderStaticBandElements(band, margins.Left, cursorY, printableWidthMm, evalCtx, options, currentNodes);
                cursorY += bandHeight;
                continue;
            }

            var allRows = !string.IsNullOrWhiteSpace(band.Dataset) && dataSources.TryGetValue(band.Dataset, out var ds)
                ? ds
                : Array.Empty<ReportRow>();

            var groupField = band.GroupBy ?? groupHeaderBand?.GroupBy;
            var groups = string.IsNullOrWhiteSpace(groupField)
                ? [new KeyValuePair<string, IReadOnlyList<ReportRow>>("__all__", allRows)]
                : allRows
                    .GroupBy(r => Convert.ToString(r[groupField], CultureInfo.InvariantCulture) ?? "(Empty)")
                    .Select(g => new KeyValuePair<string, IReadOnlyList<ReportRow>>(g.Key, g.ToList()))
                    .ToList();

            var allSemanticRows = new List<IReadOnlyList<object?>>();
            IReadOnlyList<SemanticTableColumn>? tableColumnsMeta = null;

            foreach (var group in groups)
            {
                var rows = group.Value;
                evalCtx.SetGroupScope(band.Dataset ?? string.Empty, rows);

                if (groupHeaderBand is not null)
                {
                    var ghH = groupHeaderBand.Height ?? 10.0;
                    if (cursorY + ghH > contentBottomMm) NewPage();
                    RenderStaticBandElements(groupHeaderBand, margins.Left, cursorY, printableWidthMm, evalCtx, options, currentNodes);
                    cursorY += ghH;
                }

                foreach (var element in band.Elements)
                {
                    if (!element.Type.Equals("Table", StringComparison.OrdinalIgnoreCase))
                    {
                        for (var r = 0; r < rows.Count; r++)
                        {
                            evalCtx.SetRow(band.Dataset ?? string.Empty, rows[r], r, rows);
                            var elH = element.Height ?? 8.0;
                            if (cursorY + elH > contentBottomMm) NewPage();
                            RenderElement(element, margins.Left + element.X, cursorY + element.Y, element.Width ?? printableWidthMm, elH, evalCtx, options, currentNodes);
                            cursorY += elH;
                        }
                        continue;
                    }

                    var cols = element.Columns;
                    if (cols.Count == 0) continue;

                    tableColumnsMeta ??= cols.Select(c => new SemanticTableColumn(c.Header, c.Align ?? "Left", c.Format)).ToList();

                    var totalSpecWidth = cols.Sum(c => c.Width ?? (printableWidthMm / cols.Count));
                    var scale = totalSpecWidth > 0 ? printableWidthMm / totalSpecWidth : 1.0;
                    var colWidths = cols.Select(c => (c.Width ?? (printableWidthMm / cols.Count)) * scale).ToArray();
                    const double headerH = 7.5;
                    const double rowH = 6.5;

                    void DrawTableHeader()
                    {
                        var x = margins.Left;
                        currentNodes.Add(new RectangleDrawNode(new RectD(x, cursorY, printableWidthMm, headerH), "#0F172A", "#0F172A", 0.2));
                        for (var c = 0; c < cols.Count; c++)
                        {
                            currentNodes.Add(new TextDrawNode(
                                new RectD(x + 1.5, cursorY + 1.5, colWidths[c] - 3.0, headerH - 3.0),
                                cols[c].Header,
                                new TextDrawStyle(options.DefaultFontFamily, 8.5, "Bold", "#FFFFFF", cols[c].Align ?? "Left")));
                            x += colWidths[c];
                        }
                        cursorY += headerH;
                    }

                    if (cursorY + headerH + rowH > contentBottomMm) NewPage();
                    DrawTableHeader();

                    for (var r = 0; r < rows.Count; r++)
                    {
                        evalCtx.SetRow(band.Dataset ?? string.Empty, rows[r], r, rows);
                        var cellTexts = new string[cols.Count];
                        var cellColors = new string[cols.Count];
                        var cellBgs = new string?[cols.Count];
                        var maxLines = 1;

                        var rowValues = new List<object?>(cols.Count);
                        for (var c = 0; c < cols.Count; c++)
                        {
                            var compiled = ExpressionCompiler.Compile(cols[c].Expression);
                            var rawVal = ExpressionCompiler.Evaluate(compiled, evalCtx);
                            rowValues.Add(rawVal);

                            var formatted = FormatValue(rawVal, cols[c].Format);
                            if (cols[c].CanGrow)
                            {
                                var wrapped = WrapText(formatted, Math.Max(4.0, colWidths[c] - 3.0), 8.5);
                                cellTexts[c] = string.Join('\n', wrapped);
                                if (wrapped.Count > maxLines) maxLines = wrapped.Count;
                            }
                            else
                            {
                                cellTexts[c] = formatted;
                            }

                            cellColors[c] = EvaluateColor(cols[c].ColorExpression, "#0F172A", evalCtx);
                            cellBgs[c] = EvaluateOptionalColor(cols[c].BackgroundColorExpression, evalCtx);
                        }

                        var dynamicRowH = Math.Max(rowH, maxLines * 3.8 + 2.4);
                        if (cursorY + dynamicRowH > contentBottomMm)
                        {
                            NewPage();
                            if (element.RepeatHeaders ?? true) DrawTableHeader();
                        }

                        var x = margins.Left;
                        if (r % 2 == 1)
                        {
                            currentNodes.Add(new RectangleDrawNode(new RectD(x, cursorY, printableWidthMm, dynamicRowH), "#F8FAFC", "#E2E8F0", 0.1));
                        }

                        for (var c = 0; c < cols.Count; c++)
                        {
                            if (!string.IsNullOrWhiteSpace(cellBgs[c]))
                            {
                                currentNodes.Add(new RectangleDrawNode(new RectD(x, cursorY, colWidths[c], dynamicRowH), cellBgs[c], null, 0));
                            }
                            currentNodes.Add(new TextDrawNode(
                                new RectD(x + 1.5, cursorY + 1.2, colWidths[c] - 3.0, dynamicRowH - 2.4),
                                cellTexts[c],
                                new TextDrawStyle(options.DefaultFontFamily, 8.5, "Normal", cellColors[c], cols[c].Align ?? "Left")));
                            x += colWidths[c];
                        }

                        allSemanticRows.Add(rowValues);
                        cursorY += dynamicRowH;
                    }
                }

                if (groupFooterBand is not null)
                {
                    evalCtx.SetGroupScope(band.Dataset ?? string.Empty, rows);
                    var gfH = groupFooterBand.Height ?? 10.0;
                    if (cursorY + gfH > contentBottomMm) NewPage();
                    RenderStaticBandElements(groupFooterBand, margins.Left, cursorY, printableWidthMm, evalCtx, options, currentNodes);
                    cursorY += gfH;
                }
            }

            if (tableColumnsMeta is not null)
            {
                IReadOnlyList<object?>? summaryRow = null;
                var detailTableCols = band.Elements
                    .FirstOrDefault(e => e.Type.Equals("Table", StringComparison.OrdinalIgnoreCase))?.Columns;
                if (detailTableCols is not null && detailTableCols.Any(c => !string.IsNullOrWhiteSpace(c.Summary)))
                {
                    var sums = new object?[detailTableCols.Count];
                    for (var c = 0; c < detailTableCols.Count; c++)
                    {
                        var op = detailTableCols[c].Summary;
                        if (string.IsNullOrWhiteSpace(op))
                        {
                            sums[c] = c == 0 ? "Total" : null;
                            continue;
                        }
                        if (op.Equals("Count", StringComparison.OrdinalIgnoreCase))
                        {
                            sums[c] = allSemanticRows.Count;
                        }
                        else if (op.Equals("Sum", StringComparison.OrdinalIgnoreCase) || op.Equals("Avg", StringComparison.OrdinalIgnoreCase))
                        {
                            decimal total = 0m;
                            foreach (var r in allSemanticRows)
                                total += RequestEvaluationContext.ToDecimal(r[c]);
                            sums[c] = op.Equals("Avg", StringComparison.OrdinalIgnoreCase) && allSemanticRows.Count > 0
                                ? Math.Round(total / allSemanticRows.Count, 2)
                                : total;
                        }
                    }
                    summaryRow = sums;

                    var specWidths = detailTableCols.Select(c => c.Width ?? (printableWidthMm / detailTableCols.Count)).ToArray();
                    var specSum = specWidths.Sum();
                    var scale = specSum > 0 ? printableWidthMm / specSum : 1.0;
                    const double summaryH = 7.0;
                    if (cursorY + summaryH > contentBottomMm) NewPage();
                    var sx = margins.Left;
                    currentNodes.Add(new RectangleDrawNode(new RectD(sx, cursorY, printableWidthMm, summaryH), "#F1F5F9", "#CBD5E1", 0.2));
                    for (var c = 0; c < detailTableCols.Count; c++)
                    {
                        var cw = specWidths[c] * scale;
                        var text = FormatValue(sums[c], detailTableCols[c].Format);
                        currentNodes.Add(new TextDrawNode(
                            new RectD(sx + 1.5, cursorY + 1.5, cw - 3.0, summaryH - 3.0),
                            text,
                            new TextDrawStyle(options.DefaultFontFamily, 8.5, "Bold", "#0F172A", detailTableCols[c].Align ?? "Left")));
                        sx += cw;
                    }
                    cursorY += summaryH;
                }

                semanticTables.Add(new SemanticTable(band.Dataset ?? "Table", tableColumnsMeta, allSemanticRows, summaryRow));
            }
        }

        // Resolve PageHeader, Watermark & PageFooter with canonical TotalPages
        var totalPages = draftPages.Count;
        var pages = new List<RenderPage>(totalPages);
        for (var p = 0; p < totalPages; p++)
        {
            evalCtx.SetPageInfo(p + 1, totalPages);
            var nodes = new List<PositionedDrawNode>();
            if (!string.IsNullOrWhiteSpace(definition.Page.Watermark))
            {
                nodes.Add(new TextDrawNode(
                    new RectD(margins.Left, pageHeightMm * 0.45, printableWidthMm, 18),
                    definition.Page.Watermark!,
                    new TextDrawStyle(options.DefaultFontFamily, 32, "Bold", "#E2E8F0", "Center")));
            }
            nodes.AddRange(draftPages[p]);
            if (pageHeaderBand is not null)
                RenderStaticBandElements(pageHeaderBand, margins.Left, margins.Top, printableWidthMm, evalCtx, options, nodes);
            if (pageFooterBand is not null)
                RenderStaticBandElements(pageFooterBand, margins.Left, pageHeightMm - margins.Bottom - pageFooterHeight, printableWidthMm, evalCtx, options, nodes);

            pages.Add(new RenderPage(p + 1, pageWidthMm, pageHeightMm, nodes));
        }

        return new RenderDocument(
            definition.ReportId,
            options.TitleOverride ?? definition.Title ?? definition.ReportId,
            contentHash,
            pageWidthMm,
            pageHeightMm,
            pages,
            semanticTables);
    }

    public async Task<byte[]> ExportAsync(
        RenderDocument document,
        ReportFormat format,
        RenderOptions options,
        CancellationToken cancellationToken = default)
    {
        if (!_renderers.TryGetValue(format, out var renderer))
            throw new NotSupportedException($"No IReportRenderer registered for format '{format}'.");

        await using var ms = new MemoryStream();
        await renderer.RenderAsync(document, ms, options, cancellationToken);
        return ms.ToArray();
    }

    private static void RenderStaticBandElements(
        BandDefinition band,
        double originX,
        double originY,
        double availableW,
        RequestEvaluationContext ctx,
        RenderOptions options,
        List<PositionedDrawNode> nodes)
    {
        foreach (var el in band.Elements)
            RenderElement(el, originX + el.X, originY + el.Y, el.Width ?? availableW, el.Height ?? 6.0, ctx, options, nodes);
    }

    private static void RenderElement(
        ElementDefinition el,
        double x,
        double y,
        double w,
        double h,
        RequestEvaluationContext ctx,
        RenderOptions options,
        List<PositionedDrawNode> nodes)
    {
        var bounds = new RectD(x, y, w, h);
        switch (el.Type.ToLowerInvariant())
        {
            case "line":
                nodes.Add(new LineDrawNode(bounds, x, y, x + w, y, el.Color ?? "#CBD5E1", 0.3));
                break;
            case "rectangle":
                nodes.Add(new RectangleDrawNode(bounds, el.BackgroundColor, el.BorderColor ?? "#CBD5E1", 0.25));
                break;
            case "image":
                var imgSrc = el.Value ?? string.Empty;
                if (imgSrc.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase))
                {
                    nodes.Add(new ImageDrawNode(bounds, imgSrc));
                }
                break;
            case "qrcode":
                var qrRaw = el.Expression is not null
                    ? ExpressionCompiler.Evaluate(ExpressionCompiler.Compile(el.Expression), ctx)
                    : el.Value;
                nodes.Add(new QrCodeDrawNode(bounds, Convert.ToString(qrRaw, CultureInfo.InvariantCulture) ?? string.Empty));
                break;
            default:
                var expr = el.Expression ?? el.Value ?? string.Empty;
                var val = expr.StartsWith('=')
                    ? ExpressionCompiler.Evaluate(ExpressionCompiler.Compile(expr), ctx)
                    : expr;
                var text = FormatValue(val, el.Format);
                var fontPt = el.FontSizePt ?? 9.5;
                var finalH = h;
                if (el.CanGrow)
                {
                    var wrapped = WrapText(text, Math.Max(4.0, w), fontPt);
                    text = string.Join('\n', wrapped);
                    finalH = Math.Max(h, wrapped.Count * (fontPt * 0.45) + 1.2);
                }
                var textColor = EvaluateColor(el.ColorExpression, el.Color ?? "#0F172A", ctx);
                var bgColor = EvaluateOptionalColor(el.BackgroundColorExpression, ctx) ?? el.BackgroundColor;
                if (!string.IsNullOrWhiteSpace(bgColor))
                {
                    nodes.Add(new RectangleDrawNode(new RectD(x, y, w, finalH), bgColor, null, 0));
                }
                nodes.Add(new TextDrawNode(new RectD(x, y, w, finalH), text, new TextDrawStyle(
                    options.DefaultFontFamily,
                    fontPt,
                    el.FontWeight ?? "Normal",
                    textColor,
                    el.Align ?? "Left")));
                break;
        }
    }

    private static string EvaluateColor(string? colorExpression, string fallback, RequestEvaluationContext ctx)
    {
        var evaluated = EvaluateOptionalColor(colorExpression, ctx);
        return string.IsNullOrWhiteSpace(evaluated) ? fallback : evaluated;
    }

    private static string? EvaluateOptionalColor(string? colorExpression, RequestEvaluationContext ctx)
    {
        if (string.IsNullOrWhiteSpace(colorExpression)) return null;
        if (!colorExpression.StartsWith('=')) return colorExpression;
        var res = ExpressionCompiler.Evaluate(ExpressionCompiler.Compile(colorExpression), ctx);
        return Convert.ToString(res, CultureInfo.InvariantCulture);
    }

    private static List<string> WrapText(string text, double maxWidthMm, double fontSizePt)
    {
        if (string.IsNullOrEmpty(text)) return [string.Empty];
        var approxCharMm = Math.Max(0.8, fontSizePt * 0.21);
        var maxChars = Math.Max(4, (int)Math.Floor(maxWidthMm / approxCharMm));
        var lines = new List<string>();
        foreach (var paragraph in text.Split('\n'))
        {
            var words = paragraph.Split(' ');
            var current = string.Empty;
            foreach (var word in words)
            {
                if (current.Length == 0)
                {
                    current = word;
                }
                else if (current.Length + 1 + word.Length <= maxChars)
                {
                    current += " " + word;
                }
                else
                {
                    lines.Add(current);
                    current = word;
                }
                while (current.Length > maxChars)
                {
                    lines.Add(current[..maxChars]);
                    current = current[maxChars..];
                }
            }
            lines.Add(current);
        }
        return lines;
    }

    private static string FormatValue(object? val, string? format)
    {
        if (val is null) return string.Empty;
        if (!string.IsNullOrWhiteSpace(format))
        {
            if (val is IFormattable fmt) return fmt.ToString(format, CultureInfo.InvariantCulture);
            if (val is decimal d) return d.ToString(format, CultureInfo.InvariantCulture);
        }
        return Convert.ToString(val, CultureInfo.InvariantCulture) ?? string.Empty;
    }
}
