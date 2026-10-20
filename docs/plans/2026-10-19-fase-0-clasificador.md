# Fase 0 · Contrato y clasificador: plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: usar `superpowers:subagent-driven-development` (recomendado: todas las tareas son TypeScript puro con tests) o `superpowers:executing-plans` para ejecutar este plan tarea por tarea. Los pasos usan checkboxes (`- [ ]`).

**Objetivo:** que `pulso-api` tenga, antes de cualquier ruta HTTP, el contrato de eventos y el clasificador de cortes testeados, más una herramienta que mida los exportes reales del registrador de la app.

**Arquitectura:** un solo paquete pnpm. En esta fase solo existe `src/domain/` (funciones puras, sin Hono ni base de datos), `src/testing/` y `scripts/spike/`. El Worker, PostgreSQL y las rutas llegan en la fase 1.

**Stack:** Node 24, pnpm 12.14, TypeScript estricto, Zod 4 vía `@hono/zod-openapi` 1.6, Vitest 5, Biome y tsx.

**Spec:** `docs/classifier.md` (reglas y tests), `docs/api.md` (contrato de eventos), `pulso-app/docs/detection.md` (señales y mecanismos), `pulso-app/docs/decisions.md` (D-004, D-008, D-016).

## Restricciones globales

- `packageManager: "pnpm@12.14.0"` y `engines.node: ">=24"`. Nombre del paquete: `pulso-api`.
- `z` siempre desde `@hono/zod-openapi` (Zod 4), para que en la fase 1 los mismos esquemas generen el OpenAPI (A-002).
- Todas las horas son epoch ms (`number`). America/Caracas es UTC−4 fijo, sin horario de verano, y se usa solo para resumir y mostrar.
- Constantes: `MIN_OUTAGE_MS = 600_000`, `TRANSITION_MS = 180_000`, `CONFIRMATION_TOLERANCE_MS = 300_000`.
- Los campos del evento son exactamente los de `docs/api.md`: `kind, id, at, source, plugged, onWifi, homeWifi, internet, interactive, batteryPct` / `kind, id, at, value` / `kind, id, at, outageStart, answer`.
- `src/domain/` no importa nada de Hono, `src/db/` ni `src/modules/`.
- Código e identificadores en inglés; documentación y nombres de tests en español.
- Commits en Conventional Commits. Al cerrar una tarea, marcar su línea en `docs/roadmap.md` en el mismo commit.

## Foco de revisión

1. **Dos mecanismos registran en el mismo milisegundo** (C y D al desenchufar): el resultado no puede depender del orden de entrada. Lo cubre el test "no depende del orden de entrada con empate de hora" (tarea 3).
2. **Snapshots repetidos**, porque el teléfono solo sube cambios y el exporte local trae todos: el resultado no cambia. Lo cubre el test "snapshots repetidos no cambian el resultado" (tarea 3).
3. **El teléfono se apaga durante el corte** y arranca enchufado horas después: el corte se cierra en el snapshot `boot`. Lo cubre el test "reiniciar enchufado durante el corte lo cierra" (tarea 3).
4. **Un corte cruza la medianoche de Caracas**: se reparte entre los dos días. Lo cubre el test "reparte un corte que cruza la medianoche de Caracas" (tarea 6).
5. **Un exporte trae un evento malformado** (una fuente nueva que la app agregó primero): el análisis lo cuenta y sigue. Lo cubre el test "acepta un exporte con un evento inválido y lo deja para validar aparte" (tarea 7).

---

## Estructura de archivos

```text
package.json · tsconfig.json · .gitignore · biome.json · vitest.config.ts
.github/workflows/ci.yml
src/domain/events/schema.ts (+ .test.ts)          # contrato de eventos y lotes
src/domain/detection/constants.ts                 # MIN_OUTAGE_MS, TRANSITION_MS, CONFIRMATION_TOLERANCE_MS
src/domain/detection/types.ts                     # HomeMode, OutageStatus, DetectedOutage
src/domain/detection/detect-outages.ts            # máquina de estados base y UPS, reportes
src/domain/detection/detect-outages.base.test.ts
src/domain/detection/detect-outages.ups.test.ts
src/domain/detection/detect-outages.reports.test.ts
src/domain/detection/apply-confirmations.ts (+ .test.ts)
src/domain/detection/classify.ts (+ .test.ts)
src/domain/detection/summarize.ts (+ .test.ts)
src/domain/time/caracas.ts (+ .test.ts)
src/domain/spike/schema.ts (+ .test.ts)           # formato del exporte del registrador
src/testing/builders.ts                           # snap(), report(), confirmation()
scripts/spike/measure.ts (+ .test.ts) · scripts/spike/analyze.ts
test/fixtures/sample-export.json
```

