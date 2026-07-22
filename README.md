# Elmulo Reporter

Elmulo Reporter captura ejecuciones de Cypress y genera un dashboard con
historial SQLite, tendencias, evidencias, anotaciones y exportación ejecutiva
en PDF. El reporter se distribuye como un paquete independiente para evitar que
su implementación viva dentro de los proyectos de pruebas que lo consumen.

## Requisitos

- Node.js 18 o superior.
- Cypress 12 o superior cuando se utiliza la integración Cypress.

## Instalación

Desde GitHub Packages o el registro interno de la organización:

```bash
npm install --save-dev @alejandrojca/elmulo-reporter
```

Durante el desarrollo también se puede instalar directamente desde GitHub:

```bash
npm install --save-dev git+https://github.com/alejandrojca/Elmulo-Reporter.git
```

## Guía para QA: usar Elmulo en el repositorio Cypress

Esta sección explica el flujo completo para una persona que ya tiene el
repositorio de Cypress descargado en su computadora. No es necesario descargar
este repositorio de Elmulo por separado ni copiar archivos manualmente.

### 1. Abrir una terminal en la carpeta correcta

Abrir Git Bash o una terminal desde la carpeta principal del repositorio
Cypress. Es la carpeta que contiene, entre otros, estos elementos:

```text
package.json
cypress/
```

La ubicación exacta puede ser diferente en cada computadora. Todos estos
ejemplos son válidos:

```text
C:\Cypress
D:\Proyectos\acceptance-tests
C:\Users\usuario\repos\acceptance-tests
/home/usuario/proyectos/acceptance-tests
```

Elmulo no depende de una ruta fija. Lo importante es ejecutar los comandos
desde la carpeta donde se encuentra `package.json`.

### 2. Comprobar las herramientas necesarias

Ejecutar:

```bash
node --version
npm --version
git --version
```

Node.js debe ser versión 18 o superior. Si alguno de los comandos no existe,
solicitar ayuda para instalar Node.js o Git antes de continuar.

En Windows se recomienda usar Git Bash para los comandos de reportes del
proyecto Cypress, porque esos comandos ejecutan scripts `.sh`.

### 3. Actualizar el repositorio Cypress

Cambiar a la rama de trabajo y descargar la versión más reciente:

```bash
git switch develop
git pull origin develop
```

Si Git informa que existen cambios locales o conflictos, no eliminarlos sin
revisarlos. Pedir ayuda al equipo antes de continuar para no perder trabajo.

### 4. Instalar las dependencias

Ejecutar desde la misma carpeta:

```bash
npm install
```

Este comando lee el `package.json` del repositorio Cypress e instala Elmulo
Reporter junto con las demás dependencias. Debe ejecutarse después de clonar el
proyecto y cada vez que cambien sus dependencias.

Comprobar que Elmulo quedó instalado:

```bash
npm ls @alejandrojca/elmulo-reporter
```

El resultado debe mostrar `@alejandrojca/elmulo-reporter` y su versión. No es
necesario modificar manualmente la configuración de Cypress si la integración
ya está incluida en la rama descargada.

### 5. Ejecutar las pruebas y generar el reporte

Para sandbox, por ejemplo:

```bash
npm run report-sandbox-ecommerce -- "@mtt"
```

Para QA:

```bash
npm run report-qa-ecommerce -- "@mtt"
```

Estos comandos ejecutan Cypress, generan los datos de Cucumber y finalmente
generan Elmulo. Al terminar debe existir:

```text
elmulo-results/
```

Si ya existe una ejecución capturada y solamente se necesita regenerar Elmulo:

```bash
npm run elmulo:generate
```

### 6. Abrir el dashboard

Ejecutar:

```bash
npm run elmulo:serve
```

Abrir en el navegador:

```text
http://127.0.0.1:4178
```

Mantener la terminal abierta mientras se usa el dashboard. Para detener el
servidor, volver a la terminal y presionar `Ctrl+C`.

Si el puerto `4178` ya está ocupado, iniciar Elmulo en otro puerto:

```bash
npx elmulo serve 4190
```

En ese caso, abrir `http://127.0.0.1:4190`.

### 7. Entender qué sucede con el historial

Cada persona tiene su propio directorio `elmulo-results` y su propia base
`elmulo.sqlite`. Este directorio no se sube a Git, por lo tanto:

- hacer `git pull` no descarga el historial de otra persona;
- clonar el repositorio comienza con un historial local vacío;
- eliminar `elmulo-results` elimina el historial y las evidencias locales;
- para trasladar el historial se debe copiar el directorio completo, no sólo
  `elmulo.sqlite`.

