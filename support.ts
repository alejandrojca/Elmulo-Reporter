type ElmuloLogEntry = {
    name: string;
    message: string;
    timestamp: string;
};

type ElmuloHttpExchange = {
    startedAt: string;
    durationMs: number;
    request: Record<string, unknown>;
    response: Record<string, unknown>;
};

const elmuloLogs: ElmuloLogEntry[] = [];
const elmuloHttp: ElmuloHttpExchange[] = [];
const elmuloEnabled = Cypress.env('elmulo') === true;
const elmuloCaptureHttp = Cypress.env('elmuloCaptureHttp') !== false;

function serializable(value: unknown): unknown {
    const seen = new WeakSet<object>();
    try {
        return JSON.parse(JSON.stringify(value, (_key, current) => {
            if (typeof current === 'bigint') {
                return current.toString();
            }
            if (current instanceof Error) {
                return {
                    name: current.name,
                    message: current.message,
                    stack: current.stack,
                    ...current,
                };
            }
            if (current && typeof current === 'object') {
                if (seen.has(current)) return '[Circular]';
                seen.add(current);
            }
            return current;
        }));
    } catch {
        return String(value);
    }
}

function normalizeRequestArguments(args: unknown[]) {
    const [first, second, third] = args;
    if (first && typeof first === 'object' && !Array.isArray(first)) {
        return { ...(first as Record<string, unknown>) };
    }

    const methods = new Set([
        'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT',
    ]);
    if (typeof first === 'string' && typeof second === 'string' && methods.has(first.toUpperCase())) {
        return { method: first.toUpperCase(), url: second, body: third };
    }

    return { method: 'GET', url: first, body: second };
}

function recordHttpExchange(
    options: Record<string, unknown>,
    response: any,
    startedAt: string,
    startedTime: number,
    error?: unknown,
    existing?: ElmuloHttpExchange,
) {
    const request = {
        method: String(options.method || 'GET').toUpperCase(),
        url: options.url || '',
        headers: response?.requestHeaders ?? options.headers ?? {},
        body: response?.requestBody !== undefined ? response.requestBody : options.body,
        qs: options.qs,
        auth: options.auth,
        form: options.form,
        encoding: options.encoding,
    };
    const received = {
        status: response?.status ?? null,
        statusText: response?.statusText ?? '',
        headers: response?.headers ?? {},
        body: response?.body ?? null,
        durationMs: response?.duration ?? Date.now() - startedTime,
        redirectedToUrl: response?.redirectedToUrl ?? null,
        isOkStatusCode: response?.isOkStatusCode ?? null,
        error: error ? serializable(error) : null,
    };

    const exchange = {
        startedAt,
        durationMs: Number(received.durationMs || Date.now() - startedTime),
        request: serializable(request) as Record<string, unknown>,
        response: serializable(received) as Record<string, unknown>,
    };
    if (existing) Object.assign(existing, exchange);
    else elmuloHttp.push(exchange);
    return exchange;
}

if (elmuloEnabled) {
    Cypress.on('log:added', (attributes: any) => {
        const message = Array.isArray(attributes.message)
            ? attributes.message.join(' ')
            : String(attributes.message || '');

        elmuloLogs.push({
            name: String(attributes.displayName || attributes.name || 'command'),
            message,
            timestamp: new Date().toISOString(),
        });
    });

    if (elmuloCaptureHttp) {
        Cypress.Commands.overwrite('request', (originalFn, ...args: unknown[]) => {
            const options = normalizeRequestArguments(args);
            const startedAt = new Date().toISOString();
            const startedTime = Date.now();
            const exchange = recordHttpExchange(
                options,
                null,
                startedAt,
                startedTime,
            );
            const invokeRequest = originalFn as (...requestArgs: any[]) => Cypress.Chainable<any>;
            return invokeRequest(...args).then((response: unknown) => {
                recordHttpExchange(
                    options,
                    response,
                    startedAt,
                    startedTime,
                    undefined,
                    exchange,
                );
                return response;
            });
        });

        Cypress.on('fail', (error: any) => {
            const pendingExchange = [...elmuloHttp].reverse().find(
                (exchange) => exchange.response.status === null,
            );
            if (pendingExchange) {
                recordHttpExchange(
                    pendingExchange.request,
                    error?.response,
                    pendingExchange.startedAt,
                    Date.parse(pendingExchange.startedAt),
                    error,
                    pendingExchange,
                );
            }
            throw error;
        });
    }
}

beforeEach(() => {
    if (elmuloEnabled) {
        elmuloLogs.length = 0;
        elmuloHttp.length = 0;
    }
});

afterEach(function () {
    if (!elmuloEnabled) {
        return;
    }

    const testKey = this.currentTest?.titlePath().join(' › ') || this.currentTest?.title || '';
    cy.task('elmulo:recordLogs', {
        testKey,
        logs: elmuloLogs.slice(-500),
    }, { log: false });
    cy.task('elmulo:recordHttp', {
        testKey,
        exchanges: this.currentTest?.state === 'failed' ? elmuloHttp : [],
    }, { log: false });
});

Cypress.Commands.add(
    'elmuloAttach',
    (name: string, content: unknown, mimeType = 'application/json') => {
        if (!elmuloEnabled) {
            return cy.wrap(null, { log: false });
        }

        const testKey = Cypress.currentTest.titlePath.join(' › ');
        return cy.task('elmulo:attach', {
            testKey,
            name,
            mimeType,
            content,
        }, { log: false });
    },
);

declare global {
    namespace Cypress {
        interface Chainable {
            elmuloAttach(
                name: string,
                content: unknown,
                mimeType?: string,
            ): Chainable<unknown>;
        }
    }
}

export {};