---

### Tarea 1: Repo, herramientas y CI

**Archivos:**
- Crear: `package.json`, `.gitignore`, `biome.json`, `tsconfig.json`, `vitest.config.ts`, `.github/workflows/ci.yml`

**Interfaces:**
- Produce los scripts:
  - `lint` (`biome check .`) y `format` (`biome format --write .`)
  - `typecheck` (`tsc --noEmit`) y `test` (`vitest run`)
  - `spike:analyze` (`tsx scripts/spike/analyze.ts`)

- [ ] **Paso 1:** `git init` en `pulso-api/` y crear los archivos.
  - `.gitignore`: `node_modules`, `.wrangler`, `.dev.vars`, `coverage`, `test/fixtures/private/` y `.DS_Store`.
  - `biome.json`: recomendado, comillas simples, 2 espacios, ancho 100.
  - `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `module` `preserve`, `moduleResolution` `bundler`, `target` `ES2022`.
  - Vitest con `include: ['src/**/*.test.ts', 'scripts/**/*.test.ts']` y `passWithNoTests: true`.
  - Dependencias: `@hono/zod-openapi`, `hono` y `zod`; de desarrollo, `typescript`, `vitest`, `@biomejs/biome` y `tsx`.
  - En `package.json`: `"packageManager": "pnpm@12.14.0"` y `"engines": { "node": ">=24" }`.
- [ ] **Paso 2:** `pnpm install`
- [ ] **Paso 3:** Verificar con `pnpm lint && pnpm typecheck && pnpm test`. Esperado: sale con código 0.
- [ ] **Paso 4:** `ci.yml` con `pnpm/action-setup`, `actions/setup-node` (Node 24, caché de pnpm), `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` y `pnpm test`, en `push` y `pull_request`.
- [ ] **Paso 5:** Crear el repo público `pulso-api` con `gh repo create` (público: CI gratis y portafolio; confirmarlo con Isaac) y hacer push. Esperado: el workflow `ci` en verde en GitHub.
- [ ] **Paso 6:** Commit `chore: repo pulso-api con biome, vitest y ci`

### Tarea 2: Contrato de eventos

**Archivos:**
- Crear: `src/domain/events/schema.ts` (código en `docs/api.md`, sección "Contrato de eventos"), `src/domain/events/schema.test.ts`, `src/testing/builders.ts`

**Interfaces:**
- Produce: `snapshotSourceSchema`, `snapshotEventSchema`, `reportEventSchema`, `confirmationEventSchema`, `deviceEventSchema`, `diagnosticsSchema` y `eventBatchSchema`. Tipos: `SnapshotSource`, `SnapshotEvent`, `ReportEvent`, `ConfirmationEvent`, `DeviceEvent`, `Diagnostics` y `EventBatch`.
- Produce, en `src/testing/builders.ts`:
  - `T0 = Date.UTC(2026, 10, 1, 22, 0)` (domingo 1 de noviembre, 6:00 p. m. en Caracas), `MIN = 60_000` y `at(minute): number = Math.round(T0 + minute * MIN)`. Redondea para que un minuto fraccionario dé un epoch entero
  - `snap(minute, plugged, onWifi, extra?)`: `SnapshotEvent` con `source: 'heartbeat'`, `homeWifi: null`, `internet: onWifi ? true : null`, `interactive: null` y `batteryPct: 80` por defecto
  - `report(minute, value)`: `ReportEvent`
  - `confirmation(minute, outageStartMinute, answer)`: `ConfirmationEvent`
  - Los ids salen de un contador global con la forma `00000000-0000-7000-8000-<contador de 12 dígitos>`, así que crecen en orden de creación

- [ ] **Paso 1: Escribir el test que falla**

```ts
// src/domain/events/schema.test.ts
import { describe, expect, it } from 'vitest';
import { deviceEventSchema, eventBatchSchema } from './schema';

const diagnostics = {
  appVersion: '0.1.0', manufacturer: 'Xiaomi', model: 'Redmi Note 13', sdkInt: 35,
  standbyBucket: 10, ignoringBatteryOptimizations: true, pendingEvents: 0,
};
const snapshot = {
  kind: 'snapshot', id: '0192f3a4-5b6c-7d8e-9f01-23456789abcd', at: 1_793_570_400_000,
  source: 'heartbeat', plugged: true, onWifi: true, homeWifi: null, internet: true,
  interactive: false, batteryPct: 80,
};

