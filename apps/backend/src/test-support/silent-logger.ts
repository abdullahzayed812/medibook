import { createLogger, type Logger } from '../shared/logger/logger.js';

export function silentLogger(): Logger {
  return createLogger({ level: 'silent', pretty: false, service: 'test' });
}
