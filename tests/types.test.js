'use strict';

// src/*.d.ts are written by hand. Compile a typical use of them beside
// @surea11y/core's and @surea11y/binding-base's own types, so a declaration
// that no longer fits the engine's result fails here instead of in a
// user's build.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('the type definitions compile against @surea11y/core\'s types', () => {
  const tsc = require.resolve('typescript/bin/tsc');
  const project = path.join(__dirname, 'types', 'tsconfig.json');
  try {
    execFileSync(process.execPath, [tsc, '--project', project], { stdio: 'pipe' });
  } catch (e) {
    assert.fail(String(e.stdout) + String(e.stderr));
  }
});