describe('eventBatchSchema', () => {
  it('acepta un lote válido', () => {
    expect(eventBatchSchema.safeParse({ sentAt: 1_793_570_460_000, diagnostics, events: [snapshot] }).success).toBe(true);
  });
  it('acepta un lote vacío como latido', () => {
    expect(eventBatchSchema.safeParse({ sentAt: 1_793_570_460_000, diagnostics, events: [] }).success).toBe(true);
  });
  it('rechaza más de 200 eventos', () => {
    const events = Array.from({ length: 201 }, () => snapshot);
    expect(eventBatchSchema.safeParse({ sentAt: 1, diagnostics, events }).success).toBe(false);
  });
});

describe('deviceEventSchema', () => {
  it('rechaza una fuente desconocida', () => {
    expect(deviceEventSchema.safeParse({ ...snapshot, source: 'magic' }).success).toBe(false);
  });
  it('rechaza batteryPct fuera de 0..100', () => {
    expect(deviceEventSchema.safeParse({ ...snapshot, batteryPct: 101 }).success).toBe(false);
    expect(deviceEventSchema.safeParse({ ...snapshot, batteryPct: -1 }).success).toBe(false);
  });
  it('rechaza un id que no es uuid', () => {
    expect(deviceEventSchema.safeParse({ ...snapshot, id: 'abc' }).success).toBe(false);
  });
  it('distingue el tipo por kind', () => {
    const parsed = deviceEventSchema.parse({ kind: 'report', id: snapshot.id, at: snapshot.at, value: 'sin_luz' });
    expect(parsed.kind).toBe('report');
  });
});
```

- [ ] **Paso 2:** `pnpm test`. Esperado: FALLA porque no existe `./schema`.
- [ ] **Paso 3:** Implementar `schema.ts` tal cual `docs/api.md`, y `builders.ts` con las firmas de arriba.
- [ ] **Paso 4:** `pnpm test`. Esperado: PASA (7 tests).
- [ ] **Paso 5:** Commit `feat(domain): contrato de eventos en zod`

### Tarea 3: Clasificador, modo base

**Archivos:**
- Crear: `src/domain/detection/constants.ts`, `types.ts`, `detect-outages.ts`, `detect-outages.base.test.ts`

**Interfaces:**
- Consume: `DeviceEvent`, `SnapshotEvent` (tarea 2) y los builders.
- Produce: `MIN_OUTAGE_MS`, `TRANSITION_MS`, `CONFIRMATION_TOLERANCE_MS`; `type HomeMode = 'base' | 'ups'`; `type OutageStatus = 'abierto' | 'cerrado' | 'descartado' | 'sin_datos'`; `type DetectedOutage = { start: number; end: number | null; status: Exclude<OutageStatus, 'sin_datos'>; confidence: 'alta' | 'media' | 'manual'; confirmed: boolean | null }`; `detectOutages(events: readonly DeviceEvent[], options: { mode: HomeMode }): DetectedOutage[]` (en esta tarea ignora todo lo que no sea `snapshot`).

- [ ] **Paso 1: Escribir los tests que fallan**

```ts
// src/domain/detection/detect-outages.base.test.ts
import { describe, expect, it } from 'vitest';
import type { DeviceEvent } from '../events/schema';
import { at, snap } from '../../testing/builders';
import { detectOutages } from './detect-outages';
import type { DetectedOutage } from './types';

const base = (events: DeviceEvent[]) => detectOutages(events, { mode: 'base' });
const outage = (
  startMin: number, endMin: number | null, status: DetectedOutage['status'],
  confidence: DetectedOutage['confidence'] = 'alta',
): DetectedOutage => ({ start: at(startMin), end: endMin === null ? null : at(endMin), status, confidence, confirmed: null });

