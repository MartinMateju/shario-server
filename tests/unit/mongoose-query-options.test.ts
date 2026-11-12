import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
const mongooseUpdateMethods = new Set([
  "findOneAndUpdate",
  "findByIdAndUpdate",
  "findOneAndReplace",
  "findByIdAndReplace",
]);
const deprecatedOptions = new Set(["new", "returnOriginal"]);
const sourceExtension = /\.[cm]?[jt]sx?$/;

const collectSourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(path);
      return sourceExtension.test(entry.name) ? [path] : [];
    })
    .sort();

const scriptKindFor = (path: string): ts.ScriptKind => {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
};

const calledMethodName = (expression: ts.LeftHandSideExpression) => {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    if (
      argument &&
      (ts.isStringLiteral(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument))
    ) {
      return argument.text;
    }
  }
  return undefined;
};

const propertyName = (name: ts.PropertyName): string | undefined => {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
    return name.expression.text;
  }
  return undefined;
};

const unwrap = (expression: ts.Expression): ts.Expression => {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return unwrap(expression.expression);
  }
  return expression;
};

const deprecatedOptionIn = (
  expression: ts.Expression,
): ts.ObjectLiteralElementLike | undefined => {
  const unwrapped = unwrap(expression);
  if (ts.isConditionalExpression(unwrapped)) {
    return (
      deprecatedOptionIn(unwrapped.whenTrue) ??
      deprecatedOptionIn(unwrapped.whenFalse)
    );
  }
  if (!ts.isObjectLiteralExpression(unwrapped)) return undefined;

  for (const property of unwrapped.properties) {
    if (ts.isSpreadAssignment(property)) {
      const nested = deprecatedOptionIn(property.expression);
      if (nested) return nested;
      continue;
    }
    if (
      property.name &&
      deprecatedOptions.has(propertyName(property.name) ?? "")
    ) {
      return property;
    }
  }
  return undefined;
};

const findViolations = (): string[] => {
  const violations: string[] = [];

  for (const path of collectSourceFiles(sourceRoot)) {
    const source = readFileSync(path, "utf8");
    if (![...mongooseUpdateMethods].some((method) => source.includes(method))) {
      continue;
    }

    const sourceFile = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(path),
    );

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const method = calledMethodName(node.expression);
        const options = node.arguments[2];
        if (method && mongooseUpdateMethods.has(method) && options) {
          const deprecated = deprecatedOptionIn(options);
          if (deprecated) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(
              deprecated.getStart(sourceFile),
            );
            violations.push(
              `${relative(sourceRoot, path)}:${line + 1}:${character + 1} (${method})`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return violations;
};

describe("Mongoose update query options", () => {
  it("uses returnDocument instead of deprecated result options", () => {
    const violations = findViolations();
    expect(
      violations,
      `Replace deprecated Mongoose result options with returnDocument:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
