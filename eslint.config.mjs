import globals from 'globals';
import pluginJs from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';

// ─── Order choke point (spec §4): only these files may reach exchange order endpoints ───
// Also enforced by tests/orders/choke-point.test.ts (which covers web/client too).
const ORDER_METHODS = 'postOrders?|createOrder|createMarketOrder|createAndPostOrder|createAndPostMarketOrder';
const ORDER_ENDPOINTS = String.raw`\/(api|sapi)\/v\d+\/(order|orderList|sor\/order|margin\/order)`;
const chokePointSyntax = [
    'error',
    {
        selector: `MemberExpression[computed=false][property.name=/^(${ORDER_METHODS})$/]`,
        message: 'Exchange order methods may only be called from the exchange adapters (orders go through OrderService).',
    },
    {
        selector: `MemberExpression[computed=true][property.value=/^(${ORDER_METHODS})$/]`,
        message: 'Exchange order methods may only be called from the exchange adapters (orders go through OrderService).',
    },
    {
        selector: `Literal[value=/${ORDER_ENDPOINTS}/]`,
        message: 'Binance order endpoints may only be used in packages/core/src/exchange/binance/client.ts.',
    },
    {
        selector: `TemplateElement[value.raw=/${ORDER_ENDPOINTS}/]`,
        message: 'Binance order endpoints may only be used in packages/core/src/exchange/binance/client.ts.',
    },
];
const clobValueImports = [
    { name: '@polymarket/clob-client', allowTypeImports: true, message: 'Only type imports outside the order adapters / BotManager.' },
    { name: '@polymarket/order-utils', allowTypeImports: true, message: 'Only type imports outside the order adapters / BotManager.' },
];
const orderModuleImports = [
    {
        group: ['**/exchange/polymarket/orders', '**/exchange/polymarket/orders.*'],
        message: 'Only packages/core/src/orders/ExchangeAdapter.ts may import the Polymarket order adapter.',
    },
    {
        group: ['**/exchange/binance/client', '**/exchange/binance/client.*'],
        importNames: ['executeBinanceBuy', 'executeBinanceSell'],
        message: 'Only packages/core/src/orders/ExchangeAdapter.ts may import Binance order functions.',
    },
];
const restrictedImports = (opts) => ['error', opts];
// packages/core is transport-free (spec §1.1): no Electron, no apps/*
const coreTransportImports = [
    { name: 'electron', message: 'packages/core must not import electron (transport code lives in electron/ or apps/*).' },
];
const coreTransportPatterns = [
    { group: ['electron/*', '**/electron/**', '**/apps/**'], message: 'packages/core must not import from electron/ or apps/*.' },
];

/** @type {import('eslint').Linter.Config[]} */
export default [
    {
        // Ignore build output and compiled files. web/client has its own eslint config (React rules).
        ignores: ['dist/**', 'dist-electron/**', 'release/**', 'web/client/**', 'node_modules/**', 'coverage/**', '*.js'],
    },
    { files: ['**/*.{js,mjs,cjs,ts}'] },
    { languageOptions: { globals: { ...globals.node, ...globals.jest } } }, // Add jest globals
    pluginJs.configs.recommended,
    ...tseslint.configs.recommended,
    prettierConfig, // Disable conflicting ESLint rules with Prettier
    {
        plugins: {
            prettier: prettierPlugin, // Add the Prettier plugin
        },
        rules: {
            'prettier/prettier': 'warn', // Show Prettier formatting issues as warnings
            'no-unused-vars': 'warn', // Set no-unused-vars rule to warn
            '@typescript-eslint/no-unused-vars': 'warn', // Warn on unused vars
            '@typescript-eslint/no-explicit-any': 'warn', // Warn on any usage instead of error
            '@typescript-eslint/no-require-imports': 'warn', // Warn on require imports
            'no-case-declarations': 'off', // Allow lexical declarations in case blocks
            'no-control-regex': 'off', // Allow ANSI escape codes in regex for colored terminal output
        },
    },
    // Order choke point. Later blocks override earlier ones for the files they list.
    {
        files: ['electron/**/*.ts', 'templates/**/*.ts', 'scripts/**/*.{js,mjs,cjs,ts}'],
        rules: {
            '@typescript-eslint/no-restricted-imports': restrictedImports({ paths: clobValueImports, patterns: orderModuleImports }),
            'no-restricted-syntax': chokePointSyntax,
        },
    },
    {
        files: ['packages/core/**/*.ts'],
        rules: {
            '@typescript-eslint/no-restricted-imports': restrictedImports({
                paths: [...clobValueImports, ...coreTransportImports],
                patterns: [...orderModuleImports, ...coreTransportPatterns],
            }),
            'no-restricted-syntax': chokePointSyntax,
        },
    },
    {
        // Builds the ClobClient and the live adapters it hands to OrderService
        files: ['packages/core/src/bots/BotManager.ts', 'packages/core/src/orders/**/*.ts'],
        rules: {
            '@typescript-eslint/no-restricted-imports': restrictedImports({
                paths: coreTransportImports,
                patterns: [...orderModuleImports, ...coreTransportPatterns],
            }),
        },
    },
    {
        files: ['packages/core/src/orders/ExchangeAdapter.ts'],
        rules: { '@typescript-eslint/no-restricted-imports': restrictedImports({ paths: coreTransportImports, patterns: coreTransportPatterns }) },
    },
    {
        // The exchange adapters themselves
        files: ['packages/core/src/exchange/polymarket/orders.ts', 'packages/core/src/exchange/binance/client.ts'],
        rules: {
            '@typescript-eslint/no-restricted-imports': restrictedImports({ paths: coreTransportImports, patterns: coreTransportPatterns }),
            'no-restricted-syntax': 'off',
        },
    },
];