describe('detectOutages (modo base)', () => {
  it('cierra cuando vuelven corriente y Wi-Fi', () => {
    expect(base([snap(0, true, true), snap(5, false, false), snap(125, true, true)])).toEqual([outage(5, 125, 'cerrado')]);
  });
  it('descarta caídas de menos de 10 min', () => {
    expect(base([snap(0, true, true), snap(5, false, false), snap(9, true, true)])).toEqual([outage(5, 9, 'descartado')]);
  });
  it('descarta Wi-Fi desconocido sin carga', () => {
    expect(base([snap(0, true, true), snap(20, false, false), snap(90, false, true)])).toEqual([outage(20, 90, 'descartado')]);
  });
  it('sigue abierto mientras arranca el router', () => {
    expect(base([snap(0, true, true), snap(5, false, false), snap(60, true, false)])).toEqual([outage(5, null, 'abierto')]);
  });
  it('tolera señales desordenadas', () => {
    expect(base([snap(125, true, true), snap(0, true, true), snap(5, false, false)])).toEqual([outage(5, 125, 'cerrado')]);
  });
  it('abre aunque llegue una señal intermedia de transición', () => {
    expect(base([snap(0, true, true), snap(5, false, true), snap(6, false, false), snap(100, true, true)]))
      .toEqual([outage(5, 100, 'cerrado')]);
  });
  it('no abre si el Wi-Fi se cae después de TRANSITION_MS', () => {
    expect(base([snap(0, true, true), snap(5, false, true), snap(30, false, false)])).toEqual([]);
  });
  it('no abre si cargaba fuera de casa', () => {
    expect(base([snap(0, true, false), snap(5, false, false)])).toEqual([]);
  });
  it('el fin es la hora en que volvió la corriente', () => {
    expect(base([snap(0, true, true), snap(5, false, false), snap(120, true, false), snap(122, true, true)]))
      .toEqual([outage(5, 120, 'cerrado')]);
  });
  it('un parpadeo mientras arranca el router mueve el fin', () => {
    expect(base([snap(0, true, true), snap(5, false, false), snap(120, true, false), snap(121, false, false), snap(130, true, true)]))
      .toEqual([outage(5, 130, 'cerrado')]);
  });
  it('el Wi-Fi de casa sin corriente cierra el corte', () => {
    expect(base([
      snap(0, true, true, { homeWifi: true }),
      snap(5, false, false, { homeWifi: false }),
      snap(100, false, true, { homeWifi: true }),
    ])).toEqual([outage(5, 100, 'cerrado')]);
  });
  it('otra red Wi-Fi no cierra el corte', () => {
    expect(base([
      snap(0, true, true, { homeWifi: true }),
      snap(5, false, false, { homeWifi: false }),
      snap(40, false, true, { homeWifi: false }),
    ])).toEqual([outage(5, null, 'abierto')]);
  });
  it('snapshots repetidos no cambian el resultado', () => {
    expect(base([
      snap(0, true, true), snap(1, true, true), snap(5, false, false), snap(30, false, false),
      snap(60, false, false), snap(125, true, true), snap(126, true, true),
    ])).toEqual([outage(5, 125, 'cerrado')]);
  });
  it('no depende del orden de entrada con empate de hora', () => {
    const events = [snap(0, true, true), snap(5, false, true), snap(5, false, false), snap(100, true, true)];
    expect(base([...events].reverse())).toEqual(base(events));
    expect(base(events)).toEqual([outage(5, 100, 'cerrado')]);
  });
  it('reiniciar enchufado durante el corte lo cierra', () => {
    expect(base([snap(0, true, true), snap(5, false, false), snap(600, true, true, { source: 'boot' })]))
      .toEqual([outage(5, 600, 'cerrado')]);
  });
});
```

- [ ] **Paso 2:** `pnpm test detect-outages.base`. Esperado: FALLA porque no existe `./detect-outages`.
- [ ] **Paso 3:** Implementar `detectOutages` con las tablas de "Modo base" de `docs/classifier.md`. Es una sola pasada sobre una copia ordenada por `(at, id)`, con el estado `{ armed, transitionStart, open, pluggedAt }`. Un snapshot `powered` deja `armed = true` y `transitionStart = null`. Después de cerrar un corte, `armed = powered(s)`. Separar la lógica en `stepBase(state, s)` para que la tarea 4 agregue `stepUps` sin tocarla.
- [ ] **Paso 4:** `pnpm test`. Esperado: PASA.
- [ ] **Paso 5:** Commit `feat(domain): clasificador de cortes en modo base`

### Tarea 4: Clasificador, modo UPS

**Archivos:**
- Crear: `src/domain/detection/detect-outages.ups.test.ts`
- Modificar: `src/domain/detection/detect-outages.ts`

**Interfaces:**
- Consume: lo de la tarea 3.
- Produce: `detectOutages(events, { mode: 'ups' })`.

- [ ] **Paso 1: Escribir los tests que fallan**

```ts
// src/domain/detection/detect-outages.ups.test.ts
import { describe, expect, it } from 'vitest';
import type { DeviceEvent } from '../events/schema';
import { at, snap } from '../../testing/builders';
import { detectOutages } from './detect-outages';
import type { DetectedOutage } from './types';

const ups = (events: DeviceEvent[]) => detectOutages(events, { mode: 'ups' });
const outage = (
  startMin: number, endMin: number | null, status: DetectedOutage['status'],
  confidence: DetectedOutage['confidence'] = 'media',
): DetectedOutage => ({ start: at(startMin), end: endMin === null ? null : at(endMin), status, confidence, confirmed: null });
const idle = { interactive: false } as const;

