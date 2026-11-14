using System.Globalization;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text.Json;
using UniversalReport.Core;

namespace UniversalReport.Data.Adapters;

public sealed class JsonDataProvider(string jsonPayload, string? rootPropertyPath = null) : IReportDataProvider
{
    public string ProviderName => "Json";

    public async IAsyncEnumerable<ReportRow> ExecuteAsync(
        ReportDataQuery query,
        IReadOnlyDictionary<string, object?> parameters,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        foreach (var row in ParseRows(jsonPayload, rootPropertyPath, query.MaxRows))
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return row;
        }
        await Task.CompletedTask;
    }

    public static IReadOnlyList<ReportRow> ParseRows(string jsonPayload, string? rootPropertyPath = null, int? maxRows = null)
    {
        using var doc = JsonDocument.Parse(jsonPayload);
        var target = doc.RootElement;

        if (!string.IsNullOrWhiteSpace(rootPropertyPath))
        {
            foreach (var segment in rootPropertyPath.Split('.', StringSplitOptions.RemoveEmptyEntries))
            {
                if (target.ValueKind == JsonValueKind.Object && target.TryGetProperty(segment, out var next))
                    target = next;
                else
                    return [];
            }
        }

        if (target.ValueKind != JsonValueKind.Array)
            return target.ValueKind == JsonValueKind.Object ? [ConvertObject(target)] : [];

        var list = new List<ReportRow>();
        foreach (var item in target.EnumerateArray())
        {
            if (maxRows.HasValue && list.Count >= maxRows.Value) break;
            if (item.ValueKind == JsonValueKind.Object)
                list.Add(ConvertObject(item));
        }
        return list;
    }

    private static ReportRow ConvertObject(JsonElement obj)
    {
        var map = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
        foreach (var prop in obj.EnumerateObject())
        {
            map[prop.Name] = prop.Value.ValueKind switch
            {
                JsonValueKind.Null or JsonValueKind.Undefined => null,
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                JsonValueKind.Number => prop.Value.TryGetDecimal(out var d) ? d : prop.Value.GetDouble(),
                JsonValueKind.String => prop.Value.TryGetDateTime(out var dt) ? dt : prop.Value.GetString(),
                _ => prop.Value.GetRawText()
            };
        }
        return new ReportRow(map);
    }
}

public sealed class RestApiDataProvider : IReportDataProvider
{
    private readonly HttpClient _httpClient;
    private readonly Uri _endpointUri;
    private readonly string? _rootPropertyPath;
    private readonly HashSet<string> _allowedHosts;
    private readonly AuthenticationHeaderValue? _authHeader;

    public RestApiDataProvider(
        HttpClient httpClient,
        Uri endpointUri,
        IEnumerable<string> allowedHosts,
        string? rootPropertyPath = null,
        AuthenticationHeaderValue? authHeader = null)
    {
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _endpointUri = endpointUri ?? throw new ArgumentNullException(nameof(endpointUri));
        _allowedHosts = new HashSet<string>(allowedHosts, StringComparer.OrdinalIgnoreCase);
        _rootPropertyPath = rootPropertyPath;
        _authHeader = authHeader;

        if (!_allowedHosts.Contains(_endpointUri.Host))
        {
            throw new InvalidOperationException(
                $"SecurityError: Host '{_endpointUri.Host}' is not in the REST data provider allowlist (SSRF protection).");
        }
    }

    public string ProviderName => "RestApi";

    public async IAsyncEnumerable<ReportRow> ExecuteAsync(
        ReportDataQuery query,
        IReadOnlyDictionary<string, object?> parameters,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, _endpointUri);
        if (_authHeader is not null) req.Headers.Authorization = _authHeader;

        using var res = await _httpClient.SendAsync(req, cancellationToken);
        res.EnsureSuccessStatusCode();
        var body = await res.Content.ReadAsStringAsync(cancellationToken);

        foreach (var row in JsonDataProvider.ParseRows(body, _rootPropertyPath, query.MaxRows))
        {
            yield return row;
        }
    }
}
