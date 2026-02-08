import pino from 'pino';
import { Writable } from 'stream';
import pinoPretty from 'pino-pretty';
import { DASHBOARD_ENABLED } from './config.js';
import { isDashboardActive, pushLogLine } from './dashboard.js';

function createDestination(): pino.DestinationStream {
  if (!DASHBOARD_ENABLED) {
    // Non-TTY: original behavior — pino-pretty to stdout (fd 1)
    return pinoPretty({ colorize: true }) as unknown as pino.DestinationStream;
  }

  // Dashboard mode: format with pino-pretty, route to dashboard log buffer.
  // Must use the `destination` option — .pipe() only gets raw JSON passthrough.
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      const line = chunk.toString().trimEnd();
      if (line && isDashboardActive()) {
        pushLogLine(line);
      }
      callback();
    },
  });
  collector.on('error', (err) => {
    process.stderr.write(`[dashboard] collector error: ${err.message}\n`);
  });

  const pretty = pinoPretty({ colorize: true, singleLine: true, destination: collector });
  pretty.on('error', (err) => {
    process.stderr.write(`[dashboard] pretty error: ${err.message}\n`);
  });
  return pretty as unknown as pino.DestinationStream;
}

export const logger = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  createDestination(),
);
