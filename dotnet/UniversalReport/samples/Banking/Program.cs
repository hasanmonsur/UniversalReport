using System.Data;
using UniversalReport;
using UniversalReport.Core;
using UniversalReport.Data.Adapters;

namespace UniversalReport.Samples.Banking;

public sealed record BankTransaction(
    DateTime TranDate,
    string Reference,
    string Description,
    decimal Debit,
    decimal Credit,
    decimal Balance);

public static class BankingSampleRunner
{
    public static async Task Main()
    {
        // 1. Consume via single UniversalReport NuGet package (zero-config)
        var report = await UniversalReportEngine.LoadFileAsync("account-statement.ureport");

        // Option A: Bind strongly-typed C# collection
        var transactions = new List<BankTransaction>
        {
            new(new DateTime(2026, 11, 1), "TXN-1001", "Opening Balance Brought Forward", 0m, 125000.00m, 125000.00m),
            new(new DateTime(2026, 11, 3), "NPSB-8821", "Utility Clearing - Dhaka Electric", 4250.50m, 0m, 120749.50m),
            new(new DateTime(2026, 11, 6), "EFT-4490", "Corporate Payroll Credit", 0m, 85000.00m, 205749.50m)
        };
        report.SetDataSource("Transactions", transactions);

        // Option B: Bind System.Data.DataTable
        var dt = new DataTable("Transactions");
        dt.Columns.Add("TranDate", typeof(DateTime));
        dt.Columns.Add("Reference", typeof(string));
        dt.Columns.Add("Particulars", typeof(string));
        dt.Columns.Add("Debit", typeof(decimal));
        dt.Columns.Add("Credit", typeof(decimal));
        dt.Columns.Add("Balance", typeof(decimal));
        dt.Rows.Add(new DateTime(2026, 11, 1), "TXN-1001", "Opening Balance", 0m, 125000m, 125000m);
        // report.SetDataSource("Transactions", dt);

        // Option C: Bind JSON or CSV directly
        // report.SetJsonDataSource("Transactions", "[{\"Reference\":\"TXN-1\",\"Credit\":500}]");
        // report.SetCsvDataSource("Transactions", "Reference,Debit,Credit\nTXN-1,0,500");

        // Option D: Bind any ADO.NET Database (SqlConnection / Npgsql / MySql / Oracle / Sqlite)
        // var sqlProvider = new AdoNetDataProvider("SqlServer", () => new SqlConnection(connString))
        //     .RegisterAllowlistedQuery(new AllowlistedSqlQuery("GetTransactions", "SELECT TranDate, Reference, Particulars, Debit, Credit, Balance FROM Ledger WHERE AccountNo = @AccountNo"));
        // await report.SetDataSourceAsync("Transactions", sqlProvider, new ReportDataQuery("Transactions", "GetTransactions"));

        report.SetParameter("AccountNo", "1040-883920-001");

        byte[] pdf = await report.RenderAsync(ReportFormat.Pdf);
        byte[] excel = await report.RenderAsync(ReportFormat.Excel);

        await File.WriteAllBytesAsync("AccountStatement.pdf", pdf);
        await File.WriteAllBytesAsync("AccountStatement.xlsx", excel);
    }
}
