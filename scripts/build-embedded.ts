import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const webDist = path.resolve(__dirname, '../web/dist');
const outputFile = path.resolve(__dirname, '../src/embedded-web.ts');

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const embeddedFiles: Record<string, { content: string; encoding: 'utf-8' | 'base64'; contentType: string }> = {};

function scanDir(dir: string, baseDir: string) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath, baseDir);
    } else if (entry.isFile()) {
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      const ext = path.extname(entry.name).toLowerCase();
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const isBinary = !contentType.startsWith('text/') && !contentType.startsWith('application/javascript') && !contentType.startsWith('application/json') && contentType !== 'image/svg+xml';
      
      const buffer = fs.readFileSync(fullPath);
      if (isBinary) {
        embeddedFiles[relPath] = {
          content: buffer.toString('base64'),
          encoding: 'base64',
          contentType,
        };
      } else {
        embeddedFiles[relPath] = {
          content: buffer.toString('utf-8'),
          encoding: 'utf-8',
          contentType,
        };
      }
    }
  }
}

if (fs.existsSync(webDist)) {
  scanDir(webDist, webDist);
}

const content = `// 自动生成：单可执行文件内置前端静态资源
export interface EmbeddedFile {
  content: string;
  encoding: 'utf-8' | 'base64';
  contentType: string;
}

export const EMBEDDED_WEB_FILES: Record<string, EmbeddedFile> = ${JSON.stringify(embeddedFiles, null, 2)};
`;

fs.writeFileSync(outputFile, content, 'utf-8');
console.log(`Successfully embedded ${Object.keys(embeddedFiles).length} files into ${outputFile}`);
