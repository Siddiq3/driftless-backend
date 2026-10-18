import { buildOpenApi } from './openapi.js';

process.stdout.write(JSON.stringify(buildOpenApi(), null, 2) + '\n');
