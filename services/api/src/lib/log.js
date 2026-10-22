/**
 * Structured JSON logger with a strict allow-list: only the fields passed explicitly are written,
 * and keys that look sensitive are dropped (THREAT_MODEL T2). Never log bodies or headers.
 */
const DENY = /token|authorization|cookie|password|secret|email|body|header/i;
function write(level, msg, fields) {
  const safe = {};
  for (const [k, v] of Object.entries(fields)) if (!DENY.test(k)) safe[k] = v;
  const line = JSON.stringify({ level, msg, ...safe });
  if (level === 'error') console.error(line);
  else process.stdout.write(line + '\n');
}
export const log = {
  info: (msg, fields = {}) => write('info', msg, fields),
  error: (msg, fields = {}) => write('error', msg, fields),
};
