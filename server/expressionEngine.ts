export type AstNode =
  | { kind: 'Literal'; value: string | number | boolean | null }
  | { kind: 'MemberAccess'; root: string; member: string }
  | { kind: 'Unary'; op: '-' | '!'; operand: AstNode }
  | { kind: 'Binary'; op: string; left: AstNode; right: AstNode }
  | { kind: 'Call'; fn: string; args: AstNode[] };

export interface CompiledExpression {
  source: string;
  ast: AstNode;
  referencedFields: string[];
  referencedParameters: string[];
}

export interface EvaluationContext {
  getField(name: string): unknown;
  getParameter(name: string): unknown;
  getGlobal(name: string): unknown;
  computeSum(field: string, datasetScope?: string): number;
  computeCount(datasetScope?: string): number;
  computeRunningValue(field: string): number;
}

const ALLOWED_FUNCTIONS = new Set([
  'sum',
  'count',
  'runningvalue',
  'iif',
  'format',
  'coalesce',
  'round',
  'abs',
  'upper',
  'lower',
  'len',
]);

const ALLOWED_ROOTS = new Set(['fields', 'parameters', 'globals']);

interface Token {
  kind:
    | 'Number'
    | 'String'
    | 'Identifier'
    | 'True'
    | 'False'
    | 'Null'
    | 'Dot'
    | 'Comma'
    | 'LParen'
    | 'RParen'
    | 'Plus'
    | 'Minus'
    | 'Star'
    | 'Slash'
    | 'Lt'
    | 'Lte'
    | 'Gt'
    | 'Gte'
    | 'Eq'
    | 'Neq'
    | 'And'
    | 'Or'
    | 'Not'
    | 'Eof';
  lexeme: string;
  pos: number;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }

    if (/[0-9]/.test(c)) {
      const start = i;
      while (i < input.length && /[0-9.]/.test(input[i])) i++;
      tokens.push({ kind: 'Number', lexeme: input.slice(start, i), pos: start });
      continue;
    }

    if (c === '"') {
      const start = ++i;
      let val = '';
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          val += input[i + 1];
          i += 2;
        } else {
          val += input[i++];
        }
      }
      tokens.push({ kind: 'String', lexeme: val, pos: start });
      if (i < input.length) i++;
      continue;
    }

    if (/[a-zA-Z_]/.test(c)) {
      const start = i;
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) i++;
      const word = input.slice(start, i);
      const lower = word.toLowerCase();
      const kind =
        lower === 'true'
          ? 'True'
          : lower === 'false'
            ? 'False'
            : lower === 'null'
              ? 'Null'
              : 'Identifier';
      tokens.push({ kind, lexeme: word, pos: start });
      continue;
    }

    const two = input.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '==' || two === '!=' || two === '&&' || two === '||') {
      const map: Record<string, Token['kind']> = {
        '<=': 'Lte',
        '>=': 'Gte',
        '==': 'Eq',
        '!=': 'Neq',
        '&&': 'And',
        '||': 'Or',
      };
      tokens.push({ kind: map[two], lexeme: two, pos: i });
      i += 2;
      continue;
    }

    const singleMap: Record<string, Token['kind']> = {
      '.': 'Dot',
      ',': 'Comma',
      '(': 'LParen',
      ')': 'RParen',
      '+': 'Plus',
      '-': 'Minus',
      '*': 'Star',
      '/': 'Slash',
      '<': 'Lt',
      '>': 'Gt',
      '!': 'Not',
    };

    if (singleMap[c]) {
      tokens.push({ kind: singleMap[c], lexeme: c, pos: i });
      i++;
      continue;
    }

    throw new Error(`Unexpected character '${c}' at position ${i}.`);
  }

  tokens.push({ kind: 'Eof', lexeme: '', pos: i });
  return tokens;
}

