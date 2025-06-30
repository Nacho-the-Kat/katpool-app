import { getReadableDate, getReadableTime } from './styling';
import PQueue from 'p-queue';
import winston from 'winston';
import 'winston-daily-rotate-file';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import datadogLogger from './datadog';

interface LogJobData {
  level: 'DEBUG' | 'ERROR' | 'INFO';
  message: string;
}

const { combine } = winston.format;

export default class Monitoring {
  private logQueue: PQueue;
  private debugEnabled: boolean;
  private logger: winston.Logger;

  private fileNameFormat = `katpool-app-%DATE%.log`;
  constructor(logFilePath: string = 'katpool-app-logs') {
    if (!fs.existsSync(logFilePath)) {
      fs.mkdirSync(logFilePath, { recursive: true }); // Create directory if missing
    }

    const logFormat = winston.format.printf(info => {
      const levelColor =
        {
          info: chalk.bgYellowBright.whiteBright,
          error: chalk.bgYellowBright.whiteBright,
          debug: chalk.bgYellowBright.whiteBright,
          warn: chalk.bgYellowBright.whiteBright,
        }[info.level] || chalk.whiteBright;

      return `${chalk.green(getReadableDate())} ${chalk.cyan(getReadableTime())} ${levelColor(info.level.toUpperCase())}: ${chalk.whiteBright(info.message)}`;
    });

    this.logQueue = new PQueue({ concurrency: 1 });
    this.debugEnabled = process.env.DEBUG?.trim() === '1';

    this.logger = winston.createLogger({
      level: this.debugEnabled ? 'debug' : 'info',
      format: combine(logFormat),
      transports: [
        new winston.transports.DailyRotateFile({
          filename: path.join(logFilePath, this.fileNameFormat),
          datePattern: 'YYYY-MM-DD',
          zippedArchive: true,
          maxSize: '1g',
          maxFiles: '14d',
        }),
        new winston.transports.Console({
          format: combine(logFormat),
        }),
      ],
    });
  }

  log(message: string) {
    this.logQueue.add(() => this.processLog({ level: 'INFO', message }));
  }

  debug(message: string) {
    if (this.debugEnabled) {
      this.logQueue.add(() => this.processLog({ level: 'DEBUG', message }));
    }
  }

  error(message: string) {
    datadogLogger.error(message);
    this.logQueue.add(() => this.processLog({ level: 'ERROR', message }));
  }

  private async processLog(job: LogJobData) {
    const { level, message } = job;
    this.logger.log(level.toLowerCase(), message);
  }

  async waitForQueueToDrain() {
    await this.logQueue.onIdle();
  }
}
