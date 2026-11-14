using System.Data;
using System.Reflection;
using System.Text.Json;

namespace UniversalReport.Core;

public interface IReportEnginePipeline
{
    RenderDocument BuildDocument(
        string templateJson,
        IReadOnlyDictionary<string, IReadOnlyList<ReportRow>> dataSources,
        IReadOnlyDictionary<string, object?> parameters,
        RenderOptions options);

    Task<byte[]> ExportAsync(
        RenderDocument document,
        ReportFormat format,
        RenderOptions options,
        CancellationToken cancellationToken = default);
}

public sealed class Report
{
    private readonly string _templateJson;
    private readonly IReportEnginePipeline _pipeline;
    private readonly Dictionary<string, IReadOnlyList<ReportRow>> _dataSources = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, object?> _parameters = new(StringComparer.OrdinalIgnoreCase);

    public Report(string templateJson, IReportEnginePipeline pipeline)
    {
        _templateJson = templateJson ?? throw new ArgumentNullException(nameof(templateJson));
        _pipeline = pipeline ?? throw new ArgumentNullException(nameof(pipeline));
    }

    public static async Task<Report> LoadAsync(
        string filePath,
        IReportEnginePipeline pipeline,
        CancellationToken cancellationToken = default)
    {
        var json = await File.ReadAllTextAsync(filePath, cancellationToken);
        return new Report(json, pipeline);
    }

    public void SetDataSource<T>(string name, IEnumerable<T> items)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(items);

        var rows = new List<ReportRow>();
        foreach (var item in items)
        {
            if (item is null) continue;
            rows.Add(ConvertItemToRow(item));
        }

        _dataSources[name] = rows;
    }

    public async Task SetDataSourceAsync<T>(
        string name,
        IAsyncEnumerable<T> items,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(items);

        var rows = new List<ReportRow>();
        await foreach (var item in items.WithCancellation(cancellationToken))
        {
            if (item is not null) rows.Add(ConvertItemToRow(item));
        }
        _dataSources[name] = rows;
    }

    public void SetDataSource(string name, DataTable table)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(table);

        var rows = new List<ReportRow>(table.Rows.Count);
        foreach (DataRow dataRow in table.Rows)
        {
            var map = new Dictionary<string, object?>(table.Columns.Count, StringComparer.OrdinalIgnoreCase);
            foreach (DataColumn col in table.Columns)
            {
                var val = dataRow[col];
                map[col.ColumnName] = val == DBNull.Value ? null : val;
            }
            rows.Add(new ReportRow(map));
        }

        _dataSources[name] = rows;
    }

    public void SetDataSource(DataSet dataSet)
    {
        ArgumentNullException.ThrowIfNull(dataSet);
        foreach (DataTable table in dataSet.Tables)
        {
            var key = string.IsNullOrWhiteSpace(table.TableName) ? "Table" : table.TableName;
            SetDataSource(key, table);
        }
    }

    public void SetDataSource(string name, IDataReader reader)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(reader);

        var rows = new List<ReportRow>();
        var fieldCount = reader.FieldCount;
        while (reader.Read())
        {
            var map = new Dictionary<string, object?>(fieldCount, StringComparer.OrdinalIgnoreCase);
            for (var i = 0; i < fieldCount; i++)
            {
                map[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            }
            rows.Add(new ReportRow(map));
        }

        _dataSources[name] = rows;
    }

    public async Task SetDataSourceAsync(
        string name,
        IReportDataProvider provider,
        ReportDataQuery? query = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentNullException.ThrowIfNull(provider);

        var resolvedQuery = query ?? new ReportDataQuery(name, null);
        var rows = new List<ReportRow>();
        await foreach (var row in provider.ExecuteAsync(resolvedQuery, _parameters, cancellationToken))
        {
            rows.Add(row);
        }
        _dataSources[name] = rows;
    }

    public void SetParameter(string name, object? value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        _parameters[name] = value;
    }

    public RenderDocument BuildDocument(RenderOptions? options = null) =>
        _pipeline.BuildDocument(_templateJson, _dataSources, _parameters, options ?? new RenderOptions());

    public async Task<byte[]> RenderAsync(
        ReportFormat format,
        RenderOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var resolved = options ?? new RenderOptions();
        var document = BuildDocument(resolved);
        return await _pipeline.ExportAsync(document, format, resolved, cancellationToken);
    }

    private static ReportRow ConvertItemToRow(object item)
    {
        if (item is ReportRow row) return row;

        if (item is IDictionary<string, object?> dict)
            return new ReportRow(new Dictionary<string, object?>(dict, StringComparer.OrdinalIgnoreCase));

        if (item is IEnumerable<KeyValuePair<string, object?>> kvps)
        {
            var map = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            foreach (var kv in kvps) map[kv.Key] = kv.Value;
            return new ReportRow(map);
        }

        if (item is JsonElement jsonEl && jsonEl.ValueKind == JsonValueKind.Object)
        {
            var map = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            foreach (var prop in jsonEl.EnumerateObject())
            {
                map[prop.Name] = UnwrapJsonElement(prop.Value);
            }
            return new ReportRow(map);
        }

        var props = item.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance);
        var objMap = new Dictionary<string, object?>(props.Length, StringComparer.OrdinalIgnoreCase);
        foreach (var prop in props)
        {
            if (prop.GetIndexParameters().Length == 0)
                objMap[prop.Name] = prop.GetValue(item);
        }
        return new ReportRow(objMap);
    }

    private static object? UnwrapJsonElement(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.Null or JsonValueKind.Undefined => null,
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Number => el.TryGetDecimal(out var dec) ? dec : el.GetDouble(),
        JsonValueKind.String => el.TryGetDateTime(out var dt) ? dt : el.GetString(),
        _ => el.GetRawText()
    };
}
