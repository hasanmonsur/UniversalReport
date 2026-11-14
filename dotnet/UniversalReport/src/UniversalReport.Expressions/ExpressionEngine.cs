using System.Globalization;
using UniversalReport.Core;

namespace UniversalReport.Expressions;

public enum TokenKind
{
    Number,
    String,
    Identifier,
    True,
    False,
    Null,
    Dot,
    Comma,
    LParen,
    RParen,
    Plus,
    Minus,
    Star,
    Slash,
    Lt,
    Lte,
    Gt,
    Gte,
    Eq,
    Neq,
    And,
    Or,
    Not,
    Eof
}

public sealed record Token(TokenKind Kind, string Lexeme, int Position);

public abstract record AstNode;
public sealed record LiteralNode(object? Value) : AstNode;
public sealed record MemberAccessNode(string Root, string Member) : AstNode;
public sealed record UnaryNode(string Op, AstNode Operand) : AstNode;
public sealed record BinaryNode(string Op, AstNode Left, AstNode Right) : AstNode;
public sealed record CallNode(string FunctionName, IReadOnlyList<AstNode> Arguments) : AstNode;

public sealed record CompiledExpression(string Source, AstNode Ast, IReadOnlyList<string> ReferencedFields);

public sealed class ExpressionSecurityException(string message) : Exception(message);

public interface IExpressionEvaluationContext
{
    object? GetField(string name);
    object? GetParameter(string name);
    object? GetGlobal(string name);
    decimal ComputeSum(string fieldName, string? datasetScope);
    int ComputeCount(string? datasetScope);
    decimal ComputeRunningValue(string fieldName, string aggregateOp);
}

public static class ExpressionCompiler
{
    private static readonly HashSet<string> AllowedFunctions = new(StringComparer.OrdinalIgnoreCase)
    {
        "Sum", "Count", "RunningValue", "IIf", "Format", "Coalesce", "Round", "Abs", "Upper", "Lower", "Len"
    };

    private static readonly HashSet<string> AllowedRoots = new(StringComparer.OrdinalIgnoreCase)
    {
        "Fields", "Parameters", "Globals"
    };

    public static CompiledExpression Compile(string rawExpression)
    {
        if (string.IsNullOrWhiteSpace(rawExpression))
            return new CompiledExpression(string.Empty, new LiteralNode(string.Empty), []);

        if (!rawExpression.StartsWith('='))
            return new CompiledExpression(rawExpression, new LiteralNode(rawExpression), []);

        var body = rawExpression[1..].Trim();
        var tokens = Tokenize(body);
        var parser = new Parser(tokens);
        var ast = parser.ParseExpression();
        if (parser.Peek().Kind != TokenKind.Eof)
            throw new FormatException($"Unexpected token '{parser.Peek().Lexeme}' at position {parser.Peek().Position}.");

        var fields = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        ValidateAst(ast, fields, depth: 0);
        return new CompiledExpression(rawExpression, ast, fields.ToList());
    }

    private static void ValidateAst(AstNode node, HashSet<string> fields, int depth)
    {
        if (depth > 32)
            throw new ExpressionSecurityException("Expression exceeded maximum AST complexity depth of 32.");

        switch (node)
        {
            case LiteralNode:
                return;
            case MemberAccessNode member:
                if (!AllowedRoots.Contains(member.Root))
                    throw new ExpressionSecurityException($"Disallowed root identifier '{member.Root}'. Only Fields, Parameters, and Globals are permitted.");
                if (member.Root.Equals("Fields", StringComparison.OrdinalIgnoreCase))
                    fields.Add(member.Member);
                return;
            case UnaryNode unary:
                ValidateAst(unary.Operand, fields, depth + 1);
                return;
            case BinaryNode binary:
                ValidateAst(binary.Left, fields, depth + 1);
                ValidateAst(binary.Right, fields, depth + 1);
                return;
            case CallNode call:
                if (!AllowedFunctions.Contains(call.FunctionName))
                    throw new ExpressionSecurityException($"Function '{call.FunctionName}' is not in the expression sandbox allowlist.");
                foreach (var arg in call.Arguments)
                    ValidateAst(arg, fields, depth + 1);
                return;
        }
    }

    public static object? Evaluate(CompiledExpression compiled, IExpressionEvaluationContext context) =>
        EvalNode(compiled.Ast, context);

