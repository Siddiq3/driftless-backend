import { route } from '../router.js';
/** Lambda entry point for the v1 HTTP API (single modular function in Phase 1). */
export const handler = (event) => route(event);
