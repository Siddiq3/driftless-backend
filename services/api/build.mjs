// Bundles each Lambda handler into dist/<name>/index.mjs for CDK `Code.fromAsset`.
import { build } from 'esbuild';
import { readdirSync } from 'node:fs';

const handlers = readdirSync('src/handlers').filter((f) => f.endsWith('.ts'));
await Promise.all(
  handlers.map((f) =>
    build({
      entryPoints: [`src/handlers/${f}`],
      outfile: `dist/${f.replace(/\.ts$/, '')}/index.mjs`,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      sourcemap: true,
      minify: true,
      // AWS SDK v3 ships in the Lambda Node.js 22 runtime.
      external: ['@aws-sdk/*'],
      banner: {
        js: "import{createRequire}from'module';const require=createRequire(import.meta.url);",
      },
    }),
  ),
);
