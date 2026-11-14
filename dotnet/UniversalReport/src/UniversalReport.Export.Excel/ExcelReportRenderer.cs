using System.Globalization;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Spreadsheet;
using UniversalReport.Core;

namespace UniversalReport.Export.Excel;

public sealed class ExcelReportRenderer : IReportRenderer
{
    public ReportFormat Format => ReportFormat.Excel;

    public static string SanitizeSpreadsheetCell(string value)
    {
        if (string.IsNullOrEmpty(value)) return value;
        var first = value[0];
        return first is '=' or '+' or '-' or '@' or '\t' or '\r' ? $"'{value}" : value;
    }

    public Task RenderAsync(
        RenderDocument document,
        Stream output,
        RenderOptions options,
        CancellationToken cancellationToken = default)
    {
        using var spreadsheet = SpreadsheetDocument.Create(output, SpreadsheetDocumentType.Workbook, true);
        var workbookPart = spreadsheet.AddWorkbookPart();
        workbookPart.Workbook = new Workbook();
        var sheets = workbookPart.Workbook.AppendChild(new Sheets());

        if (document.SemanticTables.Count == 0)
        {
            var worksheetPart = workbookPart.AddNewPart<WorksheetPart>();
            var sheetData = new SheetData();
            worksheetPart.Worksheet = new Worksheet(sheetData);
            sheets.Append(new Sheet
            {
                Id = workbookPart.GetIdOfPart(worksheetPart),
                SheetId = 1,
                Name = "Report"
            });
            var titleRow = new Row();
            titleRow.Append(new Cell
            {
                DataType = CellValues.String,
                CellValue = new CellValue(options.NeutralizeSpreadsheetFormulas ? SanitizeSpreadsheetCell(document.Title) : document.Title)
            });
            sheetData.Append(titleRow);
        }

        uint sheetId = 1;
        foreach (var table in document.SemanticTables)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var worksheetPart = workbookPart.AddNewPart<WorksheetPart>();
            var sheetData = new SheetData();
            worksheetPart.Worksheet = new Worksheet(sheetData);

            sheets.Append(new Sheet
            {
                Id = workbookPart.GetIdOfPart(worksheetPart),
                SheetId = sheetId++,
                Name = string.IsNullOrWhiteSpace(table.DatasetName) ? $"Sheet{sheetId}" : table.DatasetName[..Math.Min(31, table.DatasetName.Length)]
            });

            var headerRow = new Row();
            foreach (var col in table.Columns)
            {
                headerRow.Append(new Cell
                {
                    DataType = CellValues.String,
                    CellValue = new CellValue(options.NeutralizeSpreadsheetFormulas ? SanitizeSpreadsheetCell(col.Header) : col.Header)
                });
            }
            sheetData.Append(headerRow);

            foreach (var row in table.Rows)
            {
                sheetData.Append(BuildDataRow(row, options.NeutralizeSpreadsheetFormulas));
            }

            if (table.SummaryRow is not null)
            {
                sheetData.Append(BuildDataRow(table.SummaryRow, options.NeutralizeSpreadsheetFormulas));
            }
        }

        workbookPart.Workbook.Save();
        return Task.CompletedTask;
    }

    private static Row BuildDataRow(IReadOnlyList<object?> values, bool neutralizeFormulas)
    {
        var xlRow = new Row();
        foreach (var val in values)
        {
            if (val is decimal or int or long or double or float)
            {
                xlRow.Append(new Cell
                {
                    DataType = CellValues.Number,
                    CellValue = new CellValue(Convert.ToDecimal(val, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture))
                });
            }
            else
            {
                var str = Convert.ToString(val, CultureInfo.InvariantCulture) ?? string.Empty;
                if (neutralizeFormulas) str = SanitizeSpreadsheetCell(str);
                xlRow.Append(new Cell { DataType = CellValues.String, CellValue = new CellValue(str) });
            }
        }
        return xlRow;
    }
}
