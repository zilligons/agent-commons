import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { ScopedProviderCredentialName } from "./adapters/provider_credentials";

if (!process.env.NODE_TEST_CONTEXT) {
  process.stderr.write("TEST_RUNNER_REQUIRED\n");
  process.exit(64);
}
// Install memory-only storage before any application module can initialize.
await import("./offline-test-home.mjs");

const { captureProviderCredentials, getProviderCredential, SCOPED_PROVIDER_CREDENTIAL_NAMES,
  getOperatorToken } = await import("./adapters/provider_credentials");
const { scrubAndProve, buildClosedConsoleEnv } = await import("./bootstrap");
const { COMMON_CHILD_ENV } = await import("./adapters/l10-env");

test("captures only scoped provider fixture credentials once and leaves no key in console or child env", () => {
  const source: NodeJS.ProcessEnv = {
    AGENT_COMMONS_OPENAI_API_KEY: "fixture-openai-only",
    AGENT_COMMONS_ANTHROPIC_API_KEY: "fixture-anthropic-only",
    AGENT_COMMONS_XAI_API_KEY: "fixture-xai-only",
    AGENT_COMMONS_GOOGLE_API_KEY: "fixture-google-only",
    AGENT_COMMONS_GEMINI_API_KEY: "fixture-gemini-only",
    AGENT_COMMONS_OPERATOR_TOKEN: "fixture-operator-only",
    OPENAI_API_KEY: "fixture-unscoped-alias",
    OTHER_API_KEY: "fixture-unrelated",
    AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED: "0",
    NODE_ENV: "test",
  };
  const originals = SCOPED_PROVIDER_CREDENTIAL_NAMES.map(name => source[name]);
  captureProviderCredentials(source);
  assert.equal(getOperatorToken(), "fixture-operator-only");
  source.AGENT_COMMONS_OPERATOR_TOKEN = "fixture-later-operator";
  for (const [index, name] of SCOPED_PROVIDER_CREDENTIAL_NAMES.entries()) {
    assert.equal(getProviderCredential(name), originals[index]);
    assert.equal(source[name], originals[index], "capture does not mutate its caller");
    source[name] = "fixture-later-replacement";
    assert.ok(!(COMMON_CHILD_ENV as readonly string[]).includes(name));
  }
  captureProviderCredentials(source);
  assert.equal(getOperatorToken(), "fixture-operator-only");
  for (const [index, name] of SCOPED_PROVIDER_CREDENTIAL_NAMES.entries()) assert.equal(getProviderCredential(name), originals[index]);
  for (const alias of ["OPENAI_API_KEY", "OTHER_API_KEY", "AGENT_COMMONS_OPERATOR_TOKEN"]) assert.equal(getProviderCredential(alias as ScopedProviderCredentialName), undefined);
  assert.equal(scrubAndProve(source), null);
  const closed = buildClosedConsoleEnv(source);
  for (const name of [...SCOPED_PROVIDER_CREDENTIAL_NAMES, "AGENT_COMMONS_OPERATOR_TOKEN", "OPENAI_API_KEY", "OTHER_API_KEY"]) {
    assert.equal(Object.hasOwn(source, name), false);
    assert.equal(Object.hasOwn(closed, name), false);
  }
  assert.equal(closed.AGENT_COMMONS_PROVIDER_REQUESTS_ENABLED, "0");
  assert.equal(getOperatorToken(), "fixture-operator-only");
  assert.ok(!(COMMON_CHILD_ENV as readonly string[]).includes("AGENT_COMMONS_OPERATOR_TOKEN"));
  for (const [index, name] of SCOPED_PROVIDER_CREDENTIAL_NAMES.entries()) assert.equal(getProviderCredential(name), originals[index]);
});

