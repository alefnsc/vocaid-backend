import winston from 'winston';
import path from 'path';

/**
 * Winston Logger Configuration
 * Three levels: INFO, WARNING, ERROR
 */

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack, ...metadata }) => {
    let log = `${timestamp} [${level.toUpperCase().padEnd(7)}] ${message}`;
    
    // Add metadata if present
    if (Object.keys(metadata).length > 0) {
      log += ` ${JSON.stringify(metadata)}`;
    }
    
    // Add stack trace for errors
    if (stack) {
      log += `\n${stack}`;
    }
    
    return log;
  })
);

const coloredFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.printf(({ level, message, timestamp, ...metadata }) => {
    let log = `${timestamp} [${level}] ${message}`;
    
    if (Object.keys(metadata).length > 0 && !metadata.stack) {
      log += ` ${JSON.stringify(metadata)}`;
    }
    
    return log;
  })
);

// Create logs directory
const logsDir = path.join(process.cwd(), 'logs');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: { service: 'voxly-backend' },
  transports: [
    // Console output with colors
    new winston.transports.Console({
      format: coloredFormat
    }),
    
    // Error log file
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    
    // Combined log file
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
});

// Namespace loggers for different components
export const wsLogger = logger.child({ component: 'websocket' });
export const retellLogger = logger.child({ component: 'retell' });
export const feedbackLogger = logger.child({ component: 'feedback' });
export const paymentLogger = logger.child({ component: 'payment' });
export const authLogger = logger.child({ component: 'auth' });

export default logger;
