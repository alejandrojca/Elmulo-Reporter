# Elmulo Reporter

Elmulo Reporter captura ejecuciones de Cypress y genera un dashboard con
historial SQLite, tendencias, evidencias, anotaciones y exportación ejecutiva
en PDF. El reporter se distribuye como un paquete independiente para evitar que
su implementación viva dentro de los proyectos de pruebas que lo consumen.

## Requisitos

- Node.js 18 o superior.
- Cypress 12 o superior cuando se utiliza la integración Cypress.

## Instalación

Desde el GitLab Package Registry o el registro interno de la organización:

```bash
npm install --save-dev @elmulo-group/elmulo-reporter
```

Durante el desarrollo también se puede instalar directamente desde GitLab:

```bash
npm install --save-dev git+https://gitlab.com/elmulo-group/elmulo-reporter.git
```

## Integración con Cypress

Registrar el plugin dentro de `setupNodeEvents`:

```js
const {
  registerElmuloReporter,
} = require("@elmulo-group/elmulo-reporter/cypress");

module.exports = defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      registerElmuloReporter(on, config, {
        environment: "sandbox",
      });

      return config;
    },
  },
});
```

Si el proyecto utiliza un multiplexor de eventos como `cypress-on-fix`, Elmulo
debe recibir la función `on` ya envuelta para convivir con los demás plugins.

Agregar el soporte del navegador al archivo de soporte de Cypress:

```ts
import "@elmulo-group/elmulo-reporter/support";
```

Esto habilita la captura acotada de comandos y el comando opcional
`cy.elmuloAttach(...)`. Los cuerpos internos, variables de entorno y
`consoleProps` no se persisten para reducir el riesgo de guardar secretos.

## Comandos

Los comandos se ejecutan desde la raíz del proyecto Cypress consumidor:

```bash
npx elmulo finalize
npx elmulo serve
npx elmulo serve 4178
npx elmulo retention 50
npx elmulo demo
```

- `finalize` consolida la última ejecución y actualiza SQLite.
- `serve` publica el dashboard y las APIs locales.
- `retention` conserva la cantidad indicada de corridas.
- `demo` genera datos de demostración.

El puerto predeterminado es `4178`. Puede configurarse mediante
`ELMULO_PORT`. La salida puede cambiarse con `ELMULO_OUTPUT_DIR`; el plugin y
la CLI deben utilizar el mismo valor.

## Salida

Por defecto, Elmulo crea `elmulo-results-v2` en la raíz del proyecto Cypress:

```text
elmulo-results-v2/
├── elmulo.sqlite
├── latest-run.txt
├── report/
│   ├── index.html
│   └── assets/
└── runs/
    └── <run-id>/
        ├── run.json
        ├── run.raw.json
        └── media/
```

La base y `runs/` forman una unidad: para migrar o respaldar el historial deben
conservarse ambos. El directorio de resultados no debe almacenarse en Git; en
CI debe persistirse como artefacto o montarse sobre un volumen durable.

## Datos complementarios

Durante `finalize`, Elmulo busca `jsonlogs/cucumber.json` en la raíz del
proyecto consumidor para enriquecer escenarios con pasos y tags. Si el archivo
no existe, el reporte se genera con la información nativa de Cypress.

Videos y screenshots referenciados por Cypress se copian a la carpeta `media`
de la corrida, manteniendo el reporte portable.

## Desarrollo

```bash
npm install
npm test
npm run pack:check
```

La suite utiliza `node:test` y valida normalización de resultados, reintentos,
SQLite, tendencias, anotaciones, auditoría, sanitización y PDF ejecutivo.

## Persistencia y despliegue

SQLite funciona bien con una instancia de Elmulo que escribe sobre un volumen
persistente. Para múltiples réplicas escritoras o ejecuciones concurrentes debe
incorporarse coordinación o migrarse el almacenamiento a una base cliente-servidor.
