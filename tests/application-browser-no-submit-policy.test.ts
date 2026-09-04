import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import ts from "typescript";

const PRODUCTION_PATHS = [
  "lib/application-browser/form-fill-dom.ts",
  "lib/application-browser/form-fill-writer.ts"
] as const;

function constantString(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return constantString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantString(node.left);
    const right = constantString(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function propertyName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return constantString(node.argumentExpression);
  return null;
}

function bindingPropertyName(node: ts.BindingElement): string | null {
  const property = node.propertyName ?? node.name;
  if (ts.isIdentifier(property) || ts.isStringLiteral(property)) return property.text;
  return ts.isComputedPropertyName(property)
    ? constantString(property.expression)
    : null;
}

function invokedName(node: ts.Expression): string | null {
  return ts.isIdentifier(node) ? node.text : propertyName(node);
}

function isAuthorizedCheckCall(node: ts.CallExpression, fileName: string): boolean {
  if (fileName.endsWith("form-fill-dom.ts") || !ts.isPropertyAccessExpression(node.expression)) return false;
  const receiver = node.expression.expression;
  if (!ts.isPropertyAccessExpression(receiver) || !ts.isIdentifier(receiver.expression) || receiver.expression.text !== "runtimeInput") {
    return false;
  }
  const branch = containingCase(node);
  return (branch === "RADIO_GROUP" && receiver.name.text === "proposedChoiceHandle") ||
    (branch === "CHECKBOX_BOOLEAN" && receiver.name.text === "handle");
}

function isPristineCheckedGetterCapture(node: ts.StringLiteralLike): boolean {
  const call = node.parent;
  if (!ts.isCallExpression(call)) return false;
  const descriptorCall = ts.isIdentifier(call.expression)
    ? call.expression.text === "nativeGetOwnPropertyDescriptor"
    : ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "getOwnPropertyDescriptor";
  if (!descriptorCall) return false;
  const access = call.parent;
  return ts.isPropertyAccessExpression(access) && access.expression === call && access.name.text === "get";
}

function containingCase(node: ts.Node): string | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isCaseClause(current) && ts.isStringLiteral(current.expression)) return current.expression.text;
  }
  return null;
}

function executablePolicyViolations(sourceText: string, fileName = "policy-subject.ts"): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const add = (node: ts.Node, reason: string) => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push(`${fileName}:${position.line + 1}:${position.character + 1} ${reason}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = propertyName(node);
      if (name && ["requestSubmit", "submit", "uncheck", "click"].includes(name)) {
        add(node, `forbidden ${name} method reference`);
      }
      if (name === "check") {
        const parent = node.parent;
        const runtimeShapeCheck = ts.isTypeOfExpression(parent) && parent.expression === node &&
          ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "value";
        if (!runtimeShapeCheck &&
          (!ts.isCallExpression(parent) || parent.expression !== node || !isAuthorizedCheckCall(parent, fileName))) {
          add(node, "check() outside an authorized typed branch");
        }
      }
    }
    if (ts.isBindingElement(node)) {
      const name = bindingPropertyName(node);
      if (name && ["requestSubmit", "submit", "uncheck", "click"].includes(name)) {
        add(node, `forbidden ${name} binding reference`);
      }
    }
    if (ts.isCallExpression(node)) {
      const name = invokedName(node.expression);
      if (name && ["press", "pressSequentially", "type", "down", "insertText"].includes(name)) {
        for (const argument of node.arguments) {
          if (ts.isStringLiteralLike(argument) && /^(Enter|Return)$/i.test(argument.text)) add(node, "keyboard submission path");
        }
      }
    }
    if (ts.isNewExpression(node) && invokedName(node.expression) === "KeyboardEvent") {
      if (node.arguments?.some((argument) => argument.getText(source).match(/["'](?:Enter|Return)["']/i))) {
        add(node, "keyboard submission event");
      }
    }
    if (
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      propertyName(node.left) === "checked"
    ) add(node, "native checked assignment");
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === null && ts.isIdentifier(node.name) && node.name.text === "checked") {
      add(node, "native checked property construction");
    }
    if (ts.isStringLiteralLike(node) &&
      (/submit|FILL_APPROVED_FIELDS|^click$/i.test(node.text) ||
        (/^checked$/i.test(node.text) && !isPristineCheckedGetterCapture(node)))) {
      add(node, "forbidden command or control literal");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

test("employer writer production surface contains no submit or false-checkbox authority", async () => {
  const violations: string[] = [];
  for (const path of PRODUCTION_PATHS) {
    violations.push(...executablePolicyViolations(await readFile(path, "utf8"), path));
  }
  assert.deepEqual(violations, []);
});

test("AST policy catches obvious executable bypasses without matching comments", () => {
  assert.deepEqual(executablePolicyViolations(`// form.submit(); button.click(); input.checked = false;`), []);
  assert.deepEqual(executablePolicyViolations(
    `const checkedGetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.get;`
  ), []);
  for (const source of [
    `form.submit()`,
    `form["submit"]()`,
    `form["sub" + "mit"]()`,
    `form.requestSubmit()`,
    `form["requestSubmit"]()`,
    `const invoke = form.requestSubmit; invoke.call(form);`,
    `const invoke = form["requestSubmit"]; invoke.call(form);`,
    `const { requestSubmit: invoke } = form; invoke();`,
    `const { ["requestSubmit"]: invoke } = form; invoke();`,
    `const { ["requestSub" + "mit"]: invoke } = form; invoke();`,
    `HTMLFormElement.prototype.submit.call(form)`,
    `const invoke = form.submit; invoke.call(form);`,
    `const { submit: invoke } = form; invoke();`,
    `control.uncheck()`,
    `control["uncheck"]()`,
    `const clear = control.uncheck; clear.call(control);`,
    `const { uncheck: clear } = control; clear();`,
    `const { ["uncheck"]: clear } = control; clear();`,
    `const clear = control["un" + "check"]; clear.call(control);`,
    `control.click()`,
    `control["click"]()`,
    `const activate = control.click; activate.call(control);`,
    `const { click: activate } = control; activate();`,
    `control.checked = false`,
    `control["checked"] = false`,
    `control["che" + "cked"] = false`,
    `control.checked = true`,
    `Object.assign(control, { checked: false })`,
    `Reflect.set(control, "checked", false)`,
    `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked").set.call(control, false)`,
    `control.dispatchEvent(new MouseEvent("click", { bubbles: true }))`,
    `page.keyboard.press("Enter")`,
    `press("Enter")`,
    `press("Return")`,
    `page.press("Return")`,
    `page.keyboard.down("Return")`,
    `control.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))`,
    `control.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Return" }))`,
    `switch (runtimeInput.fieldType) { case "RADIO_GROUP": await someHandle.check(); }`,
    `switch (runtimeInput.fieldType) { case "CHECKBOX_BOOLEAN": await runtimeInput.proposedChoiceHandle.check(); }`,
    `document.querySelector('button[type="submit"]')`,
    `send({ type: "FILL_APPROVED_FIELDS" })`
  ]) {
    assert.ok(executablePolicyViolations(source).length > 0, source);
  }
});
