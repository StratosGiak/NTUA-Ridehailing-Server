import { createLogger, transports, format } from "winston";
import winston from "winston/lib/winston/config";

const customFormat = format.printf(({ level, message, timestamp }) => {
  return `[${timestamp}] ${level}: ${message}`;
});

export const loggerMain = createLogger({
  transports: [
    new transports.Console({ silent: process.env.NODE_ENV == "production" }),
    new transports.File({ level: "info", filename: "./logger/logInfo.log" }),
  ],
  format: format.combine(
    format.colorize(),
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    customFormat
  ),
});

export const loggerTraffic = createLogger({
  transports: [
    new transports.Console({ silent: process.env.NODE_ENV == "production" }),
    new transports.File({ level: "info", filename: "./logger/logTraffic.log" }),
  ],
  format: format.combine(
    format.colorize(),
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    customFormat
  ),
});
