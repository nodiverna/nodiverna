// Module specifiers of a source file, read with the TypeScript compiler API
// instead of regular expressions: comments and string contents never count,
// and formatting does not matter.
import ts from 'typescript';

const scriptKinds = { '.ts': ts.ScriptKind.TS, '.mts': ts.ScriptKind.TS, '.cts': ts.ScriptKind.TS, '.tsx': ts.ScriptKind.TSX, '.jsx': ts.ScriptKind.JSX, '.js': ts.ScriptKind.JS, '.mjs': ts.ScriptKind.JS, '.cjs': ts.ScriptKind.JS };

/** The TypeScript source file of `text`; the extension of `fileName` selects TS, TSX or JS. */
export function parseSource(text, fileName = 'probe.ts') {
  const extension = /\.[a-z]+$/i.exec(fileName)?.[0].toLowerCase() ?? '.ts';
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKinds[extension] ?? ts.ScriptKind.TS);
}

const literal = (node) => !!node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

/**
 * Every module reference of a source:
 * - `import` (also `import type` and side-effect `import 'x'`),
 * - `export … from`, `export type … from`, `export * from`,
 * - `import x = require('x')`,
 * - `require('x')` and `import('x')` calls,
 * - type-position `import('x')`.
 * Each entry is `{ specifier, kind, typeOnly, node }`. A `require()` or
 * `import()` whose argument is not a string literal is a violation
 * `{ kind, text, line }`: its target cannot be checked.
 */
export function moduleSpecifiers(text, fileName = 'probe.ts') {
  const source = typeof text === 'string' ? parseSource(text, fileName) : text;
  const specifiers = [], violations = [];
  const add = (node, kind, typeOnly) => specifiers.push({ specifier: node.text, kind, typeOnly, node });
  const violation = (node, kind) => violations.push({ kind, text: node.getText(source), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && literal(node.moduleSpecifier)) {
      add(node.moduleSpecifier, 'import', !!node.importClause?.isTypeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && literal(node.moduleSpecifier)) {
      add(node.moduleSpecifier, 'export', node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (literal(expression)) add(expression, 'import-equals', node.isTypeOnly);
      else violation(node, 'import-equals');
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && literal(argument.literal)) add(argument.literal, 'import-type', true);
      else violation(node, 'import-type');
    } else if (ts.isCallExpression(node)) {
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (dynamic || required) {
        const kind = dynamic ? 'dynamic-import' : 'require';
        if (node.arguments.length >= 1 && literal(node.arguments[0])) add(node.arguments[0], kind, false);
        else violation(node, kind);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specifiers, violations, source };
}

/** Only the specifier strings, in source order. */
export const specifierList = (text, fileName) => moduleSpecifiers(text, fileName).specifiers.map((entry) => entry.specifier);
