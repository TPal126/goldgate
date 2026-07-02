// tsup.config.ts — NOTE: the 'anthropic/index' entry is ADDED IN TASK 15
// when that file exists; building it here would fail.
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: ['esm'], dts: true, clean: true, sourcemap: true,
});
