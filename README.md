# Magepack (ESM Edition) 🚀

**Modern Frontend Bundling for Magento 2 (Adobe Commerce)**

**CURRENTLY IN BETA-TEST**

[![Latest Stable Version](https://img.shields.io/github/v/release/Amadeco/magepack)](https://github.com/Amadeco/magepack/releases)
[![Magento 2](https://img.shields.io/badge/Magento-2.4.8%2B-brightgreen.svg)](https://business.adobe.com/products/magento/magento-commerce.html)
[![License](https://img.shields.io/github/license/Amadeco/magepack)](LICENSE)

[SPONSOR: Amadeco](https://www.amadeco.fr)

> ⚠️ **Fork Notice:** This is a fork of the original [magesuite/magepack](https://github.com/magesuite/magepack). It has been completely **rewritten in ESM (ECMAScript Modules)** to support **Node.js 18+** and modern development standards.

Magepack is a high-performance bundling tool designed to replace Magento's default `r.js` optimizer. It solves "dependency hell" and blocking RequireJS chains by using Puppeteer to capture the exact execution order of modules and bundling them into optimized chunks.

## 🌟 Key Features

* **ESM Architecture:** Rewritten using native ES Modules (`import`/`export`) for compatibility with Node.js 18+.
* **Mobile-First Generation:** Captures execution order using a mobile viewport (`412x732`) to ensure critical mobile-specific JS is included.
* **Smart Splitting:** Automatically separates code into `vendor` (infrastructure), `common` (shared logic), and page-specific bundles (CMS, Category, Product, Checkout).
* **Magento 2.4.8+ Ready:** Automatically calculates and updates **SRI Hashes** (`sri-hashes.json`) for CSP compliance.
* **Atomic Deployment:** Builds to a temporary directory and performs an atomic swap to prevent 404s during deployment.
* **Legacy Support:** Automatically wraps non-AMD and anonymous AMD modules (like older jQuery plugins) to work within bundles.

---

## 📋 Requirements

* **Node.js:** >= 18.0.0
* **Magento:** 2.3.x / 2.4.x (Tested on 2.4.8)

## 📦 Installation

Install globally or as a dev dependency in your project:

```bash
npm install -g magepack
# OR
npm install --save-dev magepack

```

---

## 🛠️ Usage

Magepack operates in two distinct steps: **Generation** (collecting dependencies) and **Bundling** (compiling files).

### Step 1: Generate Configuration

Run this command against a running instance of your store (staging or local). Puppeteer will visit the pages to record the module loading order.

```bash
magepack generate \
  --cms-url "https://mysite.test/" \
  --category-url "https://mysite.test/gear/bags.html" \
  --product-url "https://mysite.test/joust-duffle-bag.html" \
  --timeout 30

```

**Options:**

* `--cms-url` (Required): URL of the CMS/Home page.
* `--category-url` (Required): URL of a Category page (PLP).
* `--product-url` (Required): URL of a Product page (PDP).
* `--auth-username` / `--auth-password`: For sites behind Basic Auth.
* `--skip-checkout`: Skips the checkout flow generation if not needed.

> **⚠️ Important:** Ensure your site is **clean** before generating. If Magepack detects existing `magepack/bundle-*` files, it will stop to prevent pollution. Run `bin/magento setup:static-content:deploy -f` to reset before generating.

### Step 2: Bundle Assets

Once `magepack.config.js` is generated, run the bundling command in your Magento root. This allows you to bundle without a running database (ideal for CI/CD).

```bash
magepack bundle --minify --sourcemap

```

**Options:**

* `--minify`: Minifies the output using Terser (defaults to 'safe' mode).
* `--minify-strategy`: Choose `safe` (compatibility) or `aggressive` (performance).
* `--sourcemap`: Generates `.map` files for debugging.
* `--theme`: Limit bundling to a specific theme (e.g., `Magento/luma`).

---

## ⚙️ Configuration (`magepack.config.js`)

Magepack generates a `magepack.config.js` file. You can modify this manually to exclude modules or customize selectors.

### 1. Excluding Modules

Exclude buggy extensions or payment gateways that should not be bundled.

```javascript
module.exports = {
    exclusions: [
        'Magento_Paypal/',
        'Amazon_Payment/',
        'Vertex_'
    ],
    bundles: [...] // Generated content
};

```

### 2. Custom Selectors (Checkout)

If your theme uses custom classes for swatches or the Add-to-Cart button (e.g., Hyvä-based hybrids or custom Luma themes), you can override the default selectors to ensure the checkout generator works correctly.

```javascript
module.exports = {
    // Custom CSS selectors for Puppeteer interaction
    selectors: {
        swatchAttribute: '.my-custom-swatch-wrapper',
        swatchOption: '.my-option-class:not(.disabled)',
        dropdownAttribute: '.legacy-super-attribute-select',
        addToCartButton: '#custom-add-to-cart-id'
    },
    bundles: [...] 
};

```

---

## 🔒 Security (SRI & CSP)

Magepack v3.0 automatically handles **Subresource Integrity (SRI)** for Magento 2.4.8+.
After bundling, it updates `pub/static/frontend/.../sri-hashes.json` with the SHA-256 hashes of the new bundles and the modified `requirejs-config.js`.

---

## 📄 License

Open Software License v. 3.0 (OSL-3.0).

---

**Credits:**
Original concept and implementation by [magesuite](https://github.com/magesuite).
Forked and maintained by Amadeco.
