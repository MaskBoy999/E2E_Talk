// Smoke test for the in-depth syntax highlighters in static/chat.js
const fs = require('fs');
const src = fs.readFileSync('static/chat.js', 'utf8');
const start = src.indexOf('const CFG_JS = {');
const end = src.indexOf('function highlightSyntax(');
const block = src.slice(start, end);

const test = [
  "const NL = String.fromCharCode(10);",
  "const c = { keyword:'#c678dd', string:'#98c379', number:'#d19a66', comment:'#5c6370', function:'#61afef', type:'#e5c07b', operator:'#56b6c2', punctuation:'#abb2bf', constant:'#d19a66', parameter:'#e06c75', property:'#e06c75', preprocessor:'#c678dd', builtin:'#61afef', annotation:'#e5c07b', attribute:'#e5c07b', decorator:'#e5c07b', magic:'#56b6c2', self:'#e06c75' };",
  "const strip = (s) => s.replace(/<\\/?span[^>]*>/g, '|');",
  "const js = highlightCfamily('const x = \"a < b & c\"; // hi' + NL + 'function foo(a) { return a?.b ?? 1; }', CFG_JS, c);",
  "console.log('JS  :', strip(js));",
  "const ts = highlightCfamily('interface User { id: number; name: string }' + NL + 'const u: User = { id: 1, name: \"x\" };', CFG_TS, c);",
  "console.log('TS  :', strip(ts));",
  "const cpp = highlightCfamily('#include <iostream>' + NL + 'int main() { std::cout << \"hi\"; return 0; }', CFG_CPP, c);",
  "console.log('CPP :', strip(cpp));",
  "const java = highlightCfamily('@Override' + NL + 'public String greet(String name) { return \"hi \" + name; }', CFG_JAVA, c);",
  "console.log('JAVA:', strip(java));",
  "const cs = highlightCfamily('[Serializable]' + NL + 'public class Foo { private string _x = \"a\\\"b\"; }', CFG_CSHARP, c);",
  "console.log('CS  :', strip(cs));",
  "const py = highlightPython('def f(x):' + NL + '    # comment' + NL + '    return f\"{x + 1} items\"', c);",
  "console.log('PY  :', strip(py));",
  "const nasty = highlightCfamily('const s = \"<script>alert(1)</script> // not a comment\"; // real' + NL + '/* block */ if (a < b && c > d) { x(); }', CFG_JS, c);",
  "const open = (nasty.match(/<span/g) || []).length;",
  "const close = (nasty.match(/<\\/span>/g) || []).length;",
  "console.log('BALANCE:', open === close ? 'OK' : 'BAD ' + open + '/' + close);",
  "console.log('NASTY :', strip(nasty));",
  "try {",
  "  highlightCfamily('', CFG_JS, c);",
  "  highlightCfamily('   ' + NL + NL, CFG_JS, c);",
  "  highlightCfamily('`unterminated', CFG_JS, c);",
  "  highlightCfamily('\"unterminated string', CFG_JS, c);",
  "  highlightCfamily('a/**/', CFG_JS, c);",
  "  highlightPython('', c);",
  "  highlightPython('\"\"\"unterminated', c);",
  "  highlightPython(\"f'{\" + 'x' + '}', c);",
  "  const tri = highlightPython('x = r\"\"\"doc\"\"\" + y' + NL + 'f = f\"\"\"val {x} end\"\"\"' + NL + \"z = b'''raw''' + q\", c);",
  "  console.log('PYTRIP:', strip(tri));",
  "  const triOpen = (tri.match(/<span/g) || []).length;",
  "  const triClose = (tri.match(/<\\/span>/g) || []).length;",
  "  console.log('PYTRIP-BALANCE:', triOpen === triClose ? 'OK' : 'BAD ' + triOpen + '/' + triClose);",
  "  console.log('EDGE  : OK');",
  "} catch (e) {",
  "  console.log('EDGE  : THREW ' + e.message);",
  "}",
].join('\n');

eval(block + test);