### Problemas frecuentes

#### `elmulo` no se reconoce como comando

Ejecutar nuevamente:

```bash
npm install
```

Usar `npm run elmulo:generate` o `npx elmulo` en lugar de ejecutar `elmulo`
directamente desde una terminal cualquiera.

#### No existe una ejecución capturada

Primero ejecutar uno de los comandos de reporte Cypress, por ejemplo:

```bash
npm run report-sandbox-ecommerce -- "@mtt"
```

#### No aparece el historial de otro integrante

Es el comportamiento esperado. Los resultados son locales y están excluidos
de Git. Para compartirlos se debe transferir el directorio `elmulo-results` por
un medio externo o utilizar un almacenamiento persistente compartido.

### Cambiar la ubicación de los resultados (opcional)

Normalmente no es necesario. Si se desea almacenar los resultados en otra
carpeta, configurar `ELMULO_OUTPUT_DIR` antes de ejecutar Cypress o Elmulo.

PowerShell:

```powershell
$env:ELMULO_OUTPUT_DIR = "D:\Reportes\elmulo-results"
npm run report-sandbox-ecommerce -- "@mtt"
```

Git Bash, Linux o macOS:

```bash
export ELMULO_OUTPUT_DIR="/ruta/reportes/elmulo-results"
npm run report-sandbox-ecommerce -- "@mtt"
```

## Integración con Cypress

Registrar el plugin dentro de `setupNodeEvents`:

```js
const {
  registerElmuloReporter,
} = require("@alejandrojca/elmulo-reporter/cypress");

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
import "@alejandrojca/elmulo-reporter/support";
```

Esto habilita la captura acotada de comandos, la captura de `cy.request` y el
comando opcional `cy.elmuloAttach(...)`. Los logs generales continúan
sanitizados y no se persisten `consoleProps`.

### Requests y respuestas de pruebas fallidas

Elmulo captura automáticamente todos los `cy.request` de todas las features.
Si la prueba termina fallida, guarda cada request y su respuesta en `run.json`,
en el HTML generado y en la columna `http_json` de `elmulo.sqlite`. En la
pestaña **Error**, ambos aparecen cerrados por defecto y pueden desplegarse
para analizar el problema. Si la prueba termina correctamente, esos datos no
se conservan.

La captura HTTP es deliberadamente literal: **no oculta ni reemplaza ningún
valor**. Headers, tokens, cookies, credenciales, parámetros y cuerpos quedan en
texto plano tal como fueron enviados o recibidos. Por eso:

- no subir `elmulo-results` a Git;
- no compartir la base, el HTML ni `runs/` fuera de los canales autorizados;
- aplicar al directorio de resultados los mismos controles que a las
  credenciales y a los datos del ambiente probado;
- revisar qué datos se incluirán antes de implementar o utilizar una futura
  integración que cree bugs en Jira.

Si un proyecto no puede almacenar estos datos, se puede desactivar la captura
sin modificar las features.

PowerShell:

```powershell
$env:ELMULO_CAPTURE_HTTP = "false"
npm run report-sandbox-ecommerce -- "@mtt"
```

Git Bash, Linux o macOS:

```bash
ELMULO_CAPTURE_HTTP=false npm run report-sandbox-ecommerce -- "@mtt"
```

También puede configurarse `captureHttp: false` al llamar a
`registerElmuloReporter`.

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

## PDF ejecutivo configurable

Desde la pantalla **Resumen**, el botón **Exportar PDF ejecutivo** abre una
ventana sobre el reporte. Allí se pueden marcar las secciones que formarán el
documento. La portada, la identificación de la corrida, la fecha de generación
y la numeración de páginas se incluyen siempre.

La selección recomendada incluye resumen, distribución por estado, contexto,
Features, problemas, comparación, historial, pruebas inestables, fallos
recurrentes y recomendación. Las pruebas más lentas y el detalle técnico se
encuentran desmarcados inicialmente.

La opción **Detalle técnico de fallas** incorpora errores, requests y respuestas
sin ocultar valores. El PDF resultante puede contener tokens, credenciales,
cookies, datos de pago u otra información sensible, por lo que debe revisarse
antes de compartirlo.

El puerto predeterminado es `4178`. Puede configurarse mediante
`ELMULO_PORT`. La salida puede cambiarse con `ELMULO_OUTPUT_DIR`; el plugin y
la CLI deben utilizar el mismo valor.

## Salida

Por defecto, Elmulo crea `elmulo-results` en la raíz del proyecto Cypress:

```text
elmulo-results/
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
