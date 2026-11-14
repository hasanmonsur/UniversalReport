using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;
using UniversalReport.Core;

namespace UniversalReport.Data.Adapters;

public sealed class CsvDataProvider(string csvContent, bool hasHeader = true, char delimiter = ',') : IReportDataProvider
{
    public string ProviderName => "Csv";

    public async IAsyncEnumerable<ReportRow> ExecuteAsync(
        ReportDataQuery query,
        IReadOnlyDictionary<string, object?> parameters,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        foreach (var row in ParseRows(csvContent, hasHeader, delimiter, query.MaxRows))
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return row;
        }
        await Task.CompletedTask;
    }

    public static IReadOnlyList<ReportRow> ParseRows(string csvContent, bool hasHeader = true, char delimiter = ',', int? maxRows = null)
    {
        var lines = ParseCsvRecords(csvContent, delimiter);
        if (lines.Count == 0) return [];

        string[] headers;
        int startIndex;
        if (hasHeader)
        {
            headers = lines[0].ToArray();
            startIndex = 1;
        }
        else
        {
            headers = Enumerable.Range(0, lines[0].Count).Select(i => $"Column{i + 1}").ToArray();
            startIndex = 0;
        }

        var rows = new List<ReportRow>();
        for (var i = startIndex; i < lines.Count; i++)
        {
            if (maxRows.HasValue && rows.Count >= maxRows.Value) break;
            var record = lines[i];
            if (record.Count == 1 && string.IsNullOrWhiteSpace(record[0])) continue;

            var map = new Dictionary<string, object?>(headers.Length, StringComparer.OrdinalIgnoreCase);
            for (var c = 0; c < headers.Length; c++)
            {
                var raw = c < record.Count ? record[c] : string.Empty;
                map[headers[c].Trim()] = InferValue(raw);
            }
            rows.Add(new ReportRow(map));
        }

        return rows;
    }

    private static object? InferValue(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return string.Empty;
        if (decimal.TryParse(raw, NumberStyles.Number, CultureInfo.InvariantCulture, out var dec)) return dec;
        if (bool.TryParse(raw, out var b)) return b;
        return raw;
    }

    private static List<List<string>> ParseCsvRecords(string input, char delimiter)
    {
        var records = new List<List<string>>();
        var currentRow = new List<string>();
        var cell = new StringBuilder();
        var inQuotes = false;

        for (var i = 0; i < input.Length; i++)
        {
            var c = input[i];
            if (inQuotes)
            {
                if (c == '"')
                {
                    if (i + 1 < input.Length && input[i + 1] == '"')
                    {
                        cell.Append('"');
                        i++;
                    }
                    else
                    {
                        inQuotes = false;
                    }
                }
                else
                {
                    cell.Append(c);
                }
            }
            else
            {
                if (c == '"')
                {
                    inQuotes = true;
                }
                else if (c == delimiter)
                {
                    currentRow.Add(cell.ToString());
                    cell.Clear();
                }
                else if (c == '\r' || c == '\n')
                {
                    if (c == '\r' && i + 1 < input.Length && input[i + 1] == '\n') i++;
                    currentRow.Add(cell.ToString());
                    cell.Clear();
                    records.Add(currentRow);
                    currentRow = [];
                }
                else
                {
                    cell.Append(c);
                }
            }
        }

        if (cell.Length > 0 || currentRow.Count > 0)
        {
            currentRow.Add(cell.ToString());
            records.Add(currentRow);
        }

        return records;
    }
}

public static class ReportDataSourceExtensions
{
    public static void SetJsonDataSource(this Report report, string datasetName, string json, string? rootPropertyPath = null)
    {
        var rows = JsonDataProvider.ParseRows(json, rootPropertyPath);
        report.SetDataSource(datasetName, rows);
    }

    public static void SetCsvDataSource(this Report report, string datasetName, string csvContent, bool hasHeader = true, char delimiter = ',')
    {
        var rows = CsvDataProvider.ParseRows(csvContent, hasHeader, delimiter);
        report.SetDataSource(datasetName, rows);
    }
}