describe('detectOutages (modo UPS)', () => {
  it('abre y cierra cuando la corriente se va sola con la pantalla apagada', () => {
    expect(ups([snap(0, true, true, idle), snap(5, false, true, idle), snap(95, true, true)])).toEqual([outage(5, 95, 'cerrado')]);
  });
  it('ignora el desenchufe con la pantalla encendida', () => {
    expect(ups([snap(0, true, true, idle), snap(5, false, true, { interactive: true })])).toEqual([]);
  });
  it('ignora interactive null', () => {
    expect(ups([snap(0, true, true), snap(5, false, true)])).toEqual([]);
  });
  it('ignora si no estaba en casa', () => {
    expect(ups([snap(0, true, false, idle), snap(5, false, false, idle)])).toEqual([]);
  });
  it('sigue abierto si el UPS se agota', () => {
    expect(ups([snap(0, true, true, idle), snap(5, false, true, idle), snap(240, false, false)])).toEqual([outage(5, null, 'abierto')]);
  });
  it('descarta caídas de menos de 10 min', () => {
    expect(ups([snap(0, true, true, idle), snap(5, false, true, idle), snap(8, true, true)])).toEqual([outage(5, 8, 'descartado')]);
  });
  it('corriente y Wi-Fi juntos abren con alta', () => {
    expect(ups([snap(0, true, true), snap(5, false, false), snap(65, true, true)])).toEqual([outage(5, 65, 'cerrado', 'alta')]);
  });
  it('descarta si aparece en otra red', () => {
    expect(ups([
      snap(0, true, true, { homeWifi: true, interactive: false }),
      snap(5, false, true, { homeWifi: true, interactive: false }),
      snap(30, false, true, { homeWifi: false }),
    ])).toEqual([outage(5, 30, 'descartado')]);
  });
});
```

- [ ] **Paso 2:** `pnpm test detect-outages.ups`. Esperado: FALLA (el modo `ups` todavía se comporta como el base).
- [ ] **Paso 3:** Implementar `stepUps` según "Modo router con UPS" de `docs/classifier.md`. Sin corte abierto, primero se prueba la regla UPS (el snapshot anterior era `powered`) y, si no aplica, se cae en las reglas sin corte del modo base. Con corte abierto, cierra con `plugged` (`end = at`).
- [ ] **Paso 4:** `pnpm test`. Esperado: PASA (base y UPS).
- [ ] **Paso 5:** Commit `feat(domain): modo router con UPS en el clasificador`

### Tarea 5: Reportes, confirmaciones y `classify`

**Archivos:**
- Crear: `src/domain/detection/detect-outages.reports.test.ts`, `apply-confirmations.ts`, `apply-confirmations.test.ts`, `classify.ts`, `classify.test.ts`
- Modificar: `src/domain/detection/detect-outages.ts`

**Interfaces:**
- Produce: `applyConfirmations(outages: readonly DetectedOutage[], events: readonly DeviceEvent[]): DetectedOutage[]` y `classify(events: readonly DeviceEvent[], options: { mode: HomeMode }): DetectedOutage[]` (`classify = applyConfirmations(detectOutages(events, options), events)`).

- [ ] **Paso 1: Escribir los tests que fallan**

```ts
// src/domain/detection/detect-outages.reports.test.ts
import { describe, expect, it } from 'vitest';
import { at, report, snap } from '../../testing/builders';
import { detectOutages } from './detect-outages';

const base = (events: Parameters<typeof detectOutages>[0]) => detectOutages(events, { mode: 'base' });

