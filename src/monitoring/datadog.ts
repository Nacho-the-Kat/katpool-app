import axios from 'axios';
import { DATADOG_LOG_URL, DATADOG_SECRET, DATADOG_SERVICE_NAME } from '../constants';

interface LogContext {
  [key: string]: any;
  traceId?: string;
}

const sendLog = async (level: string, message: string, context: LogContext = {}) => {
  const baseLogObject = {
    ddtags: '',
    ddsource: 'nodejs',
    service: DATADOG_SERVICE_NAME,
    timestamp: new Date().toISOString(),
  };

  // set tag based on service name, tag does change retention period
  if (DATADOG_SERVICE_NAME === 'prod-katpool-app') {
    baseLogObject.ddtags = 'retention:production';
  }

  // override default retention tag with context tag
  if (context?.ddtags) {
    baseLogObject.ddtags = context.ddtags;
  }

  await axios.post(
    DATADOG_LOG_URL,
    {
      ...baseLogObject,
      ...context,
      level,
      message,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': DATADOG_SECRET,
      },
    }
  );
};

const logger = {
  info: (message: string, context?: LogContext) => sendLog('info', message, context),
  error: (message: string, context?: LogContext) => sendLog('error', message, context),
  warn: (message: string, context?: LogContext) => sendLog('warn', message, context),
};

export default logger;
