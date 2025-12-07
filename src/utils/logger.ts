import winston from 'winston';
import path from 'path';

/**
 * Winston Logger Configuration
 * Levels: ERROR, WARN, INFO, DEBUG
 * Components: websocket, retell, feedback, payment, auth, database, api, http
 * 
 * Log Strategy:
 * - HTTP: All incoming requests with method, path, status, duration
 * - API: Endpoint-specific business logic
 * - AUTH: User validation and session management
 * - DATABASE: Query operations and data access
 * - PAYMENT: Transaction processing
 * - FEEDBACK: Interview feedback generation
 * - WEBSOCKET: Real-time communication
 */

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack, component, ...metadata }) => {
    const comp = component ? `[${component}]` : '';
    let log = `${timestamp} [${level.toUpperCase().padEnd(7)}]${comp} ${message}`;
    
    // Add metadata if present (excluding internal fields)
    const metaKeys = Object.keys(metadata).filter(k => !['service', 'level', 'timestamp'].includes(k));
    if (metaKeys.length > 0) {
      const metaObj: Record<string, unknown> = {};
      metaKeys.forEach(k => metaObj[k] = metadata[k]);
      log += ` ${JSON.stringify(metaObj)}`;
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
  winston.format.printf(({ level, message, timestamp, component, ...metadata }) => {
    const comp = component ? `[${component}]` : '';
    let log = `${timestamp} [${level}]${comp} ${message}`;
    
    const metaKeys = Object.keys(metadata).filter(k => !['service', 'level', 'timestamp', 'stack'].includes(k));
    if (metaKeys.length > 0) {
      const metaObj: Record<string, unknown> = {};
      metaKeys.forEach(k => metaObj[k] = metadata[k]);
      log += ` ${JSON.stringify(metaObj)}`;
    }
    
    return log;
  })
);

// Create logs directory
const logsDir = path.join(process.cwd(), 'logs');

// Determine log level based on environment
// Use 'info' for better visibility of request flow
const isProduction = process.env.NODE_ENV === 'production';
const logLevel = process.env.LOG_LEVEL || 'info';

const logger = winston.createLogger({
  level: logLevel,
  format: logFormat,
  defaultMeta: { service: 'voxly-backend' },
  transports: [
    // Console output with colors - show info level for request visibility
    new winston.transports.Console({
      format: coloredFormat,
      level: logLevel
    }),
    
    // Error log file
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    
    // Combined log file - all levels for debugging
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      level: 'info',
      maxsize: 5242880, // 5MB
      maxFiles: 3
    }),
    
    // Request-specific log file for tracing data flow issues
    new winston.transports.File({
      filename: path.join(logsDir, 'requests.log'),
      level: 'info',
      maxsize: 10485760, // 10MB
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
export const dbLogger = logger.child({ component: 'database' });
export const apiLogger = logger.child({ component: 'api' });
export const httpLogger = logger.child({ component: 'http' });

export default logger;
