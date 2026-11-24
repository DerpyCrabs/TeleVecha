export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DiagnosticEvent {
  code?: string;
  level: DiagnosticLevel;
  area: 'auth' | 'sync' | 'transport' | 'cache' | 'outbox' | 'coordination';
  message: string;
  details?: Record<string, unknown>;
}

export interface TimestampedDiagnosticEvent extends DiagnosticEvent {
  time: string;
}

const listeners = new Set<(event: TimestampedDiagnosticEvent) => void>();

export function subscribeDiagnostics(listener: (event: TimestampedDiagnosticEvent) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportDiagnostic(event: DiagnosticEvent) {
  const entry = { time: new Date().toISOString(), ...event };
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch (error) {
      console.warn('[televecha] A diagnostic listener failed.', error);
    }
  }
  const method =
    event.level === 'debug'
      ? console.debug
      : event.level === 'info'
        ? console.info
        : event.level === 'warn'
          ? console.warn
          : console.error;
  method('[televecha]', entry);
}

export function sendFailureCode(message: string) {
  switch (message) {
    case 'Telegram ping timed out.':
      return 'ping-timeout';
    case 'Telegram request timed out.':
      return 'request-timeout';
    case 'Telegram connection timed out.':
      return 'connection-timeout';
    case 'Telegram WebSocket closed unexpectedly.':
      return 'socket-closed';
    case 'Could not read a Telegram upload part.':
      return 'file-read-failed';
    default:
      if (/^Message delivery timed out after [0-9]+ seconds\.$/u.test(message))
        return 'delivery-timeout';
      return 'recorded-send-failure';
  }
}
