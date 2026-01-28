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
const MIN_USAGE_THRESHOLD = 3;

/**
 * MANUAL_COMMON_MODULES
 * List of modules that are explicitly forced into the 'common' bundle,
 * regardless of their usage count.
 * Useful for business logic that you always want available.
 *
 * @type {string[]}
 */
const MANUAL_COMMON_MODULES = [
    // Add modules here if needed, e.g.:
    // 'Amadeco_Theme/js/custom-menu'
];

/**
 * CRITICAL_EXACT_MODULES (Vendor Forced)
 * List of critical module paths (exact match) that MUST be included in the Vendor bundle.
 * These files are requested early and must be present to prevent 404/MIME errors.
 */
const CRITICAL_EXACT_MODULES = [
    'Magento_PageCache/js/form-key-provider',
    'Magento_Theme/js/responsive',
    'Magento_Theme/js/theme',
    'Magento_Translation/js/mage-translation-dictionary',
    'Magento_Ui/js/core/app',
    'Magento_Ui/js/modal/modal'
];

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
    if (CRITICAL_EXACT_MODULES.includes(cleanName)) return true;
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

export default function (bundles) {
    const vendorModules = new Map();
    const commonModules = new Map();
    const usageCounts = {};
    const discoveryOrder = [];

    // 1. Global Analysis
    bundles.forEach((bundle) => {
        Object.keys(bundle.modules).forEach((moduleName) => {
            usageCounts[moduleName] = (usageCounts[moduleName] || 0) + 1;
            if (!discoveryOrder.includes(moduleName)) {
                discoveryOrder.push(moduleName);
            }
        });
    });

    // 2. Classification & Routing
    discoveryOrder.forEach((moduleName) => {
        const cleanName = cleanModuleName(moduleName);
        const count = usageCounts[moduleName];

        const isForced = isCriticalInfrastructure(cleanName);
        const isShared = count >= MIN_USAGE_THRESHOLD;
        // Correction : On utilise la fonction locale au lieu de l'import manquant
        const isConfigured = isExplicitlyCommon(moduleName);

        if (isForced || isShared || isConfigured) {
            const sourceBundle = bundles.find((b) => b.modules[moduleName]);
            
            if (sourceBundle) {
                const modulePath = sourceBundle.modules[moduleName];
                const targetType = getTargetBundleType(cleanName);

                if (targetType === 'vendor') {
                    vendorModules.set(moduleName, modulePath);
                } else {
                    commonModules.set(moduleName, modulePath);
                }
            }
        }
    });

    // 3. Cleanup Original Bundles
    bundles.forEach((bundle) => {
        const keysToRemove = [...vendorModules.keys(), ...commonModules.keys()];
        keysToRemove.forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(bundle.modules, key)) {
                delete bundle.modules[key];
            }
        });
    });

    // 4. Assembly
    return [
        {
            name: 'vendor',
            modules: Object.fromEntries(vendorModules)
        },
        {
            name: 'common',
            modules: Object.fromEntries(commonModules)
        },
        ...bundles
    ];
}
