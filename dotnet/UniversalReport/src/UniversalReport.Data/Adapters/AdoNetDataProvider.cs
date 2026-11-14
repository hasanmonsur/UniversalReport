using System.Data;
using System.Data.Common;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using UniversalReport.Core;

namespace UniversalReport.Data.Adapters;

public sealed record AllowlistedSqlQuery(
    string QueryId,
    string SqlText,
    CommandType CommandType = CommandType.Text,
    int TimeoutSeconds = 30,
    int MaxRows = 100_000);

/// <summary>
/// Database-agnostic ADO.NET data provider supporting SQL Server, PostgreSQL, MySQL, Oracle, SQLite, or ODBC
/// via a caller-supplied IDbConnection factory or DbProviderFactory.
/// </summary>
public sealed partial class AdoNetDataProvider : IReportDataProvider
{
    private readonly Func<IDbConnection> _connectionFactory;
    private readonly Dictionary<string, AllowlistedSqlQuery> _allowlistedQueries = new(StringComparer.OrdinalIgnoreCase);

    [GeneratedRegex(@"\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|MERGE|EXEC|EXECUTE|GRANT|REVOKE)\b", RegexOptions.IgnoreCase)]
    private static partial Regex MutatingSqlRegex();

    public AdoNetDataProvider(string providerName, Func<IDbConnection> connectionFactory)
    {
        ProviderName = providerName;
        _connectionFactory = connectionFactory ?? throw new ArgumentNullException(nameof(connectionFactory));
    }

    public AdoNetDataProvider(string providerName, DbProviderFactory factory, string connectionString)
        : this(providerName, () =>
        {
            var conn = factory.CreateConnection()
                ?? throw new InvalidOperationException($"DbProviderFactory '{providerName}' returned null connection.");
            conn.ConnectionString = connectionString;
            return conn;
        })
    {
    }

    public string ProviderName { get; }

    public AdoNetDataProvider RegisterAllowlistedQuery(AllowlistedSqlQuery query)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(query.QueryId);
        ArgumentException.ThrowIfNullOrWhiteSpace(query.SqlText);

        if (query.CommandType == CommandType.Text && MutatingSqlRegex().IsMatch(query.SqlText))
        {
            throw new InvalidOperationException(
                $"SecurityError: Query '{query.QueryId}' contains mutating SQL keywords. Only read-only SELECT queries or allowlisted stored procedures are permitted.");
        }

        _allowlistedQueries[query.QueryId] = query;
        return this;
    }

    public async IAsyncEnumerable<ReportRow> ExecuteAsync(
        ReportDataQuery query,
        IReadOnlyDictionary<string, object?> parameters,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var key = query.QueryId ?? query.DatasetName;
        if (!_allowlistedQueries.TryGetValue(key, out var spec))
        {
            throw new InvalidOperationException(
                $"SecurityError: QueryId '{key}' is not registered in AdoNetDataProvider allowlist.");
        }

        using var connection = _connectionFactory();
        if (connection is DbConnection dbConn)
            await dbConn.OpenAsync(cancellationToken);
        else
            connection.Open();

        using var command = connection.CreateCommand();
        command.CommandText = spec.SqlText;
        command.CommandType = spec.CommandType;
        command.CommandTimeout = spec.TimeoutSeconds;

        foreach (var (paramName, paramValue) in parameters)
        {
            var dbParam = command.CreateParameter();
            dbParam.ParameterName = paramName.StartsWith('@') || paramName.StartsWith(':')
                ? paramName
                : $"@{paramName}";
            dbParam.Value = paramValue ?? DBNull.Value;
            command.Parameters.Add(dbParam);
        }

        var rowLimit = query.MaxRows.HasValue ? Math.Min(query.MaxRows.Value, spec.MaxRows) : spec.MaxRows;
        var count = 0;

        if (command is DbCommand dbCmd)
        {
            await using var reader = await dbCmd.ExecuteReaderAsync(CommandBehavior.SequentialAccess, cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                if (count >= rowLimit) yield break;
                yield return ReadCurrentRow(reader);
                count++;
            }
        }
        else
        {
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                if (count >= rowLimit) yield break;
                yield return ReadCurrentRow(reader);
                count++;
            }
        }
    }

    private static ReportRow ReadCurrentRow(IDataRecord record)
    {
        var map = new Dictionary<string, object?>(record.FieldCount, StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < record.FieldCount; i++)
        {
            map[record.GetName(i)] = record.IsDBNull(i) ? null : record.GetValue(i);
        }
        return new ReportRow(map);
    }
}
