export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

interface DiagnosticEvent {
  level: DiagnosticLevel;
  area: 'auth' | 'sync' | 'transport' | 'cache' | 'outbox';
  message: string;
  details?: Record<string, unknown>;
}

export function reportDiagnostic(event: DiagnosticEvent) {
  const entry = {
    time: new Date().toISOString(),
    ...event,
  };
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
