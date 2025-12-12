# scripts.ts - High-Level Overview

This document describes the high-level functionality of `scripts.ts`, the main build, test, and publish orchestration script for the PouchDB monorepo.

## High-Level Functionality

### 1. **Build System**

- `buildModules()` - Builds all PouchDB packages/modules using Rollup
- `buildPouchDB()` - Builds the main PouchDB bundle (Node, Browserify, browser dist, plugins)
- `buildNode()` - Builds Node.js-specific versions
- `buildTest()` - Builds test utilities and performance bundles
- `buildSite()` - Builds the Jekyll documentation site

### 2. **Testing Infrastructure**

- `testNode()` - Runs tests in Node.js (integration, fuzzy, mapreduce, find, performance)
- `testBrowser()` - Runs tests in browsers using Playwright (Chromium, Firefox, WebKit)
- `testCoverage()` - Runs tests with coverage collection
- `testWebpack()` - Tests PouchDB built with Webpack instead of Browserify
- `runTest()` - Main test runner that sets up servers and runs appropriate test suite

### 3. **Development Tools**

- `devServer()` / `startDevServer()` - Starts HTTP server with file watching for development
- `runDev()` - Development mode: builds and runs tests with watch mode
- `repeatPerfTest()` - Repeatedly runs performance tests against different commits/adapters

### 4. **Publishing & Release**

- `publishPackages()` - Publishes npm packages
- `publishSite()` - Builds and publishes the documentation site
- `release()` - Full release process: updates versions, publishes packages, creates git tags
- `setVersion()` - Sets version across all packages and config files
- `updatePackageJsonForPublish()` - Updates package.json files with correct dependencies for publishing

### 5. **Verification & Quality**

- `verifyDependencies()` - Verifies that bundled packages don't contain unexpected dependencies
- `verifyBundleSize()` - Checks that the minified bundle size is within acceptable limits
- `verifyBuild()` - Comprehensive build verification
- `verifyPackageLock()` - Verifies package-lock.json is up to date

### 6. **Server Management**

- `waitForCouch()` - Waits for CouchDB/PouchDB server to be ready
- `downServer()` - Simple HTTP server that returns 500 errors (for testing error handling)
- Server setup for various backends (pouchdb-server, express-pouchdb, CouchDB)

### 7. **Utility Functions**

- File operations (`writeFile`, `addPath`)
- Minification (`doUglify`)
- Browserify bundling (`doBrowserify`)
- Port management (`findFreePort`, `isPortInUse`)
- Command execution helpers (`exec`, `commandExists`)

### 8. **CLI Interface**

- Acts as a CLI dispatcher - takes a script name and arguments, routes to the appropriate function
- Supports 20+ different script commands

## Summary

The file serves as the **central build/test/publish orchestration layer** for the PouchDB monorepo, handling builds, testing across environments, publishing, and development workflows.
