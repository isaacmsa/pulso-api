# Clasificador de cortes

**Qué responde este documento**

- Qué funciones convierten los eventos de una casa en cortes
- Las reglas del modo base, del modo UPS, de los reportes y de las confirmaciones
- Qué tests deben pasar siempre

Las señales y los mecanismos que las producen están en `pulso-app/docs/detection.md`. El clasificador vive solo aquí (D-016 del producto): la app no clasifica.

## Funciones

Funciones puras en `src/domain/detection/`, sin Hono ni base de datos. `POST /v1/events` las corre sobre la ventana de eventos de cada casa, y `pnpm spike:analyze` sobre los exportes del registrador, sin los reportes (los botones son la verdad con la que se compara; A-013).

```ts
detectOutages(events: readonly DeviceEvent[], options: { mode: HomeMode }): DetectedOutage[]
applyConfirmations(outages: readonly DetectedOutage[], events: readonly DeviceEvent[]): DetectedOutage[]
classify(events: readonly DeviceEvent[], options: { mode: HomeMode }): DetectedOutage[] // detect + confirmaciones

type HomeMode = 'base' | 'ups';
type DetectedOutage = {
  start: number;        // epoch ms
  end: number | null;   // null = en curso
  status: 'abierto' | 'cerrado' | 'descartado';
  confidence: 'alta' | 'media' | 'manual';
  confirmed: boolean | null;
};
```

| Constante | Valor | Para qué |
| --- | --- | --- |
| `MIN_OUTAGE_MS` | 10 min | Un corte más corto se descarta (bajón), cierre como cierre: snapshot, `hay_luz` o corte manual. Valor inicial: se ajusta con las confirmaciones |
| `TRANSITION_MS` | 3 min | Máximo entre "dejó de cargar" y "se cayó el Wi-Fi" para que cuente como corte |
| `CONFIRMATION_TOLERANCE_MS` | 5 min | Cuánto puede separarse `outageStart` de una confirmación del inicio real |

Definiciones: `atHome(s) = s.homeWifi ?? s.onWifi` y `powered(s) = s.plugged && atHome(s)`. Los eventos se ordenan por `at` y, si empatan, por `id`.

**Propiedad que siempre se cumple:** repetir un snapshot con el mismo `(plugged, onWifi, homeWifi, internet)` no cambia el resultado. Esto permite que el teléfono suba solo los cambios de estado y que el servidor llegue a lo mismo que la app.

### Modo base: el router se apaga con el corte

Sin corte abierto:

| Snapshot | Efecto |
| --- | --- |
| `powered` | Queda "armado" (la casa tenía luz) |
| Armado, `!plugged && atHome` | Empieza la transición: `transitionStart` toma su hora si estaba vacío |
| Armado, `!plugged && !atHome` | Si `at − (transitionStart ?? at) ≤ TRANSITION_MS`, abre un corte con `start = transitionStart ?? at` y confianza `alta`. En cualquier caso, desarma |
| Cualquier otro (por ejemplo, cargando sin Wi-Fi) | Desarma |

Con corte abierto:

| Snapshot | Efecto |
| --- | --- |
| `plugged && !atHome` | Sigue abierto: el router está arrancando. Guarda `pluggedAt` si estaba vacío |
| `!plugged` sin Wi-Fi | Sigue abierto y borra `pluggedAt` (fue un parpadeo) |
| `atHome && (plugged \|\| homeWifi === true)` | Cierra con `end = pluggedAt ?? at`. Queda `cerrado` si duró `MIN_OUTAGE_MS` o más; si no, `descartado`. **Regla con huella:** el Wi-Fi de casa sin corriente también cierra, porque el router tiene luz |
| `onWifi && !plugged && homeWifi === null` | `descartado` en `at`: Wi-Fi desconocido sin carga suele ser alguien que desenchufó y salió |
| `onWifi && homeWifi === false` | Sigue abierto: el teléfono está en otra red y no sabe nada de la casa |