describe('reportes manuales', () => {
  it('sin_luz sin corte abierto abre uno manual', () => {
    expect(base([snap(0, true, true), report(10, 'sin_luz')]))
      .toEqual([{ start: at(10), end: null, status: 'abierto', confidence: 'manual', confirmed: null }]);
  });
  it('hay_luz cierra el corte abierto', () => {
    expect(base([snap(0, true, true), snap(5, false, false), report(50, 'hay_luz')]))
      .toEqual([{ start: at(5), end: at(50), status: 'cerrado', confidence: 'alta', confirmed: null }]);
  });
  it('fluctuando no crea cortes', () => {
    expect(base([snap(0, true, true), report(3, 'fluctuando'), snap(4, true, true)])).toEqual([]);
  });
  it('un snapshot repetido no cierra un corte manual', () => {
    expect(base([snap(0, true, true), report(10, 'sin_luz'), snap(25, true, true)]))
      .toEqual([{ start: at(10), end: null, status: 'abierto', confidence: 'manual', confirmed: null }]);
  });
  it('el corte manual se cierra al entrar en powered', () => {
    expect(base([snap(0, false, false), report(10, 'sin_luz'), snap(60, true, true)]))
      .toEqual([{ start: at(10), end: at(60), status: 'cerrado', confidence: 'manual', confirmed: null }]);
  });
  it('sin_luz con un corte abierto no cambia nada', () => {
    expect(base([snap(0, true, true), snap(5, false, false), report(7, 'sin_luz'), snap(65, true, true)]))
      .toEqual([{ start: at(5), end: at(65), status: 'cerrado', confidence: 'alta', confirmed: null }]);
  });
});
```

```ts
// src/domain/detection/apply-confirmations.test.ts
import { describe, expect, it } from 'vitest';
import { at, confirmation } from '../../testing/builders';
import { applyConfirmations } from './apply-confirmations';
import type { DetectedOutage } from './types';

const closed: DetectedOutage = { start: at(5), end: at(125), status: 'cerrado', confidence: 'alta', confirmed: null };

describe('applyConfirmations', () => {
  it('answer false descarta el corte', () => {
    expect(applyConfirmations([closed], [confirmation(130, 5, false)])).toEqual([{ ...closed, status: 'descartado', confirmed: false }]);
  });
  it('answer true lo confirma', () => {
    expect(applyConfirmations([closed], [confirmation(130, 5, true)])).toEqual([{ ...closed, confirmed: true }]);
  });
  it('tolera hasta 5 min de diferencia en outageStart', () => {
    expect(applyConfirmations([closed], [confirmation(130, 9, true)])).toEqual([{ ...closed, confirmed: true }]);
  });
  it('una confirmación sin corte cercano se ignora', () => {
    expect(applyConfirmations([closed], [confirmation(130, 20, false)])).toEqual([closed]);
  });
  it('la última confirmación manda', () => {
    expect(applyConfirmations([closed], [confirmation(140, 5, false), confirmation(130, 5, true)]))
      .toEqual([{ ...closed, status: 'descartado', confirmed: false }]);
  });
});
```

```ts
// src/domain/detection/classify.test.ts
import { expect, it } from 'vitest';
import { at, confirmation, snap } from '../../testing/builders';
import { classify } from './classify';

it('classify aplica las confirmaciones sobre lo detectado', () => {
  expect(classify([snap(0, true, true), snap(5, false, false), snap(125, true, true), confirmation(130, 5, false)], { mode: 'base' }))
    .toEqual([{ start: at(5), end: at(125), status: 'descartado', confidence: 'alta', confirmed: false }]);
});
```

- [ ] **Paso 2:** `pnpm test`. Esperado: FALLAN los de reportes, `applyConfirmations` y `classify`.
- [ ] **Paso 3:** En `detect-outages.ts`, procesar los eventos `report` dentro de la misma pasada, en ambos modos, según "Reportes y confirmaciones" de `docs/classifier.md`. Un corte `manual` solo lo cierran `hay_luz` o un snapshot que entra en `powered` cuando el snapshot anterior no lo estaba: hay que llevar `prevPowered`. Abrir uno manual desarma el estado del modo base. Implementar `applyConfirmations` (la última por `at` dentro de `CONFIRMATION_TOLERANCE_MS`) y `classify`.
- [ ] **Paso 4:** `pnpm test`. Esperado: PASAN todos los de base, UPS y reportes.
- [ ] **Paso 5:** Commit `feat(domain): reportes manuales y confirmaciones`

### Tarea 6: Resumen por día en Caracas

**Archivos:**
- Crear: `src/domain/time/caracas.ts`, `caracas.test.ts`, `src/domain/detection/summarize.ts`, `summarize.test.ts`

**Interfaces:**
- Produce:
  - `CARACAS_OFFSET_MS = -14_400_000`
  - `caracasDate(ts: number): string` (formato `YYYY-MM-DD`)
  - `startOfCaracasDay(ts: number): number`
  - `startOfCaracasWeek(ts: number): number` (lunes a las 00:00)
  - `type OutageSummary = { totalMs: number; days: { date: string; ms: number }[] }`
  - `summarizeOutages(outages: readonly { start: number; end: number | null; status: OutageStatus }[], range: { from: number; to: number; now: number }): OutageSummary`. Solo suman `cerrado` y `abierto` (este último hasta `now`), recortados a `[from, to)`. `days` trae todos los días del rango, también los que suman 0, en orden ascendente.

- [ ] **Paso 1: Escribir los tests que fallan**

```ts
// src/domain/time/caracas.test.ts
import { expect, it } from 'vitest';
import { caracasDate, startOfCaracasDay, startOfCaracasWeek } from './caracas';

