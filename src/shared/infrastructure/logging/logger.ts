import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(options: { level: string; pretty?: boolean }): Logger {
  return pino({
    level: options.level,
    base: { service: 'ggi-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.dpop',
        'req.headers.cookie',
        '*.accessToken',
        '*.token',
      ],
      censor: '[redacted]',
    },
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
      : {}),
  });
}
