const MINUTE_MS = 60_000;

/** Un corte más corto se descarta (bajón). Valor inicial: se ajusta con las confirmaciones. */
export const MIN_OUTAGE_MS = 10 * MINUTE_MS;

/** Máximo entre "dejó de cargar" y "se cayó el Wi-Fi" para que cuente como corte. */
export const TRANSITION_MS = 3 * MINUTE_MS;

/** Cuánto puede separarse `outageStart` de una confirmación del inicio real. */
export const CONFIRMATION_TOLERANCE_MS = 5 * MINUTE_MS;
