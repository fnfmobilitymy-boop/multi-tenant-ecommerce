import ts from "typescript";
import fs from "node:fs";
const messages = JSON.parse(
  fs.readFileSync("src/locales/messages.json", "utf8"),
);
const errors = [];
for (const [key, values] of Object.entries(messages)) {
  if (
    values.length !== 5 ||
    values.some((value) => typeof value !== "string" || !value.trim())
  )
    errors.push("Incomplete translations: " + key);
  const slots = key.match(/\{[a-zA-Z][\w]*\}/g) || [];
  for (const value of values)
    if (
      JSON.stringify(
        [...value.matchAll(/\{[a-zA-Z][\w]*\}/g)].map((m) => m[0]).sort(),
      ) !== JSON.stringify(slots.slice().sort())
    )
      errors.push("Placeholder mismatch: " + key);
}
for (const file of fs.readdirSync("src").filter((f) => f.endsWith(".tsx"))) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync("src/" + file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "t" &&
      node.arguments.length &&
      ts.isStringLiteral(node.arguments[0]) &&
      !Object.hasOwn(messages, node.arguments[0].text)
    )
      errors.push(file + ": missing " + node.arguments[0].text);
    if (ts.isJsxText(node) && /[\u3400-\u9fff]/.test(node.text))
      errors.push(file + ": hardcoded UI text " + node.text.trim());
    ts.forEachChild(node, visit);
  }
  visit(source);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(
  "PASS: " +
    Object.keys(messages).length +
    " messages complete in 6 languages; UI keys and placeholders verified.",
);
