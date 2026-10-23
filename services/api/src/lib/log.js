/**
 * Structured JSON logger with approved scalar fields and bounded string values.
 * Callers must never place credentials in approved fields. Never log bodies or headers.
 */
const FIELDS = new Set([
  'route', 'status', 'ms', 'reqId', 'err', 'type', 'tier', 'state', 'ok', 'checked', 'changed',
]);
function write(level, msg, fields) {
  const safe = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!FIELDS.has(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) safe[k] = v;
    else if (typeof v === 'string') safe[k] = v.slice(0, 256);
  }
  const line = JSON.stringify({ level, msg, ...safe });
  if (level === 'error') console.error(line);
  else process.stdout.write(line + '\n');
}
export const log = {
  info: (msg, fields = {}) => write('info', msg, fields),
  error: (msg, fields = {}) => write('error', msg, fields),
};
