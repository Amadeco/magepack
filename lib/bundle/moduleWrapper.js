import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import MagicString from 'magic-string';
import jsesc from 'jsesc';

/**
 * Safely parses JavaScript content into an AST (Abstract Syntax Tree).
 *
 * It attempts to parse as an ES Module first. If that fails (often due to legacy code),
 * it falls back to parsing as a Script.
 *
 * @param {string} content - The JavaScript source code.
 * @returns {import('acorn').Node|null} The AST root node, or null if parsing fails entirely.
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
            // If parsing fails, we return null. The caller must handle this (usually by skipping wrapping).
            return null;
        }
    }
};

/**
 * Detects if a module is NOT an AMD module (i.e., it lacks a `define` call).
 *
 * Uses AST traversal to look for a specific CallExpression: `define(...)`.
 * Regex is strictly avoided here to prevent false positives (e.g., "define" inside a string).
 *
 * @param {string} moduleContents - The source code of the module.
 * @returns {boolean} True if no `define` call is found.
 */
export const isNonAmd = (moduleContents) => {
    const ast = parseAst(moduleContents);
    if (!ast) return true; // Fail-safe: treat unparseable code as non-AMD.

    let hasDefine = false;
    
    // We use walk.simple for efficiency, stopping once we find the identifier.
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
 * Wraps a legacy non-AMD script into a named `define` block.
 *
 * This allows standard scripts (like older jQuery plugins) to be bundled
 * alongside RequireJS modules without breaking the global scope or execution order.
 * It also handles Shim configuration injection (deps and exports).
 *
 * @param {string} moduleName - The module ID (e.g., 'jquery/ui-modules/widget').
 * @param {string} content - The original source code.
 * @returns {string} The wrapped source code.
 */
export const wrapNonAmd = (moduleName, content) => {
    // We bind to 'window' to preserve the global context expected by legacy scripts.
    return `define('${moduleName}', (require.s.contexts._.config.shim['${moduleName}'] && require.s.contexts._.config.shim['${moduleName}'].deps || []), function() {

    ${content}

    return (require.s.contexts._.config.shim['${moduleName}'] && require.s.contexts._.config.shim['${moduleName}'].exportsFn && require.s.contexts._.config.shim['${moduleName}'].exportsFn());
}.bind(window));`;
};

/**
 * Checks if a file path corresponds to a text resource (HTML, CSS, JSON).
 *
 * @param {string} modulePath - The file path.
 * @returns {boolean} True if the extension is not .js.
 */
export const isText = (modulePath) => !modulePath.endsWith('.js');

/**
 * Wraps a text resource (like an HTML template) into a RequireJS `text!` module.
 *
 * @param {string} moduleName - The module ID.
 * @param {string} content - The text content.
 * @returns {string} A `define` block returning the escaped string.
 */
export const wrapText = (moduleName, content) => {
    // jsesc ensures the string is safe for insertion into JS code (handles quotes, newlines, etc.)
    const escapedContent = jsesc(content);
    return `define('${moduleName}', function() {
    return '${escapedContent}';
});`;
};

/**
 * Detects if a module is an "Anonymous" AMD module.
 *
 * An anonymous AMD module is a `define` call where the first argument is NOT a string.
 * Example: `define(['jquery'], function($){...})`
 *
 * @param {string} moduleContents - The source code.
 * @returns {boolean} True if an anonymous `define` is found.
 */
export const isAnonymousAmd = (moduleContents) => {
    const ast = parseAst(moduleContents);
    if (!ast) return false;

    let isAnonymous = false;
    
    walk.simple(ast, {
        CallExpression(node) {
            // Optimization: Stop checking if we already found one (logic simulation)
            if (isAnonymous) return;

            if (
                node.callee.type === 'Identifier' &&
                node.callee.name === 'define'
            ) {
                const args = node.arguments;
                // Check if the first argument is NOT a string literal.
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
 * Transforms an Anonymous AMD module into a Named AMD module.
 *
 * This is crucial for bundling, as anonymous modules cannot coexist in a single file
 * without explicit names.
 *
 * @param {string} moduleName - The name to inject (e.g., 'mage/utils/wrapper').
 * @param {string} moduleContents - The original source code.
 * @returns {string} The transformed source code.
 */
export const wrapAnonymousAmd = (moduleName, moduleContents) => {
    const ast = parseAst(moduleContents);
    if (!ast) return moduleContents;

    const magicString = new MagicString(moduleContents);
    let modified = false;

    walk.simple(ast, {
        CallExpression(node) {
            // We only rename the FIRST define call we find (standard AMD practice).
            if (modified) return;

            if (
                node.callee.type === 'Identifier' &&
                node.callee.name === 'define'
            ) {
                const args = node.arguments;
                
                // Double-check it's anonymous before injecting
                if (
                    args.length > 0 &&
                    (args[0].type !== 'Literal' ||
                        typeof args[0].value !== 'string')
                ) {
                    // Inject the module name as the first argument
                    magicString.appendLeft(args[0].start, `'${moduleName}', `);
                    modified = true;
                }
            }
        },
    });

    return modified ? magicString.toString() : moduleContents;
};

/**
 * Main Dispatcher: Determines the appropriate wrapping strategy for a module.
 * This is the DEFAULT export expected by the bundling process.
 *
 * @param {string} moduleName - The unique ID of the module (e.g., 'jquery').
 * @param {string} content - The raw content of the file.
 * @returns {string} The processed content, ready for bundling.
 */
export default (moduleName, content) => {
    // 1. Handle Text Resources (HTML templates, JSON, etc.)
    if (isText(moduleName)) {
        return wrapText(moduleName, content);
    }

    // 2. Handle Legacy Scripts (Non-AMD)
    // These need to be wrapped in a define() block to work with RequireJS.
    if (isNonAmd(content)) {
        return wrapNonAmd(moduleName, content);
    }

    // 3. Handle Anonymous AMD Modules
    // These have a define() but no name. We inject the name.
    if (isAnonymousAmd(content)) {
        return wrapAnonymousAmd(moduleName, content);
    }

    // 4. Standard Named AMD Modules
    // These are already perfect (e.g., define('my-module', ...)). Return as is.
    return content;
};