### Modo router con UPS: el Wi-Fi no se cae

- **Abre** cuando el snapshot anterior era `powered` y el actual es `!plugged && atHome && interactive === false`. Confianza `media`.
- También abre con la regla del modo base (corriente y Wi-Fi caen juntos: el UPS se agotó o no había UPS). Confianza `alta`.
- **Cierra** con el primer snapshot `plugged`, aunque el Wi-Fi todavía no haya vuelto.
- **Descarta** un corte `media` si aparece en otra red (`onWifi && homeWifi === false`; **regla con huella**). Un corte `alta` sigue abierto en otra red, como en el modo base: pudo abrirse con un snapshot que ya estaba en otra red (se fue la luz, murió el router y el teléfono se pasó al Wi-Fi del vecino), y repetir ese snapshot no puede descartarlo. Un `media` siempre se abre en el Wi-Fi de casa, así que ahí no hay conflicto.
- Si se agota el UPS y cae el Wi-Fi, el corte sigue abierto.
- No aplica el descarte del modo base por Wi-Fi desconocido sin carga (`onWifi && !plugged && homeWifi === null`): un corte `media` se abre justo con Wi-Fi y sin carga, así que sin huella esa regla lo descartaría con la primera copia del snapshot que lo abrió, y rompería la invariancia.
- Con `interactive` en `true` o `null` al desenchufar, no abre.
- Los reportes y las confirmaciones funcionan igual que en el modo base.

### Reportes y confirmaciones

| Evento | Efecto |
| --- | --- |
| `report` `sin_luz` sin corte abierto | Abre un corte con confianza `manual` |
| `report` `hay_luz` con corte abierto | Lo cierra en `at`. Después queda armado si el último snapshot estaba en `powered`, porque un reporte no trae estado de carga |
| `report` `fluctuando` | No crea cortes. El historial lo muestra como bajón |
| Corte manual abierto | Solo lo cierran un `hay_luz` o un snapshot que **entra** en `powered` desde otro estado. Un snapshot repetido no lo cierra |
| Cualquier cierre (snapshot, `hay_luz` o corte manual) | `MIN_OUTAGE_MS` aplica siempre: si duró menos de 10 min, queda `descartado`, aunque sea un corte manual |
| Reporte y snapshot con la misma `at` | Se ordenan por `id`, como cualquier empate. El resultado no depende del orden en que lleguen |
| `confirmation` | Se aplica al corte cuyo `start` esté a `CONFIRMATION_TOLERANCE_MS` o menos de `outageStart`. Si cae en la tolerancia de varios cortes, va al de `start` más cercano (en empate, al más temprano). Si hay varias confirmaciones, manda la última. `answer: false` deja el corte `descartado` con `confirmed: false`; `answer: true` deja `confirmed: true` |

En el servidor, un corte `abierto` que pasa 24 horas sin eventos nuevos queda `sin_datos` y no suma horas. Es una regla de tiempo y vive en el cron `sweep`, no en el clasificador.

## Del clasificador a la base

`classify` devuelve los cortes de la ventana de la casa. `reconcileOutages` los compara con los que ya están guardados y devuelve solo los cambios (`src/domain/detection/reconcile.ts`). No genera ids: el servicio pone el uuid v7 de los inserts.

- **Emparejamiento:** uno a uno, en orden de `start`. Cada corte detectado toma el guardado libre de `start` más cercano que esté a `RECONCILE_TOLERANCE_MS` (5 min) o menos. En empate, el de `start` más temprano. Un guardado se usa una sola vez.
- **Par igual** (mismos `start`, `end`, `status`, `confidence` y `confirmed`): no hay cambio.
- **Par distinto:** `update` del mismo `id` con lo detectado. Así un corte que se cierra, o cuyo inicio se mueve un poco, sigue siendo el mismo.
- **Detectado sin pareja:** `insert`.
- **Guardado sin pareja:** `update` a `descartado`, con sus horas intactas. Si ya estaba `descartado`, no hay cambio.
- **Orden de salida:** primero los cambios de los detectados (por `start`) y después los descartes (por `start`).

