const SENSITIVE_KEY = /(?:^|[_-])(cookie|cookies|token|authorization|auth|api[_-]?key|password|passwd|secret|http[_-]?headers)(?:$|[_-])/i;

export function redactSensitive(value) {
  let text = String(value ?? '');
  const replacements = [
    [/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, '$1[REDACTED]'],
    [/(cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]'],
    [/\b((?:bearer|basic)\s+)[A-Za-z0-9._~+\/-]{8,}={0,2}/gi, '$1[REDACTED]'],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]'],
    [/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED]'],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]'],
    [/(--cookies(?:-from-browser)?)(?:=|\s+)\S+/gi, '$1 [REDACTED]'],
    [/\b(cookie|cookies|api[_-]?token|access[_-]?token|refresh[_-]?token|token|api[_-]?key|password|passwd|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]'],
    [/([?&](?:token|key|auth|signature|sig|lsig|spc|ip|policy|key-pair-id)=)[^&#\s]+/gi, '$1[REDACTED]'],
    [/https?:\/\/(?:[^\s/"']+\.)?googlevideo\.com\/[^\s"']*/gi, '[REDACTED_MEDIA_URL]'],
    [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s\/:@]+:[^\s\/@]+@/gi, '$1[REDACTED]@'],
  ];
  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  return text;
}

export function sanitizeMetadata(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSensitive(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => sanitizeMetadata(item, seen));
    seen.delete(value);
    return result;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.replace(/([a-z])([A-Z])/g, '$1_$2');
    if (SENSITIVE_KEY.test(`_${normalizedKey}_`)) continue;
    if (/^(?:formats|requested_formats)$/i.test(normalizedKey) && Array.isArray(item)) {
      result[key] = item
        .filter((format) => format && typeof format === 'object' && !Array.isArray(format))
        .map((format) => Object.fromEntries([
          'format_id', 'ext', 'acodec', 'vcodec', 'abr', 'tbr', 'asr', 'filesize', 'filesize_approx',
        ].filter((field) => format[field] !== undefined).map((field) => [field, sanitizeMetadata(format[field], seen)])));
      continue;
    }
    result[key] = sanitizeMetadata(item, seen);
  }
  seen.delete(value);
  return result;
}

export function safeError(error, fallback = 'external process failed') {
  if (!error) return fallback;
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitive(message || fallback);
}

const COMMON_ENV = new Set([
  'PATH', 'HOME', 'LANG', 'LANGUAGE', 'LC_ALL', 'TZ',
  'TMPDIR', 'TMP', 'TEMP',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
]);
const NETWORK_ENV = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]);
const MEDIA_ENV = new Set([
  'TERM', 'COLORTERM',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
  'PULSE_SERVER', 'PULSE_COOKIE', 'PIPEWIRE_REMOTE', 'ALSA_CONFIG_PATH',
]);

export function safeProcessEnv(environment = process.env, options = {}) {
  const result = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (value === undefined || SENSITIVE_KEY.test(`_${key}_`)) continue;
    if (COMMON_ENV.has(key)
      || (options.network === true && NETWORK_ENV.has(key))
      || (options.media === true && MEDIA_ENV.has(key))
      || /^LC_[A-Z_]+$/.test(key)) {
      result[key] = String(value);
    }
  }
  return result;
}