    private static object? EvalNode(AstNode node, IExpressionEvaluationContext ctx) => node switch
    {
        LiteralNode lit => lit.Value,
        MemberAccessNode mem => mem.Root.ToLowerInvariant() switch
        {
            "fields" => ctx.GetField(mem.Member),
            "parameters" => ctx.GetParameter(mem.Member),
            "globals" => ctx.GetGlobal(mem.Member),
            _ => null
        },
        UnaryNode un => un.Op switch
        {
            "-" => -ToDecimal(EvalNode(un.Operand, ctx)),
            "!" => !ToBoolean(EvalNode(un.Operand, ctx)),
            _ => null
        },
        BinaryNode bin => EvalBinary(bin, ctx),
        CallNode call => EvalCall(call, ctx),
        _ => null
    };

    private static object? EvalBinary(BinaryNode bin, IExpressionEvaluationContext ctx)
    {
        var l = EvalNode(bin.Left, ctx);
        var r = EvalNode(bin.Right, ctx);

        return bin.Op switch
        {
            "+" => l is string || r is string
                ? string.Concat(Convert.ToString(l, CultureInfo.InvariantCulture), Convert.ToString(r, CultureInfo.InvariantCulture))
                : ToDecimal(l) + ToDecimal(r),
            "-" => ToDecimal(l) - ToDecimal(r),
            "*" => ToDecimal(l) * ToDecimal(r),
            "/" => ToDecimal(r) == 0m ? 0m : ToDecimal(l) / ToDecimal(r),
            "<" => CompareValues(l, r) < 0,
            "<=" => CompareValues(l, r) <= 0,
            ">" => CompareValues(l, r) > 0,
            ">=" => CompareValues(l, r) >= 0,
            "==" => EqualsNormalized(l, r),
            "!=" => !EqualsNormalized(l, r),
            "&&" => ToBoolean(l) && ToBoolean(r),
            "||" => ToBoolean(l) || ToBoolean(r),
            _ => null
        };
    }

