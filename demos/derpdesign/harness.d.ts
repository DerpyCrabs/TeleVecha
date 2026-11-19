// The DerpDesign installation supplies this module to the gallery dev server.
declare module '@derpdesign/harness' {
  export function runScenario(
    setup: (context: { conditions: Record<string, unknown> }) => Promise<void>,
  ): Promise<unknown>;
}
