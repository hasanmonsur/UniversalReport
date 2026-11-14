using System.Data;
using UniversalReport;
using UniversalReport.Core;
using UniversalReport.Data;
using UniversalReport.Data.Adapters;
using UniversalReport.Export.Excel;
using UniversalReport.Export.Html;
using UniversalReport.Expressions;
using UniversalReport.Layout;
using UniversalReport.Rdlc;
using Xunit;

namespace UniversalReport.UnitTests;

public sealed class EngineTests
{
    [Fact]
    public void ExpressionCompiler_BlocksArbitraryReflectionOrDisallowedFunctions()
    {
        Assert.Throws<ExpressionSecurityException>(() =>
            ExpressionCompiler.Compile("=System.Reflection.Assembly.GetExecutingAssembly()"));
        Assert.Throws<ExpressionSecurityException>(() =>
            ExpressionCompiler.Compile("=ShellExec(\"ls\")"));
    }

    [Fact]
    public void ExpressionEvaluator_ComputesDecimalFinancialTotalsAndConditionals()
    {
        var rows = new List<ReportRow>
        {
            new(new Dictionary<string, object?> { ["Debit"] = 125.50m, ["Credit"] = 0m, ["Balance"] = -125.50m }),
            new(new Dictionary<string, object?> { ["Debit"] = 0m, ["Credit"] = 500.00m, ["Balance"] = 374.50m })
        };
        var ctx = new RequestEvaluationContext(
            new Dictionary<string, IReadOnlyList<ReportRow>> { ["Transactions"] = rows },
            new Dictionary<string, object?> { ["AccountNo"] = "1040-001" });

        ctx.SetRow("Transactions", rows[0], 0);
        var status0 = ExpressionCompiler.Evaluate(
            ExpressionCompiler.Compile("=IIf(Fields.Balance < 0, \"Overdrawn\", \"Normal\")"), ctx);
        Assert.Equal("Overdrawn", status0);

        var totalDebit = ExpressionCompiler.Evaluate(
            ExpressionCompiler.Compile("=Sum(Fields.Debit, \"Transactions\")"), ctx);
        Assert.Equal(125.50m, totalDebit);
    }

    [Fact]
    public void SpreadsheetExport_NeutralizesFormulaInjectionPayloads()
    {
        Assert.Equal("'=CMD|' /C calc'!A0", ExcelReportRenderer.SanitizeSpreadsheetCell("=CMD|' /C calc'!A0"));
        Assert.Equal("\"'=1+1\"", CsvReportRenderer.EscapeCsvCell("=1+1", neutralizeFormulas: true));
    }

    [Fact]
    public void UniversalDataAdapters_BindDataTableJsonAndCsvCorrectly()
    {
        var template = """
        {
          "schemaVersion": "1.0",
          "reportId": "adapter-test",
          "page": { "size": "A4", "unit": "mm", "orientation": "Portrait" },
          "bands": [
            {
              "type": "Detail",
              "dataset": "Items",
              "elements": [
                {
                  "type": "Table",
                  "columns": [
                    { "header": "Code", "expression": "=Fields.Code" },
                    { "header": "Amount", "expression": "=Fields.Amount", "align": "Right" }
                  ]
                }
              ]
            }
          ]
        }
        """;

        // 1. DataTable binding
        var table = new DataTable("Items");
        table.Columns.Add("Code", typeof(string));
        table.Columns.Add("Amount", typeof(decimal));
        table.Rows.Add("INV-100", 250.75m);

        var report = UniversalReportEngine.CreateFromJson(template);
        report.SetDataSource("Items", table);
        var doc1 = report.BuildDocument();
        Assert.Single(doc1.SemanticTables[0].Rows);
        Assert.Equal(250.75m, doc1.SemanticTables[0].Rows[0][1]);

        // 2. JSON binding
        report.SetJsonDataSource("Items", "{\"data\":{\"rows\":[{\"Code\":\"INV-200\",\"Amount\":99.50}]}}", "data.rows");
        var doc2 = report.BuildDocument();
        Assert.Equal("INV-200", doc2.SemanticTables[0].Rows[0][0]);

        // 3. CSV binding
        report.SetCsvDataSource("Items", "Code,Amount\n\"INV-300\",410.25");
        var doc3 = report.BuildDocument();
        Assert.Equal("INV-300", doc3.SemanticTables[0].Rows[0][0]);
        Assert.Equal(410.25m, doc3.SemanticTables[0].Rows[0][1]);
    }

