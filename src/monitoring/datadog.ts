import axios from 'axios';

const { DATADOG_SECRET, DATADOG_LOG_URL } = process.env;

interface LogContext {
    [key: string]: any;
    traceId?: string;
}

const sendLog = async (level: string, message: string, context: LogContext = {}) => {
    const baseLogObject = {
        ddsource: 'nodejs',
        service: process.env.DATADOG_SERVICE_NAME || 'prod-katpool-app',
        timestamp: new Date().toISOString(),
    };

    await axios.post(
        DATADOG_LOG_URL!,
        {
            ...baseLogObject,
            ...context,
            level,
            message,
        },
        {
            headers: {
                'Content-Type': 'application/json',
                'DD-API-KEY': DATADOG_SECRET!,
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