const VET = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m - 1, d, h + 4, min);

it('caracasDate usa la fecha local de Caracas', () => {
  expect(caracasDate(Date.UTC(2026, 10, 2, 3, 59))).toBe('2026-11-01');
});
it('startOfCaracasDay vuelve a la medianoche local', () => {
  expect(startOfCaracasDay(VET(2026, 11, 4, 12))).toBe(VET(2026, 11, 4, 0));
});
it('startOfCaracasWeek vuelve al lunes', () => {
  expect(startOfCaracasWeek(VET(2026, 11, 4, 12))).toBe(Date.UTC(2026, 10, 2, 4, 0));
});
```

```ts
// src/domain/detection/summarize.test.ts
import { expect, it } from 'vitest';
import { summarizeOutages } from './summarize';

const MIN = 60_000;
const VET = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m - 1, d, h + 4, min);

it('reparte un corte que cruza la medianoche de Caracas', () => {
  const outages = [{ start: VET(2026, 11, 1, 23, 30), end: VET(2026, 11, 2, 1, 30), status: 'cerrado' as const }];
  expect(summarizeOutages(outages, { from: VET(2026, 11, 1, 0), to: VET(2026, 11, 3, 0), now: VET(2026, 11, 3, 0) })).toEqual({
    totalMs: 120 * MIN,
    days: [{ date: '2026-11-01', ms: 30 * MIN }, { date: '2026-11-02', ms: 90 * MIN }],
  });
});
it('un corte abierto cuenta hasta now', () => {
  const outages = [{ start: VET(2026, 11, 2, 10), end: null, status: 'abierto' as const }];
  expect(summarizeOutages(outages, { from: VET(2026, 11, 2, 0), to: VET(2026, 11, 3, 0), now: VET(2026, 11, 2, 12) }))
    .toEqual({ totalMs: 120 * MIN, days: [{ date: '2026-11-02', ms: 120 * MIN }] });
});
it('descartados y sin_datos no suman', () => {
  const outages = [
    { start: VET(2026, 11, 2, 10), end: VET(2026, 11, 2, 11), status: 'descartado' as const },
    { start: VET(2026, 11, 2, 12), end: null, status: 'sin_datos' as const },
  ];
  expect(summarizeOutages(outages, { from: VET(2026, 11, 2, 0), to: VET(2026, 11, 3, 0), now: VET(2026, 11, 2, 23) }))
    .toEqual({ totalMs: 0, days: [{ date: '2026-11-02', ms: 0 }] });
});
it('recorta al rango', () => {
  const outages = [{ start: VET(2026, 10, 31, 22), end: VET(2026, 11, 1, 2), status: 'cerrado' as const }];
  expect(summarizeOutages(outages, { from: VET(2026, 11, 1, 0), to: VET(2026, 11, 2, 0), now: VET(2026, 11, 2, 0) }))
    .toEqual({ totalMs: 120 * MIN, days: [{ date: '2026-11-01', ms: 120 * MIN }] });
});
```

- [ ] **Paso 2:** `pnpm test`. Esperado: FALLAN los de `caracas` y `summarize`.
- [ ] **Paso 3:** Implementar con aritmética de epoch y `CARACAS_OFFSET_MS`, sin `Intl` ni librerías de fechas (Venezuela no tiene horario de verano).
- [ ] **Paso 4:** `pnpm test && pnpm typecheck && pnpm lint`. Esperado: todo en verde.
- [ ] **Paso 5:** Commit `feat(domain): resumen de horas sin luz por día en Caracas`

### Tarea 7: Formato del exporte y `pnpm spike:analyze`

**Archivos:**
- Crear: `src/domain/spike/schema.ts`, `src/domain/spike/schema.test.ts`, `scripts/spike/measure.ts`, `scripts/spike/measure.test.ts`, `scripts/spike/analyze.ts`, `test/fixtures/sample-export.json`

**Interfaces:**
- Consume: `diagnosticsSchema`, `deviceEventSchema`, `SnapshotSource` (tarea 2) y `classify` (tarea 5).
- Produce, en `src/domain/spike/schema.ts`:
  - `nativeDiagnosticsSchema = diagnosticsSchema.extend({ storedEvents: z.number().int().min(0), homeNetworkLearned: z.boolean(), armed: z.object({ networkCallback: z.boolean(), heartbeat: z.boolean(), chargingJob: z.boolean(), foregroundService: z.boolean() }) })`
  - `spikeExportSchema = z.object({ exportedAt: epochMs, diagnostics: nativeDiagnosticsSchema, events: z.array(z.unknown()) })`. Los eventos se validan uno por uno después. Es el formato que escribe `Exporter.kt` en `pulso-app`.
- Produce, en `scripts/spike/measure.ts`:
  - `type TruthOutage = { start: number; end: number | null }`. Son los pares `report sin_luz` → siguiente `report hay_luz`.
  - `type MechanismRow = { source: SnapshotSource; truthStart: number; startLatencyMs: number | null; endLatencyMs: number | null }`
  - `measureMechanisms(events: readonly DeviceEvent[]): { truths: TruthOutage[]; rows: MechanismRow[]; bySource: Record<SnapshotSource, { hits: number; total: number; medianStartLatencyMs: number | null }> }`
  - `startLatencyMs` es el primer snapshot de esa fuente con `plugged: false` dentro de `[start − 5 min, end)`, menos `start`. Puede ser negativo: el mecanismo vio el corte antes de que la persona tocara el botón.
  - `endLatencyMs` es el primer snapshot de esa fuente con `plugged: true` dentro de `[end − 5 min, end + 60 min]`, menos `end`.

- [ ] **Paso 1: Escribir los tests que fallan**
  - `src/domain/spike/schema.test.ts`: "acepta un exporte con un evento inválido y lo deja para validar aparte". Un sobre con un evento válido y otro con `batteryPct: -1` pasa `spikeExportSchema`, y `deviceEventSchema.safeParse` sobre el segundo falla.

```ts
// scripts/spike/measure.test.ts
import { expect, it } from 'vitest';
import { at, report, snap } from '../../src/testing/builders';
import { measureMechanisms } from './measure';

