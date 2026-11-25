// Finds the text a person can read in the web console's source (0.87.1).
//
// Used by scripts/check-terminology.mjs. Pure: the workspace's TypeScript
// parses each file, nothing is compiled or run. A "visible text" is
//
//   - JSX text between tags;
//   - a string literal, or the static part of a template literal, that is
//     prose: it holds a space, or starts with a capital letter, and is not in
//     a position that can only be code (an import, a type, a property name, a
//     comparison operand, a className / href / key / id / data-* attribute,
//     an API client call's first argument).
//
// That is a heuristic. It errs towards reporting: a string the console never
// shows that happens to read like prose is reported too, and is either
// reworded or named in the checker's allowlist with a reason.

import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', 'package.json'));
const ts = require('typescript');

/** JSX attributes whose value is never read by a person. */
const CODE_ATTRS = new Set([
  'className', 'href', 'key', 'id', 'htmlFor', 'name', 'type', 'role', 'value', 'src', 'target', 'rel',
  'autoComplete', 'inputMode', 'method', 'action', 'form', 'accept', 'pattern', 'testId', 'queryKey', 'as',
  'variant', 'size', 'side', 'align', 'tone', 'kind', 'mode', 'icon', 'tab', 'defaultValue', 'scope',
]);
/** Object properties whose value is never read by a person. */
const CODE_PROPS = new Set([
  'href', 'id', 'key', 'kind', 'type', 'mode', 'value', 'queryKey', 'testId', 'className', 'icon', 'tab', 'hub',
  'path', 'route', 'code', 'scope', 'field', 'param', 'source', 'tier', 'status', 'state',
]);

function attrName(n) {
  // The JsxAttribute a literal sits in, directly or as `{'...'}`.
  let p = n.parent;
  if (p && ts.isJsxExpression(p)) p = p.parent;
  if (p && ts.isJsxAttribute(p)) return p.name.getText();
  return null;
}

/** The JSX element a text sits directly in (`code`, `p`, …), or null. */
function tagOf(n) {
  let p = n.parent;
  if (p && ts.isJsxExpression(p)) p = p.parent;
  if (p && ts.isJsxElement(p)) return p.openingElement.tagName.getText();
  return null;
}

function propName(n) {
  const p = n.parent;
  if (p && ts.isPropertyAssignment(p) && p.initializer === n) {
    const nm = p.name;
    return ts.isIdentifier(nm) || ts.isStringLiteral(nm) ? nm.text : null;
  }
  return null;
}

/** True when a literal can only be code, wherever its text came from. */
function codePosition(n) {
  const p = n.parent;
  if (!p) return true;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p)) return true;
  if (ts.isCallExpression(p) && p.expression.getText() === 'require') return true;
  if (ts.isImportTypeNode?.(p.parent)) return true;
  // A property name or an element-access key.
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p)) && p.name === n) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === n) return true;
  // A comparison or a switch case is a value, not text.
  if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return true;
  if (ts.isCaseClause(p) && p.expression === n) return true;
  // console.* and Error messages for developers.
  if (ts.isCallExpression(p) && /^console\./.test(p.expression.getText())) return true;
  const a = attrName(n);
  if (a && (CODE_ATTRS.has(a) || a.startsWith('data-'))) return true;
  const k = propName(n);
  if (k && CODE_PROPS.has(k)) return true;
  // The first argument of an HTTP client call is a URL.
  if (ts.isCallExpression(p) && p.arguments[0] === n && /\b(api|axios|client|http)\.(get|post|put|patch|delete)$/.test(p.expression.getText())) return true;
  return false;
}

function prose(text) {
  const t = text.trim();
  if (!t) return false;
  // A path, URL or query string is code even when it holds a word.
  if (/^(\/|\?|&|#|https?:)/.test(t) && !/\s/.test(t.replace(/\s+x\s+/g, ''))) return false;
  if (/\s/.test(t)) return true;
  return /^[A-Z][a-z]/.test(t) && !/[\/._:=?&]/.test(t);
}

/**
 * Every visible text in one source file.
 * Returns { kind, start, end, text, line, context } — `start`/`end` bound the
 * text itself (inside the quotes), so a caller can rewrite it in place.
 */
export function visibleTexts(fileName, source) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [];
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const push = (kind, start, end, n) => {
    const text = source.slice(start, end);
    out.push({ kind, start, end, text, line: lineOf(start), attr: attrName(n), prop: propName(n), tag: tagOf(n) });
  };
  const visit = (n) => {
    if (ts.isJsxText(n)) {
      if (n.text.trim()) push('jsx', n.getStart(sf, false), n.end, n);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (!codePosition(n) && prose(n.text)) push('string', n.getStart(sf) + 1, n.end - 1, n);
    } else if (ts.isTemplateExpression(n)) {
      if (!codePosition(n)) {
        const parts = [n.head, ...n.templateSpans.map((s) => s.literal)];
        const whole = parts.map((p) => p.text).join('');
        // `${n} computers` is prose: a substitution stands for a word.
        const spoken = parts.map((p) => p.text).join('x');
        if (prose(whole) || (/\S\s+\S/.test(spoken.trim()) && !/^(\/|\?|&|#|https?:)/.test(spoken.trim()))) {
          for (const p of parts) {
            const s = p.getStart(sf);
            // head: `...${   middle: }...${   tail: }...`
            const open = 1; const close = ts.isTemplateTail(p) ? 1 : 2;
            if (p.text.trim()) push('template', s + open, p.end - close, n);
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