function assertPureCapture(source: string) {
  const sf = ts.createSourceFile("provider_credentials.ts", source, ts.ScriptTarget.Latest, true);
  assert.equal(sf.parseDiagnostics.length, 0);
  const expected = ["AGENT_COMMONS_OPENAI_API_KEY", "AGENT_COMMONS_ANTHROPIC_API_KEY", "AGENT_COMMONS_XAI_API_KEY",
    "AGENT_COMMONS_GOOGLE_API_KEY", "AGENT_COMMONS_GEMINI_API_KEY"];
  const declarations = new Map<string, ts.Expression>();
  let sourceReads = 0;
  function unwrap(node: ts.Expression): ts.Expression {
    return ts.isAsExpression(node) || ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  }
  const allowedTop = new Set(["SCOPED_PROVIDER_CREDENTIAL_NAMES", "ScopedProviderCredentialName", "captured", "CAPTURE_CREDENTIAL_NAMES", "operatorToken", "initialized", "captureProviderCredentials", "getProviderCredential", "getOperatorToken"]);
  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        assert(ts.isIdentifier(declaration.name) && allowedTop.has(declaration.name.text));
        if (declaration.initializer) declarations.set(declaration.name.text, unwrap(declaration.initializer));
      }
    } else {
      assert((ts.isFunctionDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name && allowedTop.has(statement.name.text));
    }
  }
  const providerList = declarations.get("SCOPED_PROVIDER_CREDENTIAL_NAMES")!;
  assert(ts.isCallExpression(providerList) && providerList.expression.getText(sf) === "Object.freeze");
  const providerArray = unwrap(providerList.arguments[0]);
  assert(ts.isArrayLiteralExpression(providerArray));
  assert.deepEqual(providerArray.elements.map(element => ts.isStringLiteral(element) ? element.text : null), expected);
  const allList = declarations.get("CAPTURE_CREDENTIAL_NAMES")!;
  assert(ts.isCallExpression(allList) && allList.expression.getText(sf) === "Object.freeze");
  const allArray = unwrap(allList.arguments[0]);
  assert(ts.isArrayLiteralExpression(allArray) && allArray.elements.length === 2);
  assert(ts.isSpreadElement(allArray.elements[0]) && allArray.elements[0].expression.getText(sf) === "SCOPED_PROVIDER_CREDENTIAL_NAMES");
  assert(ts.isStringLiteral(allArray.elements[1]) && allArray.elements[1].text === "AGENT_COMMONS_OPERATOR_TOKEN");
  function walk(node: ts.Node) {
    assert(!ts.isImportDeclaration(node) && !ts.isImportEqualsDeclaration(node), "capture has no imports");
    assert(!ts.isExportDeclaration(node) || !node.moduleSpecifier, "capture has no re-exported dependencies");
    if (ts.isCallExpression(node)) {
      assert(["Object.freeze", "value.trim", "captured.set", "captured.get"].includes(node.expression.getText(sf)), "capture cannot require, dynamically import, initialize an application or access files/network");
    }
    if (ts.isNewExpression(node)) assert(node.expression.getText(sf) === "Map" && !node.arguments?.length);
    if (ts.isPropertyAccessExpression(node)) assert(["Object.freeze", "value.trim", "captured.set", "captured.get"].includes(node.getText(sf)));
    if (ts.isElementAccessExpression(node) && node.expression.getText(sf) === "source") {
      sourceReads++;
      assert(node.argumentExpression.getText(sf) === "name");
      assert(ts.isVariableDeclaration(node.parent) && node.parent.name.getText(sf) === "value" && node.parent.initializer === node, "source is read only");
      let loop: ts.Node | undefined = node.parent;
      while (loop && !ts.isForOfStatement(loop)) loop = loop.parent;
      assert(loop && ts.isForOfStatement(loop) && loop.expression.getText(sf) === "CAPTURE_CREDENTIAL_NAMES", "source reads only exact frozen names");
      assert(ts.isVariableDeclarationList(loop.initializer) && loop.initializer.declarations.length === 1 &&
        loop.initializer.declarations[0].name.getText(sf) === "name", "the read index is the frozen-list iterator");
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
  assert.equal(sourceReads, 1);
}

test("startup capture exception is an import-free exact-name memory-only module", () => {
  const source = readFileSync(new URL("./adapters/provider_credentials.ts", import.meta.url), "utf8");
  assertPureCapture(source);
  for (const mutant of [source + '\nimport "./app";', source + '\nrequire("node:fs");', source + '\nimport("node:http");',
    source.replace('source[name]', 'source["UNLISTED_TOKEN"]'), source + '\nfetch("https://example.invalid");']) {
    assert.throws(() => assertPureCapture(mutant));
  }
});

test("startup captures scoped credentials before scrubbing and before importing the application", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const capture = source.indexOf("captureProviderCredentials(process.env)");
  const scrub = source.indexOf("const survivors = scrubAndProve()");
  const application = source.indexOf('await import("./app")');
  assert(capture >= 0 && scrub > capture && application > scrub);
});
