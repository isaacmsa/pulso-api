@AGENTS.md

## Claude Code

- **El plan vigente es el tablero maestro, `pulso-app/docs/roadmap.md`, con un archivo por fase en `pulso-app/docs/phases/`** (D-046 de la app); los planes de `docs/plans/` quedan como registro. Las fases se ejecutan sin escribir otro plan ni esperar otra aprobación, en modo ligero (pedido de Isaac, 30 de octubre): las tareas chicas van directo con TDD, sin revisor por tarea, y hay una revisión al cerrar la fase. Solo se detiene en lo que la fase lista en «Lo que necesita de Isaac».
- **Una sesión por fase, y siempre con la carpeta de `pulso-app` a mano** (`~/projects/personal/mobile/pulso-app`): ahí están el tablero y el archivo de la fase, que se editan al cerrar cada tarea. Si la sesión no tiene acceso a esa carpeta, lo pide antes de empezar. Lo que una sesión le deja a la siguiente va en «Siguiente paso» y «Bitácora» del archivo de la fase, no en `.superpowers/` ni en notas fuera del repo: esas no se versionan y la sesión siguiente no las ve.
- **TDD con `superpowers:test-driven-development`**: el test que falla va primero, sobre todo en `src/domain/`.
- **Skills**: `backend-engineering`, `cloudflare:workers-best-practices`, `cloudflare:wrangler`, `supabase:supabase` y `supabase:supabase-postgres-best-practices`. Antes de pedir producción, `security-perf-review`.
- **Las tareas de `src/domain/` y de módulos** son TypeScript con tests y van bien en subagentes (`superpowers:subagent-driven-development`), sin revisor por tarea (modo ligero).
- **Si el código y un documento se contradicen**, detente y pregunta cuál manda; después actualiza el documento en el mismo commit.
- **Antes de crear las cuentas de Cloudflare o Supabase, cargar secretos o desplegar a producción**, confirma con Isaac. Nunca escribas credenciales por él.
- Las preferencias generales de Isaac viven en `~/.claude/`; no las repitas en este repo.