export function compileExpression(raw: string): CompiledExpression {
  if (!raw || !raw.startsWith('=')) {
    return {
      source: raw ?? '',
      ast: { kind: 'Literal', value: raw ?? '' },
      referencedFields: [],
      referencedParameters: [],
    };
  }

  const tokens = tokenize(raw.slice(1).trim());
  let pos = 0;

  const peek = () => tokens[pos] ?? tokens[tokens.length - 1];
  const advance = () => tokens[pos++];
  const match = (kind: Token['kind']) => {
    if (peek().kind !== kind) return false;
    pos++;
    return true;
  };

  function parseOr(): AstNode {
    let left = parseAnd();
    while (match('Or')) left = { kind: 'Binary', op: '||', left, right: parseAnd() };
    return left;
  }

  function parseAnd(): AstNode {
    let left = parseEquality();
    while (match('And')) left = { kind: 'Binary', op: '&&', left, right: parseEquality() };
    return left;
  }

  function parseEquality(): AstNode {
    let left = parseComparison();
    while (peek().kind === 'Eq' || peek().kind === 'Neq') {
      const op = advance().lexeme;
      left = { kind: 'Binary', op, left, right: parseComparison() };
    }
    return left;
  }

  function parseComparison(): AstNode {
    let left = parseTerm();
    while (peek().kind === 'Lt' || peek().kind === 'Lte' || peek().kind === 'Gt' || peek().kind === 'Gte') {
      const op = advance().lexeme;
      left = { kind: 'Binary', op, left, right: parseTerm() };
    }
    return left;
  }

  function parseTerm(): AstNode {
    let left = parseFactor();
    while (peek().kind === 'Plus' || peek().kind === 'Minus') {
      const op = advance().lexeme;
      left = { kind: 'Binary', op, left, right: parseFactor() };
    }
    return left;
  }

  function parseFactor(): AstNode {
    let left = parseUnary();
    while (peek().kind === 'Star' || peek().kind === 'Slash') {
      const op = advance().lexeme;
      left = { kind: 'Binary', op, left, right: parseUnary() };
    }
    return left;
  }

  function parseUnary(): AstNode {
    if (peek().kind === 'Minus' || peek().kind === 'Not') {
      const op = advance().lexeme as '-' | '!';
      return { kind: 'Unary', op, operand: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary(): AstNode {
    const t = peek();
    if (match('Number')) return { kind: 'Literal', value: Number(t.lexeme) };
    if (match('String')) return { kind: 'Literal', value: t.lexeme };
    if (match('True')) return { kind: 'Literal', value: true };
    if (match('False')) return { kind: 'Literal', value: false };
    if (match('Null')) return { kind: 'Literal', value: null };

    if (match('LParen')) {
      const inner = parseOr();
      if (!match('RParen')) throw new Error("Expected closing ')' in expression.");
      return inner;
    }

    if (match('Identifier')) {
      if (match('LParen')) {
        const args: AstNode[] = [];
        if (peek().kind !== 'RParen') {
          do {
            args.push(parseOr());
          } while (match('Comma'));
        }
        if (!match('RParen')) throw new Error(`Expected ')' after ${t.lexeme}(...) arguments.`);
        return { kind: 'Call', fn: t.lexeme, args };
      }

      if (match('Dot')) {
        const member = advance();
        if (member.kind !== 'Identifier') throw new Error(`Expected member name after '${t.lexeme}.'.`);
        return { kind: 'MemberAccess', root: t.lexeme, member: member.lexeme };
      }

      throw new Error(
        `SecurityError: Bare identifier '${t.lexeme}' is blocked. Use Fields.${t.lexeme}, Parameters.${t.lexeme}, or Globals.${t.lexeme}.`
      );
    }

    throw new Error(`Unexpected token '${t.lexeme}' at position ${t.pos}.`);
  }

  const ast = parseOr();
  if (peek().kind !== 'Eof') {
    throw new Error(`Unexpected trailing token '${peek().lexeme}' at position ${peek().pos}.`);
  }

  const fields = new Set<string>();
  const params = new Set<string>();

  function validateAst(node: AstNode, depth: number) {
    if (depth > 32) throw new Error('SecurityError: Expression exceeds maximum AST complexity depth of 32.');
    switch (node.kind) {
      case 'Literal':
        return;
      case 'MemberAccess':
        if (!ALLOWED_ROOTS.has(node.root.toLowerCase())) {
          throw new Error(
            `SecurityError: Disallowed root '${node.root}'. Reflection, System, and host objects are prohibited.`
          );
        }
        if (node.root.toLowerCase() === 'fields') fields.add(node.member);
        if (node.root.toLowerCase() === 'parameters') params.add(node.member);
        return;
      case 'Unary':
        validateAst(node.operand, depth + 1);
        return;
      case 'Binary':
        validateAst(node.left, depth + 1);
        validateAst(node.right, depth + 1);
        return;
      case 'Call':
        if (!ALLOWED_FUNCTIONS.has(node.fn.toLowerCase())) {
          throw new Error(`SecurityError: Function '${node.fn}' is not on the sandboxed expression allowlist.`);
        }
        node.args.forEach((a) => validateAst(a, depth + 1));
    }
  }

  validateAst(ast, 0);

  return {
    source: raw,
    ast,
    referencedFields: [...fields],
    referencedParameters: [...params],
  };
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0 && v.toLowerCase() !== 'false';
  return Boolean(v);
}

function compareValues(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') {
    const na = Number(a);
    const nb = Number(b);
    if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return toNum(a) - toNum(b);
}

// Banker/decimal-safe 4-decimal rounding to eliminate IEEE-754 float drift on monetary totals
export function roundDecimal(val: number, digits = 4): number {
  const factor = Math.pow(10, digits);
  return Math.round((val + Number.EPSILON) * factor) / factor;
}

export function evaluateExpression(compiled: CompiledExpression, ctx: EvaluationContext): unknown {
  function evalNode(node: AstNode): unknown {
    switch (node.kind) {
      case 'Literal':
        return node.value;
      case 'MemberAccess': {
        const root = node.root.toLowerCase();
        if (root === 'fields') return ctx.getField(node.member);
        if (root === 'parameters') return ctx.getParameter(node.member);
        if (root === 'globals') return ctx.getGlobal(node.member);
        return null;
      }
      case 'Unary': {
        const v = evalNode(node.operand);
        return node.op === '-' ? -toNum(v) : !toBool(v);
      }
      case 'Binary': {
        const l = evalNode(node.left);
        const r = evalNode(node.right);
        switch (node.op) {
          case '+':
            return typeof l === 'string' || typeof r === 'string'
              ? `${l ?? ''}${r ?? ''}`
              : roundDecimal(toNum(l) + toNum(r));
          case '-':
            return roundDecimal(toNum(l) - toNum(r));
          case '*':
            return roundDecimal(toNum(l) * toNum(r));
          case '/':
            return toNum(r) === 0 ? 0 : roundDecimal(toNum(l) / toNum(r));
          case '<':
            return compareValues(l, r) < 0;
          case '<=':
            return compareValues(l, r) <= 0;
          case '>':
            return compareValues(l, r) > 0;
          case '>=':
            return compareValues(l, r) >= 0;
          case '==':
            return typeof l === 'string' || typeof r === 'string' ? String(l ?? '') === String(r ?? '') : toNum(l) === toNum(r);
          case '!=':
            return typeof l === 'string' || typeof r === 'string' ? String(l ?? '') !== String(r ?? '') : toNum(l) !== toNum(r);
          case '&&':
            return toBool(l) && toBool(r);
          case '||':
            return toBool(l) || toBool(r);
          default:
            return null;
        }
      }
      case 'Call': {
        const fn = node.fn.toLowerCase();
        switch (fn) {
          case 'iif':
            return toBool(evalNode(node.args[0])) ? evalNode(node.args[1]) : evalNode(node.args[2]);
          case 'sum': {
            const first = node.args[0];
            if (!first || first.kind !== 'MemberAccess' || first.root.toLowerCase() !== 'fields') {
              throw new Error('Sum() requires Fields.<Name> as first argument.');
            }
            const scope = node.args[1] ? String(evalNode(node.args[1]) ?? '') : undefined;
            return ctx.computeSum(first.member, scope);
          }
          case 'count': {
            const scope = node.args[0] ? String(evalNode(node.args[0]) ?? '') : undefined;
            return ctx.computeCount(scope);
          }
          case 'runningvalue': {
            const first = node.args[0];
            if (!first || first.kind !== 'MemberAccess' || first.root.toLowerCase() !== 'fields') {
              throw new Error('RunningValue() requires Fields.<Name> as first argument.');
            }
            return ctx.computeRunningValue(first.member);
          }
          case 'format': {
            const val = evalNode(node.args[0]);
            const fmt = String(evalNode(node.args[1]) ?? '');
            return formatTypedValue(val, fmt);
          }
          case 'coalesce':
            for (const arg of node.args) {
              const v = evalNode(arg);
              if (v !== null && v !== undefined && v !== '') return v;
            }
            return null;
          case 'round':
            return roundDecimal(toNum(evalNode(node.args[0])), node.args[1] ? toNum(evalNode(node.args[1])) : 2);
          case 'abs':
            return Math.abs(toNum(evalNode(node.args[0])));
          case 'upper':
            return String(evalNode(node.args[0]) ?? '').toUpperCase();
          case 'lower':
            return String(evalNode(node.args[0]) ?? '').toLowerCase();
          case 'len':
            return String(evalNode(node.args[0]) ?? '').length;
          default:
            return null;
        }
      }
    }
  }

  return evalNode(compiled.ast);
}

export function formatTypedValue(val: unknown, format?: string): string {
  if (val === null || val === undefined) return '';
  if (!format) return String(val);

  if (format.toUpperCase() === 'N2') {
    const n = toNum(val);
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  if (format === 'dd-MM-yyyy') {
    const str = String(val);
    const d = new Date(str);
    if (!Number.isNaN(d.getTime())) {
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const yyyy = d.getUTCFullYear();
      return `${dd}-${mm}-${yyyy}`;
    }
  }

  return String(val);
}
