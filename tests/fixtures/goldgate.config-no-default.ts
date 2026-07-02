// Deliberately missing a default export — loadConfig must reject this
// with a message pointing at the missing `export default defineConfig(...)`.
export const notDefault = { hello: 'world' };
