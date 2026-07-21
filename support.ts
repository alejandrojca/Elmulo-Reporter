type ElmuloLogEntry = {
    name: string;
    message: string;
    timestamp: string;
};

const elmuloLogs: ElmuloLogEntry[] = [];
const elmuloEnabled = Cypress.env('elmulo') === true;

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
}

beforeEach(() => {
    if (elmuloEnabled) {
        elmuloLogs.length = 0;
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
