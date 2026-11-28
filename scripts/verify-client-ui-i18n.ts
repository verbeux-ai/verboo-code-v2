/**
 * Reject product UI copy embedded directly in Client source.
 *
 * Locale dictionaries are the only source files allowed to own translated
 * text. Presentation code receives copy through its typed `t` seat or through
 * an already-localized prop. This check covers JSX text and copy-bearing
 * attributes, plus the common data/helper forms that feed them.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const MINIMUM_CLIENT_UI_SOURCES = 450

const COPY_ATTRIBUTES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-valuetext',
  'cancelLabel',
  'closeLabel',
  'confirmLabel',
  'copyLabel',
  'description',
  'emptyLabel',
  'label',
  'placeholder',
  'title',
  'truncatedLabel',
])
const COPY_ATTRIBUTE_SUFFIX = /(?:Aria|Copy|Description|Heading|Label|Message|Placeholder|Summary|Text|Title|Tooltip)$/

const COPY_NAME = /(?:^|_)(?:aria|copy|description|empty|heading|label|message|placeholder|summary|text|title|tooltip)(?:s|_.*)?$/i
const COPY_SUFFIX = /(?:aria|copy|description|empty|heading|label|labels|message|placeholder|summary|text|title|tooltip|tabs)$/i
const IMMUTABLE_LANGUAGE_TOKENS = new Set([
  'B',
  'Function',
  'GB',
  'K',
  'KB',
  'M',
  'MB',
  'Symbol',
  'false',
  'function()',
  'n',
  'null',
  'true',
  'undefined',
])
const LOCALE_KEY = /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)+$/

/** One hard-coded product-copy occurrence. */
export interface UiI18nViolation {
  /** One-based source column. */
  column: number
  /** Repository-relative source path. */
  file: string
  /** One-based source line. */
  line: number
  /** Why this literal is treated as product copy. */
  reason: string
  /** Compact literal text for the diagnostic. */
  text: string
}

function localeOwner(file: string): boolean {
  const normalized = file.replaceAll('\\', '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  return base === 'locale.ts'
    || base === 'locales.ts'
    || normalized.includes('/locales/')
}

function containsProductText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized !== ''
    && !IMMUTABLE_LANGUAGE_TOKENS.has(normalized)
    && !LOCALE_KEY.test(normalized)
    && /\p{L}/u.test(normalized)
}

function propertyName(node: ts.PropertyName | ts.BindingName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined
}

function copyAttribute(name: string): boolean {
  return !name.endsWith('Key')
    && (COPY_ATTRIBUTES.has(name) || COPY_ATTRIBUTE_SUFFIX.test(name))
}

