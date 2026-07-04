// Post-build asset copy: the serve UI ships as a plain file next to the
// bundled CLI (dist/cli.js resolves it via `new URL('./ui/app.html',
// import.meta.url)`), so it must land at dist/ui/app.html.
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/ui', { recursive: true });
cpSync('src/ui/app.html', 'dist/ui/app.html');
console.log('copied src/ui/app.html -> dist/ui/app.html');
