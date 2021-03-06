import * as leanclient from 'lean-client-js-node';
import { CommandResponse, CompleteResponse, Event, FileRoi, Message,
     ProcessConnection, ProcessTransport, RoiRequest, Task } from 'lean-client-js-node';
import * as semver from 'semver';
import { OutputChannel, window, workspace } from 'vscode';
import { LowPassFilter } from './util';

export interface ServerStatus {
    stopped: boolean;
    isRunning: boolean;
    numberOfTasks: number;
    tasks: Task[];
}

// A global channel for storing the contents of stderr.
let stderrOutput: OutputChannel;

// A class for interacting with the Lean server protocol.
export class Server extends leanclient.Server {
    transport: ProcessTransport;
    executablePath: string;
    workingDirectory: string;
    options: string[];
    version: string;

    statusChanged: LowPassFilter<ServerStatus>;
    restarted: Event<any>;
    supportsROI: boolean;

    messages: Message[];

    constructor() {
        super(null); // TODO(gabriel): add support to lean-client-js
        this.statusChanged = new LowPassFilter<ServerStatus>(300);
        this.restarted = new Event();
        this.messages = [];
        this.supportsROI = true;
        this.version = '3.2.0';

        this.attachEventHandlers();

        this.connect();
    }

    atLeastLeanVersion(requiredVersion: string): boolean {
        return semver.lte(requiredVersion, this.version);
    }

    connect() {
        try {
            this.messages = [];

            const config = workspace.getConfiguration('lean');

            // TODO(gabriel): unset LEAN_PATH environment variable

            this.executablePath = config.get('executablePath') || 'lean';
            this.workingDirectory = workspace.rootPath;
            this.options = config.get('extraOptions') || [];

            this.version = new ProcessTransport(this.executablePath, '.', []).getVersion();
            if (this.atLeastLeanVersion('3.1.0')) {
                this.options.push('-M');
                this.options.push('' + config.get('memoryLimit'));

                this.options.push('-T');
                this.options.push('' + config.get('timeLimit'));
            }

            this.supportsROI = this.atLeastLeanVersion('3.1.1');

            this.transport = new ProcessTransport(
                this.executablePath, this.workingDirectory, this.options);
            super.connect();
        } catch (e) {
            this.requestRestart(`Lean: ${e}`);
        }
    }

    private attachEventHandlers() {
        // When attaching event handlers ensure the global error log is clear.
        stderrOutput = stderrOutput || window.createOutputChannel('Lean: Server Errors');
        stderrOutput.clear();

        this.error.on((e) => {
            switch (e.error) {
                case 'stderr':
                    stderrOutput.append(e.chunk);
                    stderrOutput.show();
                    break;
                case 'connect':
                    this.requestRestart(
                        `Lean: ${e.message}\n` +
                        'The lean.executablePath may be incorrect, make sure it is a valid Lean executable');
                    break;
                case 'unrelated':
                    window.showWarningMessage('Lean: ' + e.message);
                    break;
            }

            if (!this.alive()) {
                this.statusChanged.input({
                    isRunning: false,
                    numberOfTasks: 0,
                    stopped: true,
                    tasks: [],
                }, true);
            }
        });

        this.allMessages.on((msgs) => this.messages = msgs.msgs);

        this.tasks.on((curTasks) =>
            this.statusChanged.input({
                isRunning: curTasks.is_running,
                numberOfTasks: curTasks.tasks.length,
                stopped: false,
                tasks: curTasks.tasks,
            }, curTasks.tasks.length === 0));
    }

    restart() {
        super.restart();
        this.restarted.fire(null);
        stderrOutput.appendLine('----- user triggered restart -----');
    }

    async requestRestart(message: string, justWarning?: boolean) {
        const restartItem = 'Restart server';
        const showMsg = justWarning ? window.showWarningMessage : window.showErrorMessage;
        const item = await showMsg(message, restartItem);
        if (item === restartItem) {
            this.restart();
        }
    }
}