function compactText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`
}

function looksLikeNaturalText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return /\s|[\u3400-\u9fff]/u.test(normalized) || /^[A-Z]/.test(normalized)
}

function dictionaryKeys(text: string): ReadonlySet<string> {
  const dictionary = ts.createSourceFile('locales.ts', text, ts.ScriptTarget.Latest)
  const objects = new Map<string, ts.ObjectLiteralExpression>()
  let rootName: string | undefined
  for (const statement of dictionary.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === 'Key'
      && ts.isTypeOperatorNode(statement.type) && statement.type.operator === ts.SyntaxKind.KeyOfKeyword
      && ts.isTypeQueryNode(statement.type.type) && ts.isIdentifier(statement.type.type.exprName)) {
      rootName = statement.type.type.exprName.text
    }
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue
    for (const { name, initializer } of statement.declarationList.declarations) {
      const object = initializer && ts.isAsExpression(initializer) ? initializer.expression : initializer
      if (ts.isIdentifier(name) && object && ts.isObjectLiteralExpression(object)) objects.set(name.text, object)
    }
  }
  const keys = new Set<string>()
  const seen = new Set<string>()
  const collect = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    for (const property of objects.get(name)?.properties ?? []) {
      if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) collect(property.expression.text)
      if (ts.isPropertyAssignment(property)) {
        const key = propertyName(property.name)
        if (key !== undefined) keys.add(key)
      }
    }
  }
  if (rootName !== undefined) collect(rootName)
  return keys
}

function localeKeyImport(source: ts.SourceFile): ts.Identifier | undefined {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== './locales.ts') continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    const imported = bindings.elements.find(element => (element.propertyName ?? element.name).text === 'Key')
    if (imported) return imported.name
  }
  return undefined
}

function localChecker(source: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = { noResolve: true, noLib: true, jsx: ts.JsxEmit.Preserve }
  const host = ts.createCompilerHost(options)
  host.getSourceFile = name => name === source.fileName ? source : undefined
  // Only lexical bindings are needed. Imported packages and declarations are
  // unnecessary, so the gate can run before workspace artifacts are built.
  return ts.createProgram([source.fileName], options, host).getTypeChecker()
}

function identifierUses(source: ts.SourceFile, checker: ts.TypeChecker): Map<ts.Symbol, ts.Identifier[]> {
  const uses = new Map<ts.Symbol, ts.Identifier[]>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node)
      if (symbol) {
        const existing = uses.get(symbol)
        if (existing) existing.push(node)
        else uses.set(symbol, [node])
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return uses
}

function directTranslationKey(
  declaration: ts.VariableDeclaration,
  checker: ts.TypeChecker,
  uses: ReadonlyMap<ts.Symbol, readonly ts.Identifier[]>,
): boolean {
  if (!ts.isIdentifier(declaration.name) || !ts.isVariableDeclarationList(declaration.parent)
    || !(declaration.parent.flags & ts.NodeFlags.Const)) return false
  const statement = declaration.parent.parent
  if (!ts.isVariableStatement(statement) || !ts.isBlock(statement.parent)) return false
  const symbol = checker.getSymbolAtLocation(declaration.name)
  const references = symbol ? uses.get(symbol)?.filter(use => use !== declaration.name) ?? [] : []
  // Require every read of this binding to supply a key to the local translator.
  return references.length > 0 && references.every((use) => {
    const call = use.parent
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)
      || call.expression.text !== 't' || call.arguments[0] !== use) return false
    const translator = checker.getSymbolAtLocation(call.expression)
    return translator?.declarations?.some(binding => ts.isBindingElement(binding)
      && ts.isObjectBindingPattern(binding.parent)
      && (binding.propertyName === undefined || propertyName(binding.propertyName) === 't')) === true
  })
}

/**
 * Find hard-coded product copy in one Client source file.
 * @param file - repository-relative path used in diagnostics.
 * @param sourceText - TypeScript or TSX source.
 * @param localeSource - The sibling locale dictionary, when available.
 * @returns violations in source order.
 */
export function findUiI18nViolations(file: string, sourceText: string, localeSource?: string): UiI18nViolation[] {
  if (localeOwner(file)) return []
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  )
  const violations = new Map<number, UiI18nViolation>()
  const keyImport = localeKeyImport(source)
  const keys = keyImport && localeSource !== undefined ? dictionaryKeys(localeSource) : undefined
  const checker = keys?.size ? localChecker(source) : undefined
  const keySymbol = keyImport && checker?.getSymbolAtLocation(keyImport)
  const uses = checker ? identifierUses(source, checker) : undefined

  const report = (
    node: ts.Node,
    text: string,
    reason: string,
    naturalOnly = false,
  ): void => {
    if (
      !containsProductText(text)
      || (naturalOnly && !looksLikeNaturalText(text))
      || violations.has(node.getStart(source))
    ) return
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    violations.set(node.getStart(source), {
      column: position.character + 1,
      file,
      line: position.line + 1,
      reason,
      text: compactText(text),
    })
  }

  const collectExpression = (
    node: ts.Expression,
    reason: string,
    naturalOnly = false,
    translatedKey = false,
  ): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!translatedKey || !keys?.has(node.text)) report(node, node.text, reason, naturalOnly)
      return
    }
    if (ts.isTemplateExpression(node)) {
      report(
        node,
        [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(''),
        reason,
        naturalOnly,
      )
      return
    }
    if (ts.isCallExpression(node)) {
      // A call result is dynamic; copy-bearing arguments are visited through their own syntax.
      return
    }
    if (
      ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node)
      || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node)
    ) {
      collectExpression(node.expression, reason, naturalOnly, translatedKey)
      return
    }
    if (ts.isConditionalExpression(node)) {
      collectExpression(node.whenTrue, reason, naturalOnly, translatedKey)
      collectExpression(node.whenFalse, reason, naturalOnly, translatedKey)
      return
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        collectExpression(node.right, reason, naturalOnly)
      } else if (
        node.operatorToken.kind === ts.SyntaxKind.PlusToken
        || node.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        collectExpression(node.left, reason, naturalOnly)
        collectExpression(node.right, reason, naturalOnly)
      }
      return
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (ts.isExpression(element)) collectExpression(element, reason, naturalOnly)
      }
      return
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          const name = propertyName(property.name)
          const propertyOwnsCopy = name !== undefined
            && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))
          collectExpression(property.initializer, reason, naturalOnly || !propertyOwnsCopy)
        }
      }
    }
  }

  const enclosingFunctionName = (node: ts.Node): string | undefined => {
    let current = node.parent
    while (!ts.isSourceFile(current)) {
      if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
        return current.name === undefined ? undefined : propertyName(current.name)
      }
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        const parent = current.parent
        return ts.isVariableDeclaration(parent) ? propertyName(parent.name) : undefined
      }
      current = current.parent
    }
    return undefined
  }

  const hasExplicitStringReturn = (node: ts.Node): boolean => {
    let current = node.parent
    while (!ts.isSourceFile(current)) {
      if (
        ts.isFunctionDeclaration(current)
        || ts.isMethodDeclaration(current)
        || ts.isArrowFunction(current)
        || ts.isFunctionExpression(current)
      ) return current.type?.kind === ts.SyntaxKind.StringKeyword
      current = current.parent
    }
    return false
  }

  const returnsLocaleKey = (node: ts.ReturnStatement): boolean => {
    const owner = ts.findAncestor(node.parent, ts.isFunctionLike)
    return keySymbol !== undefined && owner?.type !== undefined && ts.isTypeReferenceNode(owner.type)
      && checker?.getSymbolAtLocation(owner.type.typeName) === keySymbol
  }

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) report(node, node.text, 'JSX text')

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source)
      if (copyAttribute(name) && node.initializer !== undefined) {
        if (ts.isStringLiteral(node.initializer)) report(node.initializer, node.initializer.text, `${name} attribute`)
        else if (ts.isJsxExpression(node.initializer) && node.initializer.expression !== undefined) {
          collectExpression(node.initializer.expression, `${name} attribute`)
        }
      }
    }

    if (
      ts.isJsxExpression(node)
      && node.expression !== undefined
      && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) collectExpression(node.expression, 'JSX child')

    if ((file.endsWith('.tsx') || file.startsWith('apps/desktop/')) && ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name)
      if (name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))) {
        collectExpression(node.initializer, `${name} property`)
      }
    }

    if (file.startsWith('apps/desktop/') && ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && (node.left.name.text === 'textContent' || node.left.name.text === 'innerText')) {
      collectExpression(node.right, `${node.left.name.text} assignment`)
    }

    if (file.startsWith('apps/desktop/') && ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === 'setTitle' || node.expression.name.text === 'prompt')) {
      const copy = node.arguments[0]
      if (copy !== undefined) collectExpression(copy, `${node.expression.name.text} argument`)
    }

    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const name = propertyName(node.name)
      if (name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))) {
        const translated = checker !== undefined && uses !== undefined && directTranslationKey(node, checker, uses)
        collectExpression(node.initializer, `${name} value`, false, translated)
      }
    }

    if (ts.isBindingElement(node) && node.initializer !== undefined) {
      const name = propertyName(node.name)
      if (name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))) {
        collectExpression(node.initializer, `${name} default value`)
      }
    }

    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      const name = enclosingFunctionName(node)
      if (name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))) {
        collectExpression(node.expression, `${name} return value`, false, returnsLocaleKey(node))
      } else if (file.endsWith('.tsx') && hasExplicitStringReturn(node)) {
        collectExpression(node.expression, 'string return value', true)
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...violations.values()].sort((left, right) => left.line - right.line || left.column - right.column)
}

/**
 * Resolve the normalized Client source root containing one TSX component.
 * @param file - Glob result using native or POSIX separators.
 * @returns Repository-relative `src/client` root, or undefined outside that tree.
 */
export function clientSourceRoot(file: string): string | undefined {
  const normalized = file.replaceAll('\\', '/')
  const marker = '/src/client/'
  const index = normalized.indexOf(marker)
  return index < 0 ? undefined : normalized.slice(0, index + marker.length - 1)
}

function sourceFiles(): string[] {
  const clientComponentRoots = new Set(
    globSync('packages/*/*/src/client/**/*.tsx', { cwd: root })
      .map(clientSourceRoot)
      .filter((clientRoot): clientRoot is string => clientRoot !== undefined),
  )
  return [...new Set([
    ...globSync('packages/client/*/src/**/*.tsx', { cwd: root }),
    ...globSync('packages/client/ui-*/src/**/*.{ts,tsx}', { cwd: root }),
    ...[...clientComponentRoots].flatMap(clientRoot =>
      globSync(`${clientRoot}/**/*.{ts,tsx}`, { cwd: root })),
    ...globSync('apps/web/src/**/*.{ts,tsx}', { cwd: root }),
    ...globSync('apps/desktop/src/{main,update-coordinator}.{ts,tsx}', { cwd: root }),
    ...globSync('apps/desktop/renderer/*.js', { cwd: root }),
  ])]
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => !file.endsWith('.d.ts'))
    .sort()
}

function main(): void {
  const files = sourceFiles()
  if (files.length < MINIMUM_CLIENT_UI_SOURCES) {
    throw new Error(
      `verify-client-ui-i18n: discovery narrowed to ${files.length} source file(s); expected at least ${MINIMUM_CLIENT_UI_SOURCES}.`,
    )
  }
  const dictionaries = new Map<string, string | undefined>()
  const violations = files.flatMap((file) => {
    const path = resolve(root, file)
    const dictionaryPath = resolve(dirname(path), 'locales.ts')
    if (!dictionaries.has(dictionaryPath)) {
      dictionaries.set(dictionaryPath, existsSync(dictionaryPath) ? readFileSync(dictionaryPath, 'utf8') : undefined)
    }
    return findUiI18nViolations(file, readFileSync(path, 'utf8'), dictionaries.get(dictionaryPath))
  })
  if (violations.length > 0) {
    console.error(`verify-client-ui-i18n: ${violations.length} hard-coded UI string(s):`)
    for (const violation of violations) {
      console.error(
        `  ${violation.file}:${violation.line}:${violation.column} ${violation.reason}: ${JSON.stringify(violation.text)}`,
      )
    }
    process.exitCode = 1
    return
  }
  console.log(`verify-client-ui-i18n: ${files.length} Client UI source file(s) use locale-owned copy.`)
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
