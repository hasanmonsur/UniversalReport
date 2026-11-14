using UniversalReport;
using UniversalReport.Core;

const string template = """
{
  "schemaVersion": "1.0",
  "reportId": "console-quickstart",
  "title": "Console Quickstart Ledger",
  "page": { "size": "A4", "unit": "mm", "orientation": "Portrait" },
  "bands": [
    {
      "type": "ReportHeader",
      "height": 18,
      "elements": [{ "type": "Text", "value": "UniversalReport Console Quickstart", "fontSizePt": 14, "fontWeight": "Bold" }]
    },
    {
      "type": "Detail",
      "dataset": "Items",
      "elements": [
        {
          "type": "Table",
          "columns": [
            { "header": "SKU", "expression": "=Fields.Sku", "width": 50 },
            { "header": "Qty", "expression": "=Fields.Qty", "width": 30, "align": "Right" },
            { "header": "Total", "expression": "=Fields.Qty * Fields.UnitPrice", "width": 40, "align": "Right", "format": "N2" }
          ]
        }
      ]
    }
  ]
}
""";

var report = UniversalReportEngine.CreateFromJson(template);
report.SetDataSource("Items", new[]
{
    new { Sku = "UR-CORE-100", Qty = 4, UnitPrice = 250.00m },
    new { Sku = "UR-PDF-200", Qty = 2, UnitPrice = 475.50m }
});

byte[] pdf = await report.RenderAsync(ReportFormat.Pdf);
byte[] csv = await report.RenderAsync(ReportFormat.Csv);
await File.WriteAllBytesAsync("quickstart.pdf", pdf);
await File.WriteAllBytesAsync("quickstart.csv", csv);
Console.WriteLine($"Generated quickstart.pdf ({pdf.Length} bytes) and quickstart.csv ({csv.Length} bytes).");
