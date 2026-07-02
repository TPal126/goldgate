// tsup.config.ts
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts', 'anthropic/index': 'anthropic/index.ts' },
  format: ['esm'], dts: true, clean: true, sourcemap: true,
});
