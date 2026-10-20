export type HomeMode = 'base' | 'ups';

// 'sin_datos' lo asigna el cron `sweep` en el servidor, nunca el clasificador.
export type OutageStatus = 'abierto' | 'cerrado' | 'descartado' | 'sin_datos';

export type DetectedOutage = {
  start: number; // epoch ms
  end: number | null; // null = en curso
  status: Exclude<OutageStatus, 'sin_datos'>;
  confidence: 'alta' | 'media' | 'manual';
  confirmed: boolean | null;
};
