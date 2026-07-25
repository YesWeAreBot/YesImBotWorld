/**
 * GBNF 语法生成：强制 Bot-LLM 输出恰好一个合法的工具调用 JSON 对象：
 *
 * ```json
 * {"name": "act", "arguments": {...}, "duration": 2}
 * ```
 *
 * duration 可选（缺省表示立刻）。语法是有限的：对象闭合后仅 EOS 合法，
 * 模型输出恰好一个工具调用即停止。
 */
export function buildToolCallGrammar(toolNames: string[]): string {
  const nameAlt = toolNames.map((n) => `"\\"${n}\\""`).join(" | ");
  return [
    `root ::= "{\\"name\\": " name ", \\"arguments\\": " object duration "}"`,
    `duration ::= (", \\"duration\\": " uint)?`,
    `name ::= ${nameAlt}`,
    `object ::= "{" ws ( member ("," ws member)* )? ws "}"`,
    `member ::= string ":" ws value`,
    `array ::= "[" ws ( value ("," ws value)* )? ws "]"`,
    `value ::= object | array | string | number | "true" | "false" | "null"`,
    `string ::= "\\"" char* "\\""`,
    `char ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" hex hex hex hex)`,
    `hex ::= [0-9a-fA-F]`,
    `number ::= "-"? [0-9]+ ("." [0-9]+)?`,
    `uint ::= [0-9]+ ("." [0-9]+)?`,
    `ws ::= [ ]?`,
  ].join("\n");
}
