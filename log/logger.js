import { createLogger, transports, format } from "winston";
import "winston-daily-rotate-file";

const customFormat = format.printf(({ level, message, timestamp }) => {
  return `[${timestamp}] ${level}: ${message}`;
});

export const loggerMain = createLogger({
  transports: [
    new transports.Console(),
    new transports.DailyRotateFile({
      level: "info",
      filename: "./log/logs/api.%DATE%.log",
      datePattern: "YYYY-w",
      zippedArchive: true,
    }),
  ],
  format: format.combine(
    format.colorize(),
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    customFormat
  ),
});

export const loggerTraffic = createLogger({
  transports: [
    new transports.Console({ silent: process.env.NODE_ENV === "production" }),
    new transports.DailyRotateFile({
      level: "info",
      filename: "./log/logs/traffic.%DATE%.log",
      datePattern: "YYYY-w",
      zippedArchive: true,
    }),
  ],
  format: format.combine(
    format.colorize(),
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    customFormat
  ),
});

export const loggerMedia = createLogger({
  transports: [
    new transports.Console(),
    new transports.DailyRotateFile({
      level: "info",
      filename: "./log/logs/media.%DATE%.log",
      datePattern: "YYYY-w",
      zippedArchive: true,
    }),
  ],
  format: format.combine(
    format.colorize(),
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    customFormat
  ),
});
