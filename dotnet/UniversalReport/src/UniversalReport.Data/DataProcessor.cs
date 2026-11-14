using System.Globalization;
using System.Runtime.CompilerServices;
using UniversalReport.Core;
using UniversalReport.Expressions;

namespace UniversalReport.Data;

public sealed class RequestEvaluationContext(
    IReadOnlyDictionary<string, IReadOnlyList<ReportRow>> datasets,
    IReadOnlyDictionary<string, object?> parameters) : IExpressionEvaluationContext
{
    private ReportRow? _currentRow;
    private string _currentDataset = string.Empty;
    private int _currentRowIndex = -1;
    private IReadOnlyList<ReportRow>? _activeGroupRows;
    private int _pageNumber = 1;
    private int _totalPages = 1;

    public void SetRow(string datasetName, ReportRow row, int rowIndex, IReadOnlyList<ReportRow>? activeGroupRows = null)
    {
        _currentDataset = datasetName;
        _currentRow = row;
        _currentRowIndex = rowIndex;
        _activeGroupRows = activeGroupRows;
    }

    public void SetGroupScope(string datasetName, IReadOnlyList<ReportRow>? activeGroupRows)
    {
        _currentDataset = datasetName;
        _activeGroupRows = activeGroupRows;
        _currentRow = activeGroupRows is { Count: > 0 } ? activeGroupRows[0] : null;
        _currentRowIndex = 0;
    }

    public void SetPageInfo(int pageNumber, int totalPages)
    {
        _pageNumber = pageNumber;
        _totalPages = totalPages;
    }

    public object? GetField(string name) => _currentRow?[name];

    public object? GetParameter(string name) =>
        parameters.TryGetValue(name, out var val) ? val : null;

    public object? GetGlobal(string name) => name.ToLowerInvariant() switch
    {
        "pagenumber" => _pageNumber,
        "totalpages" => _totalPages,
        "executiontime" => DateTime.UtcNow,
        _ => null
    };

    public decimal ComputeSum(string fieldName, string? datasetScope)
    {
        IReadOnlyList<ReportRow>? rows;
        if (string.Equals(datasetScope, "Group", StringComparison.OrdinalIgnoreCase) ||
            (string.IsNullOrWhiteSpace(datasetScope) && _activeGroupRows is not null))
        {
            rows = _activeGroupRows;
        }
        else
        {
            var key = string.IsNullOrWhiteSpace(datasetScope) ? _currentDataset : datasetScope;
            datasets.TryGetValue(key, out rows);
        }

        if (rows is null) return 0m;
        var sum = 0m;
        foreach (var r in rows) sum += ToDecimal(r[fieldName]);
        return sum;
    }

    public int ComputeCount(string? datasetScope)
    {
        if (string.Equals(datasetScope, "Group", StringComparison.OrdinalIgnoreCase) ||
            (string.IsNullOrWhiteSpace(datasetScope) && _activeGroupRows is not null))
        {
            return _activeGroupRows?.Count ?? 0;
        }
        var key = string.IsNullOrWhiteSpace(datasetScope) ? _currentDataset : datasetScope;
        return datasets.TryGetValue(key, out var rows) ? rows.Count : 0;
    }

    public decimal ComputeRunningValue(string fieldName, string aggregateOp)
    {
        var rows = _activeGroupRows ?? (datasets.TryGetValue(_currentDataset, out var ds) ? ds : null);
        if (rows is null || _currentRowIndex < 0) return 0m;
        var running = 0m;
        var limit = Math.Min(_currentRowIndex, rows.Count - 1);
        for (var i = 0; i <= limit; i++)
            running += ToDecimal(rows[i][fieldName]);
        return running;
    }

    public static decimal ToDecimal(object? val) => val switch
    {
        null => 0m,
        decimal d => d,
        int i => i,
        long l => l,
        double d => Convert.ToDecimal(d, CultureInfo.InvariantCulture),
        string s when decimal.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out var parsed) => parsed,
        _ => 0m
    };
}

public sealed class InMemoryDataProvider(IReadOnlyDictionary<string, IReadOnlyList<ReportRow>> store) : IReportDataProvider
{
    public string ProviderName => "InMemory";

    public async IAsyncEnumerable<ReportRow> ExecuteAsync(
        ReportDataQuery query,
        IReadOnlyDictionary<string, object?> parameters,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        if (!store.TryGetValue(query.DatasetName, out var rows))
            yield break;

        var count = 0;
        foreach (var row in rows)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return row;
            count++;
            if (query.MaxRows is int max && count >= max) yield break;
        }

        await Task.CompletedTask;
    }
}
