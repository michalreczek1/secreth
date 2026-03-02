const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

function normalizeLevel(level) {
  return LEVELS[level] ? level : 'info';
}

function currentLevelValue() {
  return LEVELS[normalizeLevel(DEFAULT_LEVEL)];
}

function serializeError(error) {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
  };
}

function sanitizeMeta(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value == null) return value;
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeMeta(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = sanitizeMeta(entry, depth + 1);
    return out;
  }
  return value;
}

function write(level, event, meta = {}) {
  if (LEVELS[level] < currentLevelValue()) return;
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    service: 'secreth-online',
    env: process.env.NODE_ENV || 'development',
    ...sanitizeMeta(meta),
  };
  const line = JSON.stringify(payload);
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

function child(baseMeta = {}) {
  return {
    debug(event, meta) { write('debug', event, { ...baseMeta, ...meta }); },
    info(event, meta) { write('info', event, { ...baseMeta, ...meta }); },
    warn(event, meta) { write('warn', event, { ...baseMeta, ...meta }); },
    error(event, meta) { write('error', event, { ...baseMeta, ...meta }); },
  };
}

module.exports = {
  debug(event, meta) { write('debug', event, meta); },
  info(event, meta) { write('info', event, meta); },
  warn(event, meta) { write('warn', event, meta); },
  error(event, meta) { write('error', event, meta); },
  child,
  serializeError,
};
