const tsc = require('typescript');
const tsConfig = require('../tsconfig.json');

module.exports = {
  // Jest 28+ requires process() to return { code } rather than a raw string.
  process(src, path) {
    const code = path.endsWith('.ts')
      ? tsc.transpile(src, tsConfig.compilerOptions, path, [])
      : src;
    return { code };
  },
};
