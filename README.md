# Pulso · API

Backend de [Pulso](../../mobile/pulso-app/README.md), la app que detecta sola los cortes de luz de una casa y avisa a la familia. Es un Cloudflare Worker con Hono, sobre PostgreSQL en Supabase (vía Hyperdrive). Recibe los eventos del teléfono, clasifica los cortes, manda los push y publica el contrato OpenAPI que consume la app. Corre en planes gratuitos: USD 0 al mes.

- Cómo está construido y cómo se opera: [docs/architecture.md](docs/architecture.md)
- Endpoints y contrato: [docs/api.md](docs/api.md)
- Cómo se decide que hubo un corte: [docs/classifier.md](docs/classifier.md)
- Estado: [docs/roadmap.md](docs/roadmap.md)