const events = [
  snap(0, true, true, { source: 'heartbeat' }),
  report(60, 'sin_luz'),
  snap(60.33, false, true, { source: 'charging_job' }),
  snap(72, false, false, { source: 'heartbeat' }),
  report(180, 'hay_luz'),
  snap(180.5, true, false, { source: 'charging_job' }),
];

it('mide el retraso de cada mecanismo frente a los botones', () => {
  const result = measureMechanisms(events);
  expect(result.truths).toEqual([{ start: at(60), end: at(180) }]);
  expect(result.rows).toContainEqual({ source: 'charging_job', truthStart: at(60), startLatencyMs: at(60.33) - at(60), endLatencyMs: 30_000 });
  expect(result.rows).toContainEqual({ source: 'heartbeat', truthStart: at(60), startLatencyMs: 12 * 60_000, endLatencyMs: null });
  expect(result.bySource.charging_job).toEqual({ hits: 1, total: 1, medianStartLatencyMs: at(60.33) - at(60) });
  expect(result.bySource.power_receiver).toEqual({ hits: 0, total: 1, medianStartLatencyMs: null });
});

it('un corte sin hay_luz queda sin fin', () => {
  expect(measureMechanisms([report(10, 'sin_luz')]).truths).toEqual([{ start: at(10), end: null }]);
});
```

`at()` redondea (tarea 2), así que `snap(60.33, …)` produce un epoch entero.

- [ ] **Paso 2:** `pnpm test spike`. Esperado: FALLAN porque no existen `schema.ts` ni `measure.ts`.
- [ ] **Paso 3:** Implementar `schema.ts` y `measure.ts`. Después, `analyze.ts`: lee la ruta del primer argumento, valida el sobre con `spikeExportSchema` y luego evento por evento, e imprime:
  - el diagnóstico
  - cuántos eventos inválidos hubo
  - `console.table(bySource)`
  - los cortes de `classify` en modo `base` y en modo `ups`, al lado de las verdades
- [ ] **Paso 4:** Escribir `test/fixtures/sample-export.json` a mano (un corte, dos fuentes) y correr `pnpm test && pnpm spike:analyze test/fixtures/sample-export.json`. Esperado: tests en verde y una tabla con una fila por fuente.
- [ ] **Paso 5:** Commit `feat(spike): formato del exporte y análisis del registrador`

---

## Cierre de la fase

- `pnpm lint && pnpm typecheck && pnpm test` está en verde y el CI de GitHub también.
- El primer exporte real del Xiaomi (llega de la tarea 6 del plan de `pulso-app`) pasa por `pnpm spike:analyze`. Si contiene un corte real, se copia a `test/fixtures/` como caso de regresión.
- `docs/roadmap.md` tiene la fase 0 marcada. El plan de la fase 1 se escribe en `docs/plans/` antes de empezarla.
