import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import MagicString from 'magic-string';
import jsesc from 'jsesc';

/**
 * Safely parses JavaScript content into an AST (Abstract Syntax Tree).
 *
 * @param {string} content
 * @returns {import('acorn').Node|null}
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
        } catch {
            return null;
        }
    }
};

/**
 * Detects if a module is NOT an AMD module (i.e., it lacks a `define` call).
 *
 * @param {string} moduleContents
 * @returns {boolean}
 */
export const isNonAmd = (moduleContents) => {
    const ast = parseAst(moduleContents);
    if (!ast) return true;

    let hasDefine = false;

    walk.simple(ast, {
        CallExpression(node) {
            if (node.callee.type === 'Identifier' && node.callee.name === 'define') {
                hasDefine = true;
            }
        },
    });

    return !hasDefine;
};

/**
 * Wraps a legacy non-AMD script into a named `define` block.
 *
 * @param {string} moduleName
 * @param {string} content
 * @returns {string}
 */
export const wrapNonAmd = (moduleName, content) => {
    return `define('${moduleName}', (require.s.contexts._.config.shim['${moduleName}'] && require.s.contexts._.config.shim['${moduleName}'].deps || []), function() {

    ${content}

    return (require.s.contexts._.config.shim['${moduleName}'] && require.s.contexts._.config.shim['${moduleName}'].exportsFn && require.s.contexts._.config.shim['${moduleName}'].exportsFn());
}.bind(window));`;
};

/**
 * Detects RequireJS plugin modules that represent text-like resources.
 * Magento commonly uses: text!Magento_Theme/template/...html
 *
 * @param {string} moduleName
 * @returns {boolean}
 */
const isTextPluginModuleId = (moduleName) => {
    // RequireJS plugin syntax: plugin!resource
    // We only treat "text!" as a text wrapper candidate here.
    return typeof moduleName === 'string' && moduleName.startsWith('text!');
};

/**
 * Checks if a resolved file path corresponds to a text resource.
 *
 * @param {string} modulePath
 * @returns {boolean}
 */
const isTextFilePath = (modulePath) => {
    if (!modulePath || typeof modulePath !== 'string') return false;

    // Strip query/hash if any (rare, but safe)
    const clean = modulePath.split('?')[0].split('#')[0].toLowerCase();

    // Typical non-JS assets that can appear in RequireJS through plugins or inline builds
    return (
        clean.endsWith('.html') ||
        clean.endsWith('.htm') ||
        clean.endsWith('.json') ||
        clean.endsWith('.txt') ||
        clean.endsWith('.svg') ||
        clean.endsWith('.css')
    );
};

/**
 * Checks if the module should be treated as a text resource.
 *
 * @param {string} moduleName - RequireJS module ID
 * @param {string} [modulePath] - Resolved absolute/relative file path
 * @returns {boolean}
 */
export const isText = (moduleName, modulePath) => {
    // Most reliable: file path extension
    if (isTextFilePath(modulePath)) return true;

    // Fallback: RequireJS text plugin
    if (isTextPluginModuleId(moduleName)) return true;

    return false;
};

/**
 * Wraps a text resource into a RequireJS module.
 *
 * @param {string} moduleName
 * @param {string} content
 * @returns {string}
 */
export const wrapText = (moduleName, content) => {
    const escapedContent = jsesc(content);
    return `define('${moduleName}', function() {
    return '${escapedContent}';
});`;
};

/**
 * Detects if a module is an "Anonymous" AMD module.
 *
 * @param {string} moduleContents
 * @returns {boolean}
 */
export const isAnonymousAmd = (moduleContents) => {
    const ast = parseAst(moduleContents);
    if (!ast) return false;

    let isAnonymous = false;

    walk.simple(ast, {
        CallExpression(node) {
            if (isAnonymous) return;

            if (node.callee.type === 'Identifier' && node.callee.name === 'define') {
                const args = node.arguments;
                if (args.length > 0) {
                    const firstArg = args[0];
                    if (firstArg.type !== 'Literal' || typeof firstArg.value !== 'string') {
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
 * @param {string} moduleName
 * @param {string} moduleContents
 * @returns {string}
 */
export const wrapAnonymousAmd = (moduleName, moduleContents) => {
    const ast = parseAst(moduleContents);
    if (!ast) return moduleContents;

    const magicString = new MagicString(moduleContents);
    let modified = false;

    walk.simple(ast, {
        CallExpression(node) {
            if (modified) return;

            if (node.callee.type === 'Identifier' && node.callee.name === 'define') {
                const args = node.arguments;

                if (
                    args.length > 0 &&
                    (args[0].type !== 'Literal' || typeof args[0].value !== 'string')
                ) {
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
 *
 * @param {string} moduleName - RequireJS module ID (e.g., 'Magento_Ui/js/core/app' or 'text!Magento_Theme/template/...html')
 * @param {string} content - Raw file content
 * @param {string} [modulePath] - Resolved file path used for accurate type detection
 * @returns {string}
 */
export default (moduleName, content, modulePath) => {
    // 1) Text resources must be handled first
    if (isText(moduleName, modulePath)) {
        return wrapText(moduleName, content);
    }

    // 2) Legacy non-AMD scripts
    if (isNonAmd(content)) {
        return wrapNonAmd(moduleName, content);
    }

    // 3) Anonymous AMD
    if (isAnonymousAmd(content)) {
        return wrapAnonymousAmd(moduleName, content);
    }

    return content;
};