    private static object? EvalCall(CallNode call, IExpressionEvaluationContext ctx)
    {
        switch (call.FunctionName.ToLowerInvariant())
        {
            case "iif":
                return ToBoolean(EvalNode(call.Arguments[0], ctx))
                    ? EvalNode(call.Arguments[1], ctx)
                    : EvalNode(call.Arguments[2], ctx);
            case "sum":
                var sumField = ExtractFieldName(call.Arguments[0]);
                var scope = call.Arguments.Count > 1 ? Convert.ToString(EvalNode(call.Arguments[1], ctx), CultureInfo.InvariantCulture) : null;
                return ctx.ComputeSum(sumField, scope);
            case "count":
                var countScope = call.Arguments.Count > 0 ? Convert.ToString(EvalNode(call.Arguments[0], ctx), CultureInfo.InvariantCulture) : null;
                return ctx.ComputeCount(countScope);
            case "runningvalue":
                var runField = ExtractFieldName(call.Arguments[0]);
                var op = call.Arguments.Count > 1 ? Convert.ToString(EvalNode(call.Arguments[1], ctx), CultureInfo.InvariantCulture) ?? "Sum" : "Sum";
                return ctx.ComputeRunningValue(runField, op);
            case "format":
                var val = EvalNode(call.Arguments[0], ctx);
                var fmt = Convert.ToString(EvalNode(call.Arguments[1], ctx), CultureInfo.InvariantCulture) ?? string.Empty;
                if (val is IFormattable formattable)
                    return formattable.ToString(fmt, CultureInfo.InvariantCulture);
                if (val is string s && DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.None, out var dt))
                    return dt.ToString(fmt, CultureInfo.InvariantCulture);
                return Convert.ToString(val, CultureInfo.InvariantCulture) ?? string.Empty;
            case "coalesce":
                foreach (var arg in call.Arguments)
                {
                    var v = EvalNode(arg, ctx);
                    if (v is not null) return v;
                }
                return null;
            case "round":
                var d = ToDecimal(EvalNode(call.Arguments[0], ctx));
                var digits = call.Arguments.Count > 1 ? Convert.ToInt32(EvalNode(call.Arguments[1], ctx), CultureInfo.InvariantCulture) : 2;
                return Math.Round(d, digits, MidpointRounding.AwayFromZero);
            case "abs":
                return Math.Abs(ToDecimal(EvalNode(call.Arguments[0], ctx)));
            case "upper":
                return Convert.ToString(EvalNode(call.Arguments[0], ctx), CultureInfo.InvariantCulture)?.ToUpperInvariant() ?? string.Empty;
            case "lower":
                return Convert.ToString(EvalNode(call.Arguments[0], ctx), CultureInfo.InvariantCulture)?.ToLowerInvariant() ?? string.Empty;
            case "len":
                return (Convert.ToString(EvalNode(call.Arguments[0], ctx), CultureInfo.InvariantCulture) ?? string.Empty).Length;
            default:
                throw new ExpressionSecurityException($"Function '{call.FunctionName}' is not allowed.");
        }
    }

    private static string ExtractFieldName(AstNode node) =>
        node is MemberAccessNode mem && mem.Root.Equals("Fields", StringComparison.OrdinalIgnoreCase)
            ? mem.Member
            : throw new ExpressionSecurityException("Aggregate functions require a Fields.<Name> reference as first argument.");

    private static decimal ToDecimal(object? value) => value switch
    {
        null => 0m,
        decimal d => d,
        int i => i,
        long l => l,
        double db => Convert.ToDecimal(db, CultureInfo.InvariantCulture),
        float f => Convert.ToDecimal(f, CultureInfo.InvariantCulture),
        string s when decimal.TryParse(s, NumberStyles.Any, CultureInfo.InvariantCulture, out var parsed) => parsed,
        _ => 0m
    };

    private static bool ToBoolean(object? value) => value switch
    {
        null => false,
        bool b => b,
        decimal d => d != 0m,
        int i => i != 0,
        string s => bool.TryParse(s, out var b) ? b : !string.IsNullOrEmpty(s),
        _ => true
    };

    private static int CompareValues(object? a, object? b)
    {
        if (a is null && b is null) return 0;
        if (a is null) return -1;
        if (b is null) return 1;
        if (a is DateTime dta && b is DateTime dtb) return DateTime.Compare(dta, dtb);
        if (a is string sa && b is string sb)
        {
            if (decimal.TryParse(sa, NumberStyles.Any, CultureInfo.InvariantCulture, out var da) &&
                decimal.TryParse(sb, NumberStyles.Any, CultureInfo.InvariantCulture, out var db))
            {
                return Comparer<decimal>.Default.Compare(da, db);
            }
            if (DateTime.TryParse(sa, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d1) &&
                DateTime.TryParse(sb, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d2))
            {
                return DateTime.Compare(d1, d2);
            }
            return string.CompareOrdinal(sa, sb);
        }
        return Comparer<decimal>.Default.Compare(ToDecimal(a), ToDecimal(b));
    }

    private static bool EqualsNormalized(object? a, object? b)
    {
        if (a is null && b is null) return true;
        if (a is null || b is null) return false;
        if (a is string sa && b is string sb) return string.Equals(sa, sb, StringComparison.Ordinal);
        return ToDecimal(a) == ToDecimal(b);
    }

    private static List<Token> Tokenize(string input)
    {
        var tokens = new List<Token>();
        var i = 0;
        while (i < input.Length)
        {
            var c = input[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }

            if (char.IsDigit(c))
            {
                var start = i;
                while (i < input.Length && (char.IsDigit(input[i]) || input[i] == '.')) i++;
                tokens.Add(new Token(TokenKind.Number, input[start..i], start));
                continue;
            }

            if (c == '"')
            {
                var start = ++i;
                while (i < input.Length && input[i] != '"') i++;
                tokens.Add(new Token(TokenKind.String, input[start..i], start));
                if (i < input.Length) i++;
                continue;
            }

            if (char.IsLetter(c) || c == '_')
            {
                var start = i;
                while (i < input.Length && (char.IsLetterOrDigit(input[i]) || input[i] == '_')) i++;
                var word = input[start..i];
                var kind = word.ToLowerInvariant() switch
                {
                    "true" => TokenKind.True,
                    "false" => TokenKind.False,
                    "null" => TokenKind.Null,
                    _ => TokenKind.Identifier
                };
                tokens.Add(new Token(kind, word, start));
                continue;
            }

            var two = i + 1 < input.Length ? input.Substring(i, 2) : string.Empty;
            if (two is "<=" or ">=" or "==" or "!=" or "&&" or "||")
            {
                var kind = two switch
                {
                    "<=" => TokenKind.Lte,
                    ">=" => TokenKind.Gte,
                    "==" => TokenKind.Eq,
                    "!=" => TokenKind.Neq,
                    "&&" => TokenKind.And,
                    "||" => TokenKind.Or,
                    _ => TokenKind.Eof
                };
                tokens.Add(new Token(kind, two, i));
                i += 2;
                continue;
            }

            var single = c switch
            {
                '.' => TokenKind.Dot,
                ',' => TokenKind.Comma,
                '(' => TokenKind.LParen,
                ')' => TokenKind.RParen,
                '+' => TokenKind.Plus,
                '-' => TokenKind.Minus,
                '*' => TokenKind.Star,
                '/' => TokenKind.Slash,
                '<' => TokenKind.Lt,
                '>' => TokenKind.Gt,
                '!' => TokenKind.Not,
                _ => throw new FormatException($"Unexpected character '{c}' at position {i}.")
            };
            tokens.Add(new Token(single, c.ToString(), i));
            i++;
        }

        tokens.Add(new Token(TokenKind.Eof, string.Empty, i));
        return tokens;
    }

    private sealed class Parser(IReadOnlyList<Token> tokens)
    {
        private int _pos;

        public Token Peek() => _pos < tokens.Count ? tokens[_pos] : tokens[^1];
        private Token Advance() => tokens[_pos++];
        private bool Match(TokenKind kind)
        {
            if (Peek().Kind != kind) return false;
            _pos++;
            return true;
        }

        public AstNode ParseExpression() => ParseOr();

        private AstNode ParseOr()
        {
            var left = ParseAnd();
            while (Match(TokenKind.Or)) left = new BinaryNode("||", left, ParseAnd());
            return left;
        }

        private AstNode ParseAnd()
        {
            var left = ParseEquality();
            while (Match(TokenKind.And)) left = new BinaryNode("&&", left, ParseEquality());
            return left;
        }

        private AstNode ParseEquality()
        {
            var left = ParseComparison();
            while (Peek().Kind is TokenKind.Eq or TokenKind.Neq)
            {
                var op = Advance().Lexeme;
                left = new BinaryNode(op, left, ParseComparison());
            }
            return left;
        }

        private AstNode ParseComparison()
        {
            var left = ParseTerm();
            while (Peek().Kind is TokenKind.Lt or TokenKind.Lte or TokenKind.Gt or TokenKind.Gte)
            {
                var op = Advance().Lexeme;
                left = new BinaryNode(op, left, ParseTerm());
            }
            return left;
        }

        private AstNode ParseTerm()
        {
            var left = ParseFactor();
            while (Peek().Kind is TokenKind.Plus or TokenKind.Minus)
            {
                var op = Advance().Lexeme;
                left = new BinaryNode(op, left, ParseFactor());
            }
            return left;
        }

        private AstNode ParseFactor()
        {
            var left = ParseUnary();
            while (Peek().Kind is TokenKind.Star or TokenKind.Slash)
            {
                var op = Advance().Lexeme;
                left = new BinaryNode(op, left, ParseUnary());
            }
            return left;
        }

        private AstNode ParseUnary()
        {
            if (Peek().Kind is TokenKind.Minus or TokenKind.Not)
            {
                var op = Advance().Lexeme;
                return new UnaryNode(op, ParseUnary());
            }
            return ParsePrimary();
        }

        private AstNode ParsePrimary()
        {
            var token = Peek();
            if (Match(TokenKind.Number))
                return new LiteralNode(decimal.Parse(token.Lexeme, CultureInfo.InvariantCulture));
            if (Match(TokenKind.String))
                return new LiteralNode(token.Lexeme);
            if (Match(TokenKind.True)) return new LiteralNode(true);
            if (Match(TokenKind.False)) return new LiteralNode(false);
            if (Match(TokenKind.Null)) return new LiteralNode(null);

            if (Match(TokenKind.LParen))
            {
                var inner = ParseExpression();
                if (!Match(TokenKind.RParen)) throw new FormatException("Expected closing ')'.");
                return inner;
            }

            if (Match(TokenKind.Identifier))
            {
                if (Match(TokenKind.LParen))
                {
                    var args = new List<AstNode>();
                    if (Peek().Kind != TokenKind.RParen)
                    {
                        do { args.Add(ParseExpression()); } while (Match(TokenKind.Comma));
                    }
                    if (!Match(TokenKind.RParen)) throw new FormatException("Expected ')' after function arguments.");
                    return new CallNode(token.Lexeme, args);
                }

                if (Match(TokenKind.Dot))
                {
                    var member = Advance();
                    if (member.Kind != TokenKind.Identifier)
                        throw new FormatException("Expected property name after '.'.");
                    return new MemberAccessNode(token.Lexeme, member.Lexeme);
                }

                throw new ExpressionSecurityException($"Bare identifier '{token.Lexeme}' is not permitted; use Fields.{token.Lexeme} or Parameters.{token.Lexeme}.");
            }

            throw new FormatException($"Unexpected token '{token.Lexeme}' at position {token.Position}.");
        }
    }
}