    [Fact]
    public void AdoNetDataProvider_RejectsMutatingSqlStatements()
    {
        var provider = new AdoNetDataProvider("Sqlite", () => throw new NotImplementedException());
        Assert.Throws<InvalidOperationException>(() =>
            provider.RegisterAllowlistedQuery(new AllowlistedSqlQuery("BadQuery", "DELETE FROM Accounts")));
    }

    [Fact]
    public void LayoutEngine_PaginatesMultiPageReportWithCanonicalPageNumbers()
    {
        var template = """
        {
          "schemaVersion": "1.0",
          "reportId": "statement-test",
          "page": { "size": "A4", "unit": "mm", "orientation": "Portrait" },
          "bands": [
            { "type": "PageHeader", "height": 12, "elements": [{ "type": "Text", "value": "Statement Header" }] },
            {
              "type": "Detail",
              "dataset": "Transactions",
              "elements": [
                {
                  "type": "Table",
                  "repeatHeaders": true,
                  "columns": [
                    { "header": "Ref", "expression": "=Fields.Ref" },
                    { "header": "Debit", "expression": "=Fields.Debit", "align": "Right" }
                  ]
                }
              ]
            },
            { "type": "PageFooter", "height": 10, "elements": [{ "type": "Text", "expression": "=Globals.PageNumber" }] }
          ]
        }
        """;

        var rows = Enumerable.Range(1, 60)
            .Select(i => new ReportRow(new Dictionary<string, object?> { ["Ref"] = $"TXN-{i:D4}", ["Debit"] = 10.25m * i }))
            .ToList();

        var pipeline = new ReportEnginePipeline([new HtmlReportRenderer()]);
        var doc = pipeline.BuildDocument(
            template,
            new Dictionary<string, IReadOnlyList<ReportRow>> { ["Transactions"] = rows },
            new Dictionary<string, object?>(),
            new RenderOptions());

        Assert.True(doc.Pages.Count >= 2);
        Assert.Equal(1, doc.Pages[0].PageNumber);
        Assert.Equal(2, doc.Pages[1].PageNumber);
    }

    [Fact]
    public void LayoutEngine_GroupsDetailRowsAndComputesGroupSubtotals()
    {
        var template = """
        {
          "schemaVersion": "1.0",
          "reportId": "grouped-cash",
          "page": { "size": "A4", "unit": "mm", "orientation": "Portrait" },
          "bands": [
            {
              "type": "GroupHeader",
              "groupBy": "Section",
              "height": 8,
              "elements": [{ "type": "Text", "expression": "=\"Section: \" + Fields.Section", "fontWeight": "Bold" }]
            },
            {
              "type": "Detail",
              "dataset": "CashEntries",
              "groupBy": "Section",
              "elements": [
                {
                  "type": "Table",
                  "columns": [
                    { "header": "Teller", "expression": "=Fields.TellerId" },
                    { "header": "CashIn", "expression": "=Fields.CashIn", "align": "Right" }
                  ]
                }
              ]
            },
            {
              "type": "GroupFooter",
              "height": 8,
              "elements": [{ "type": "Text", "expression": "=Format(Sum(Fields.CashIn, \"Group\"), \"N2\")", "align": "Right" }]
            }
          ]
        }
        """;

        var rows = new List<ReportRow>
        {
            new(new Dictionary<string, object?> { ["Section"] = "Retail", ["TellerId"] = "T-01", ["CashIn"] = 100m }),
            new(new Dictionary<string, object?> { ["Section"] = "Retail", ["TellerId"] = "T-02", ["CashIn"] = 150m }),
            new(new Dictionary<string, object?> { ["Section"] = "Vault", ["TellerId"] = "V-01", ["CashIn"] = 900m })
        };

        var report = UniversalReportEngine.CreateFromJson(template);
        report.SetDataSource("CashEntries", rows);
        var doc = report.BuildDocument();

        var texts = doc.Pages.SelectMany(p => p.Nodes).OfType<TextDrawNode>().Select(t => t.Text).ToList();
        Assert.Contains("Section: Retail", texts);
        Assert.Contains("250.00", texts);
        Assert.Contains("Section: Vault", texts);
        Assert.Contains("900.00", texts);
    }