`deriveHomeStatus` (`src/domain/detection/home-status.ts`) calcula el estado de la casa con lo detectado:

- Con un corte `abierto`: `sin_luz` desde su `start`. Si hay varios abiertos, vale el de `start` más tardío.
- Sin corte abierto y con la casa en `con_luz`: no cambia, ni el estado ni la hora.
- Si no (venía de `sin_luz` o de `sin_noticias`): `con_luz` desde el `end` más tardío que sea mayor o igual a la hora del estado anterior, o desde ahora si no hay ninguno.

## Tests obligatorios

Viven en `src/domain/detection/*.test.ts` y corren con `pnpm test`. El código exacto está en `docs/plans/2026-10-19-fase-0-clasificador.md`. Todo cambio de reglas o de umbral agrega su propio caso, idealmente sacado de un exporte real que queda en `test/fixtures/`.

| Modo base | Modo UPS | Reportes y confirmaciones |
| --- | --- | --- |
| Cierra cuando vuelven corriente y Wi-Fi | Abre y cierra cuando la corriente se va sola con la pantalla apagada | `sin_luz` sin corte abierto abre uno manual |
| Descarta caídas de menos de 10 min | Ignora el desenchufe con la pantalla encendida | `hay_luz` cierra el corte abierto |
| Descarta Wi-Fi desconocido sin carga | Ignora `interactive: null` | `fluctuando` no crea cortes |
| Sigue abierto mientras arranca el router | Ignora si no estaba en casa | Un snapshot repetido no cierra un corte manual |
| Tolera señales desordenadas | Sigue abierto si el UPS se agota | El corte manual se cierra al entrar en `powered` |
| Abre aunque llegue una señal intermedia de transición | Descarta caídas de menos de 10 min | `sin_luz` con un corte abierto no cambia nada |
| No abre si el Wi-Fi se cae después de `TRANSITION_MS` | Corriente y Wi-Fi juntos abren con `alta` | `answer: false` descarta el corte |
| No abre si cargaba fuera de casa | Descarta si aparece en otra red | `answer: true` lo confirma |
| El fin es la hora en que volvió la corriente | Sigue abierto si al irse la luz el teléfono se pasa a otra red | Tolera hasta 5 min de diferencia en `outageStart` |
| Un parpadeo mientras arranca el router mueve el fin | Snapshots repetidos no cambian el resultado | Una confirmación sin corte cercano se ignora |
| El Wi-Fi de casa sin corriente cierra el corte | Un corte `media` sigue abierto en Wi-Fi sin huella y sin carga | La última confirmación manda |
| Otra red Wi-Fi no cierra el corte | | `classify` aplica las confirmaciones sobre lo detectado |
| Snapshots repetidos no cambian el resultado | | `hay_luz` antes de 10 min deja el corte manual descartado |
| No depende del orden de entrada con empate de hora | | Entrar en `powered` antes de 10 min deja el corte manual descartado |
| Reiniciar enchufado durante el corte lo cierra | | `hay_luz` rearma desde el último snapshot |
| Sigue abierto si al irse la luz el teléfono se pasa a otra red | | En modo UPS, `sin_luz` abre un corte manual y `hay_luz` lo cierra |
| | | Un reporte y un snapshot a la misma hora se ordenan por `id` |
| | | Con dos cortes dentro de la tolerancia va al de inicio más cercano |

Además, `detect-outages.property.test.ts` prueba la propiedad de los snapshots repetidos en los dos modos: genera miles de líneas de tiempo con reportes (semilla fija, así siempre son las mismas), mete la copia de un snapshot antes del evento siguiente y exige el mismo resultado.
