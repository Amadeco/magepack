/**
 * @file lib/generate/extractCommonBundle.js
 * @description Splits modules into Vendor, Common, and Page-Specific bundles ensuring strict exclusivity.
 */

/**
 * ============================================================================
 * CONSTANTS & CONFIGURATION
 * ============================================================================
 */


/**
 * MIN_USAGE_THRESHOLD
 * Determines the promotion strategy for shared modules.
 *
 * @type {number}
 * @default 2
 *
 * Strategy:
 * - 2: Balanced. If a module is used on >= 2 page types (e.g., Home + Product),
 * it moves to 'common'.
 */
const MIN_USAGE_THRESHOLD = 2;

/**
 * MANUAL_COMMON_MODULES
 * List of modules that are explicitly forced into the 'common' bundle,
 * regardless of their usage count.
 * Useful for business logic that you always want available.
 *
 * @type {string[]}
 */
const MANUAL_COMMON_MODULES = [];

/**
 * CRITICAL_EXACT_MODULES (Vendor Forced)
 * List of critical module paths (exact match) that MUST be included in the Vendor bundle.
 * These files are requested early and must be present to prevent 404/MIME errors.
 */
const CRITICAL_EXACT_MODULES = new Set([
    'Magento_PageCache/js/form-key-provider',
    'Magento_Theme/js/responsive',
    'Magento_Theme/js/theme',
    'Magento_Translation/js/mage-translation-dictionary',
    'Magento_Ui/js/core/app',
    'Magento_Ui/js/modal/modal',
    'mage/requirejs/resolver'
]);

/**
 * CRITICAL_PATTERN_MODULES (Vendor Forced via Regex)
 * Regular expressions identifying Core Infrastructure modules (Kernel).
 */
const CRITICAL_PATTERN_MODULES = [
    /^mage\/(?!calendar|gallery)/, // Magento Core Libs (excluding heavy UI)
    /^requirejs\//,                // RequireJS internals
    /^text$/,                      // RequireJS Text Plugin
    /^domReady$/,                  // RequireJS DomReady Plugin
    /^jquery\/jquery(\.min)?\.js$/,// jQuery Core
    /^jquery\/jquery-migrate/,     // jQuery Migrate
    /^jquery\/jquery-storageapi/,  // jQuery Storage
    /^underscore$/,                // Underscore.js
    /^knockoutjs\/knockout$/       // Knockout JS
];

/**
 * MAGENTO_MODULE_REGEX
 * Identifies standard Magento 2 module naming convention (Vendor_Module).
 * Used to distinguish "Business Logic" (Common) from "Libraries" (Vendor).
 */
const MAGENTO_MODULE_REGEX = /^[A-Z][a-zA-Z0-9]+_[A-Z][a-zA-Z0-9]+\//;

/**
 * ============================================================================
 * HELPER FUNCTIONS
 * ============================================================================
 */

/**
 * Normalizes a RequireJS module name.
 * @param {string} moduleName
 * @returns {string} Cleaned name
 */
const cleanModuleName = (moduleName) => {
    return moduleName
        .replace(/^[^!]+!/, '') // Remove plugins
        .replace(/\.js$/, '');  // Remove extension
};

/**
 * Checks if a module is strictly required in the Vendor bundle.
 * @param {string} cleanName
 * @returns {boolean}
 */
const isCriticalInfrastructure = (cleanName) => {
    if (CRITICAL_EXACT_MODULES.has(cleanName)) return true;
    return CRITICAL_PATTERN_MODULES.some((pattern) => pattern.test(cleanName));
};

/**
 * Determines the destination bundle type.
 * @param {string} cleanName
 * @returns {'vendor'|'common'}
 */
const getTargetBundleType = (cleanName) => {
    if (/\.(html|json)$/i.test(cleanName)) return 'common';
    if (isCriticalInfrastructure(cleanName)) return 'vendor';
    if (MAGENTO_MODULE_REGEX.test(cleanName)) return 'common';
    return 'vendor';
};

/**
 * Checks if a module is explicitly configured as common.
 * @param {string} moduleName
 * @returns {boolean}
 */
const isExplicitlyCommon = (moduleName) => {
    return MANUAL_COMMON_MODULES.includes(cleanModuleName(moduleName));
};

/**
 * ============================================================================
 * MAIN LOGIC
 * ============================================================================
 */

/**
 * Extracts common and vendor modules while preserving execution order.
 *
 * @param {Array<{name: string, modules: Object.<string, string>}>} bundles
 * @returns {Array<{name: string, modules: Object.<string, string>}>}
 */
export default function (bundles) {
    const vendorModules = new Map();
    const commonModules = new Map();
    const usageCounts = new Map();
    
    // 1. Discovery Order & Usage Analysis
    // We capture the FIRST time a module appears to establish a safe dependency order.
    // (e.g., jQuery appears before jQuery-UI in the page load sequence).
    const globalOrder = new Set();

    bundles.forEach((bundle) => {
        Object.keys(bundle.modules).forEach((moduleName) => {
            // Count usage
            const currentCount = usageCounts.get(moduleName) || 0;
            usageCounts.set(moduleName, currentCount + 1);

            // Record strict order
            globalOrder.add(moduleName);
        });
    });

    // 2. Classification & Routing (following Global Order)
    // Iterating over globalOrder ensures dependencies are written before dependents.
    globalOrder.forEach((moduleName) => {
        const cleanName = cleanModuleName(moduleName);
        const count = usageCounts.get(moduleName);

        const isForcedVendor = isCriticalInfrastructure(cleanName);
        const isShared = count >= MIN_USAGE_THRESHOLD;
        const isConfigured = isExplicitlyCommon(moduleName);

        if (isForcedVendor || isShared || isConfigured) {
            // Find the physical path from ANY bundle that has it
            const sourceBundle = bundles.find(b => b.modules[moduleName]);
            if (!sourceBundle) return;

            const modulePath = sourceBundle.modules[moduleName];
            const targetType = getTargetBundleType(cleanName);

            // Routing Logic
            if (isForcedVendor || (targetType === 'vendor' && (isShared || isConfigured))) {
                vendorModules.set(moduleName, modulePath);
            } else {
                commonModules.set(moduleName, modulePath);
            }
        }
    });

    // 3. Cleanup Original Bundles
    // Now we remove the moved modules from their original location to enforce exclusivity.
    const keysToRemove = new Set([...vendorModules.keys(), ...commonModules.keys()]);

    bundles.forEach((bundle) => {
        Object.keys(bundle.modules).forEach((key) => {
            if (keysToRemove.has(key)) {
                delete bundle.modules[key];
            }
        });
    });

    // 4. Assembly
    return [
        {
            name: 'vendor',
            modules: Object.fromEntries(vendorModules) // Preserves insertion order (ES6 Map)
        },
        {
            name: 'common',
            modules: Object.fromEntries(commonModules)
        },
        ...bundles
    ];
}
