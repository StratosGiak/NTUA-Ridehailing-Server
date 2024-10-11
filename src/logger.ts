import { createLogger, transports, format } from "winston";
import "winston-daily-rotate-file";

const customFormat = format.printf(({ level, message, timestamp, label }) => {
  return `[${label}][${timestamp}] ${level}: ${message}`;
});

function loggerFactory(type: string) {
  return createLogger({
    transports: [
      new transports.Console({ silent: process.env.NODE_ENV === "production" }),
      new transports.DailyRotateFile({
        level: "info",
        filename: `./logs/${type}.%DATE%.log`,
        datePattern: "YYYY-w",
        zippedArchive: true,
      }),
    ],
    format: format.combine(
      format.label({ label: type.toLocaleUpperCase() }),
      format.colorize(),
      format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      customFormat
    ),
  });
}

export const loggerAPI = loggerFactory("api");

export const loggerTraffic = loggerFactory("traffic");

export const loggerMedia = loggerFactory("media");

export const loggerWebsite = loggerFactory("website");
