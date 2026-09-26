/** Shared source renderer for the embedded build and live source preview. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// Resolve installed browser bundles locally: neither output needs a CDN or static vendor request.
const vendors = {
  marked: path.join(path.dirname(require.resolve('marked')), 'marked.umd.js'),
  dompurify: require.resolve('dompurify/purify.min.js'),
};

export function renderWebUISource(root = projectRoot) {
  const webRoot = path.resolve(root, 'src/webui');
  return fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8').replace(/\/\* @vendor ([a-z]+) \*\//g, (_, name) => {
    if (!Object.hasOwn(vendors, name)) throw new Error('Unknown browser vendor ' + name);
    const source = fs.readFileSync(vendors[name], 'utf8').replace(/^\/\/# sourceMappingURL=.*$/gm, '');
    if (/<\/script\s*>/i.test(source)) throw new Error('Unsafe inline browser vendor ' + name);
    return source;
  }).replace(/\/\* @include ([a-zA-Z0-9_./-]+) \*\//g, (_, file) => {
    const target = path.resolve(webRoot, file);
    if (!target.startsWith(path.join(webRoot, 'client') + path.sep)) throw new Error('Invalid client module ' + file);
    const source = fs.readFileSync(target, 'utf8');
    if (/<\/script\s*>/i.test(source)) throw new Error('Client modules cannot contain a literal closing script tag: ' + file);
    // Function replacements preserve literal $&, $`, $' and $$ in JavaScript and styles.
    return source;
  });
}
