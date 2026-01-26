import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import MagicString from 'magic-string';
import jsesc from 'jsesc';

/**
 * Helper to safely parse JS code.
 * Returns null if parsing fails (e.g. syntax error in source file).
 */
const parseAst = (content) => {
    try {
        return acorn.parse(content, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            locations: false,
        });
    } catch (e) {
        try {
            return acorn.parse(content, {
                ecmaVersion: 'latest',
                sourceType: 'script',
                locations: false,
            });
        } catch (fallbackError) {
            return null;
        }
    }
};

/**
 * Tells if given module is a non-AMD JavaScript code.
 * AST Logic: Scans for any CallExpression named 'define'.
 *
 * @param {string} moduleContents Contents of the module.
 */
export const isNonAmd = (moduleContents) => {
    const ast = parseAst(moduleContents);
    if (!ast) return true; // Treat unparseable code as non-AMD to be safe

    let hasDefine = false;
    walk.simple(ast, {
        CallExpression(node) {
            if (
                node.callee.type === 'Identifier' &&
                node.callee.name === 'define'
            ) {
                hasDefine = true;
            }
        },
    });

    return !hasDefine;
};

/**
 * Wraps non-AMD module so it can be safely inlined into the bundle.
 */
export const wrapNonAmd = (moduleName, content) => {
    return `define('${moduleName}', (require.s.contexts._.config.shim['${moduleName}'] && require.s.contexts._.config.shim['${moduleName}'].deps || []), function() {

    ${content}

    return (require.s.contexts._.config.shim['${moduleName}'] && require.s.contexts._.config.shim['${moduleName}'].exportsFn && require.s.contexts._.config.shim['${moduleName}'].exportsFn());
}.bind(window));`;
};

/**
 * Tells if given module is a text type.
 */
export const isText = (modulePath) => !modulePath.endsWith('.js');

/**
 * Wraps a text module (HTML, JSON, etc.) so it can be safely inlined into the bundle.
 */
export const wrapText = (moduleName, content) => {
    const escapedContent = jsesc(content);
    return `define('${moduleName}', function() {
    return '${escapedContent}';
});`;
};

/**
 * Tells if given module contains anonymous AMD module definition.
 */
export const isAnonymousAmd = (moduleContents) => {
    const ast = parseAst(moduleContents);
    if (!ast) return false;

    let isAnonymous = false;
    walk.simple(ast, {
        CallExpression(node) {
            if (isAnonymous) return;

            if (
                node.callee.type === 'Identifier' &&
                node.callee.name === 'define'
            ) {
                const args = node.arguments;
                if (args.length > 0) {
                    const firstArg = args[0];
                    if (
                        firstArg.type !== 'Literal' ||
                        typeof firstArg.value !== 'string'
                    ) {
                        isAnonymous = true;
                    }
                }
            }
        },
    });

    return isAnonymous;
};

/**
 * Changes anonymous AMD module into the named one to be able to bundle it.
 */
export const wrapAnonymousAmd = (moduleName, moduleContents) => {
    const ast = parseAst(moduleContents);
    if (!ast) return moduleContents;

    const magicString = new MagicString(moduleContents);
    let modified = false;

    walk.simple(ast, {
        CallExpression(node) {
            if (modified) return;

            if (
                node.callee.type === 'Identifier' &&
                node.callee.name === 'define'
            ) {
                const args = node.arguments;
                // Verify it's anonymous (first arg is not a string)
                if (
                    args.length > 0 &&
                    (args[0].type !== 'Literal' ||
                        typeof args[0].value !== 'string')
                ) {
                    magicString.appendLeft(args[0].start, `'${moduleName}', `);
                    modified = true;
                }
            }
        },
    });

    return modified ? magicString.toString() : moduleContents;
};
