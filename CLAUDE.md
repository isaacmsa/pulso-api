@AGENTS.md

## Claude Code

- **Al empezar cada fase** de `docs/roadmap.md`, lee los documentos que la fase menciona y escribe su plan en `docs/plans/AAAA-MM-DD-fase-N-<nombre>.md` con la skill `superpowers:writing-plans`. Espera la aprobación de Isaac antes de tocar código.
- **TDD con `superpowers:test-driven-development`**: el test que falla va primero, sobre todo en `src/domain/`.
- **Skills**: `backend-engineering`, `cloudflare:workers-best-practices`, `cloudflare:wrangler`, `supabase:supabase` y `supabase:supabase-postgres-best-practices`. Antes de pedir producción, `security-perf-review`.
- **Las tareas de `src/domain/` y de módulos** son TypeScript con tests y van bien en subagentes (`superpowers:subagent-driven-development`).
- **Si el código y un documento se contradicen**, detente y pregunta cuál manda; después actualiza el documento en el mismo commit.
- **Antes de crear las cuentas de Cloudflare o Supabase, cargar secretos o desplegar a producción**, confirma con Isaac. Nunca escribas credenciales por él.
- Las preferencias generales de Isaac viven en `~/.claude/`; no las repitas en este repo.
