export default {
  test: {
    // fredy/ is a full clone of another project (see Task 2) with its own vitest suite;
    // without this, `npm test` here also runs (and fails on) Fredy's tests.
    exclude: ['**/node_modules/**', 'fredy/**'],
  },
}
