import pino from 'pino';
import path from 'path';
import { mkdirSync } from 'fs';

const isDev = process.env.NODE_ENV !== 'production';
const logDir = path.join(process.cwd(), 'logs');
mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'server.log');

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
}, pino.transport({
  targets: [
    {
      target: 'pino-pretty',
      options: { colorize: true, ignore: 'pid,hostname' },
      level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
    },
    {
      target: 'pino/file',
      options: { destination: logFile, append: true },
      level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
    },
  ],
}));

export default logger;