    [Fact]
    public void RdlcImporter_ConvertsXmlAndReportsCustomCodeWarning()
    {
        const string rdlc = """
        <Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2016/01/reportdefinition">
          <Code>Function Foo() As String: Return "x": End Function</Code>
          <DataSets>
            <DataSet Name="Ledger">
              <Fields><Field Name="Ref" /></Fields>
            </DataSet>
          </DataSets>
          <ReportSections>
            <ReportSection>
              <Body>
                <ReportItems>
                  <Textbox Name="TitleBox"><Paragraphs><Paragraph><TextRuns><TextRun><Value>Bank Statement</Value></TextRun></TextRuns></Paragraph></Paragraphs></Textbox>
                </ReportItems>
              </Body>
            </ReportSection>
          </ReportSections>
        </Report>
        """;

        var imported = RdlcImporter.Convert(rdlc, "legacy-statement");
        Assert.Equal("legacy-statement", imported.Definition.ReportId);
        Assert.Contains(imported.Diagnostics, d => d.Code == "RDLC_CUSTOM_CODE_DROPPED");
    }

    [Fact]
    public async Task CommercialExport_ComputesTableSummaryRowGeneratesValidXlsxAndQrNodes()
    {
        var template = """
        {
          "schemaVersion": "1.0",
          "reportId": "commercial-summary-qr",
          "title": "Commercial Verification Ledger",
          "page": { "size": "A4", "unit": "mm", "orientation": "Portrait" },
          "bands": [
            {
              "type": "ReportHeader",
              "height": 22,
              "elements": [
                { "type": "Text", "value": "Commercial Header", "align": "Center", "fontWeight": "Bold", "width": 180 },
                { "type": "QrCode", "value": "https://verify.example/tx/100", "x": 160, "y": 2, "width": 16, "height": 16 }
              ]
            },
            {
              "type": "Detail",
              "dataset": "Entries",
              "elements": [
                {
                  "type": "Table",
                  "columns": [
                    { "header": "Ref", "expression": "=Fields.Ref", "width": 80 },
                    { "header": "Amount", "expression": "=Fields.Amount", "width": 100, "align": "Right", "format": "N2", "summary": "Sum" }
                  ]
                }
              ]
            }
          ]
        }
        """;

        var report = UniversalReportEngine.CreateFromJson(template);
        report.SetDataSource("Entries", new[]
        {
            new { Ref = "A-01", Amount = 120.25m },
            new { Ref = "A-02", Amount = 279.75m }
        });

        var doc = report.BuildDocument();
        Assert.Contains(doc.Pages[0].Nodes, n => n is QrCodeDrawNode qr && qr.Payload == "https://verify.example/tx/100");
        Assert.NotNull(doc.SemanticTables[0].SummaryRow);
        Assert.Equal(400.00m, doc.SemanticTables[0].SummaryRow![1]);

        byte[] xlsx = await report.RenderAsync(ReportFormat.Excel);
        Assert.True(xlsx.Length > 100);
        Assert.Equal((byte)'P', xlsx[0]);
        Assert.Equal((byte)'K', xlsx[1]);

        var ctx = new RequestEvaluationContext(new Dictionary<string, IReadOnlyList<ReportRow>>(), new Dictionary<string, object?>());
        var cmp = ExpressionCompiler.Evaluate(ExpressionCompiler.Compile("=\"2026-11-12\" > \"2026-11-01\""), ctx);
        Assert.Equal(true, cmp);
    }

    [Fact]
    public void LayoutEngine_WrapsCanGrowTextAndEvaluatesConditionalColorsAndWatermark()
    {
        var template = """
        {
          "schemaVersion": "1.0",
          "reportId": "cangrow-conditional",
          "page": { "size": "A4", "unit": "mm", "orientation": "Portrait", "watermark": "CONFIDENTIAL" },
          "bands": [
            {
              "type": "Detail",
              "dataset": "Ledger",
              "elements": [
                {
                  "type": "Table",
                  "columns": [
                    { "header": "Remarks", "expression": "=Fields.Remarks", "width": 40, "canGrow": true },
                    { "header": "Balance", "expression": "=Fields.Balance", "width": 35, "align": "Right", "colorExpression": "=IIf(Fields.Balance < 0, \"#B91C1C\", \"#0F172A\")" }
                  ]
                }
              ]
            }
          ]
        }
        """;

        var report = UniversalReportEngine.CreateFromJson(template);
        report.SetDataSource("Ledger", new[]
        {
            new { Remarks = "Cross-border wire transfer settlement remarks exceeding single cell width", Balance = -1500.00m }
        });

        var doc = report.BuildDocument();
        var texts = doc.Pages[0].Nodes.OfType<TextDrawNode>().ToList();
        Assert.Contains(texts, t => t.Text == "CONFIDENTIAL");
        Assert.Contains(texts, t => t.Text.Contains('\n'));
        Assert.Contains(texts, t => t.Text == "-1500" && t.Style.Color == "#B91C1C");
    }
}
