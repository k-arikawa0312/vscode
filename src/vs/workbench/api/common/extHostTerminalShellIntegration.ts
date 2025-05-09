/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { TerminalShellExecutionCommandLineConfidence } from './extHostTypes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { MainContext, type ExtHostTerminalShellIntegrationShape, type MainThreadTerminalShellIntegrationShape } from './extHost.protocol.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import { IExtHostTerminalService } from './extHostTerminalService.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { URI, type UriComponents } from '../../../base/common/uri.js';
import { AsyncIterableObject, Barrier, type AsyncIterableEmitter } from '../../../base/common/async.js';

export interface IExtHostTerminalShellIntegration extends ExtHostTerminalShellIntegrationShape {
	readonly _serviceBrand: undefined;

	readonly onDidChangeTerminalShellIntegration: Event<vscode.TerminalShellIntegrationChangeEvent>;
	readonly onDidStartTerminalShellExecution: Event<vscode.TerminalShellExecutionStartEvent>;
	readonly onDidEndTerminalShellExecution: Event<vscode.TerminalShellExecutionEndEvent>;
}
export const IExtHostTerminalShellIntegration = createDecorator<IExtHostTerminalShellIntegration>('IExtHostTerminalShellIntegration');

export class ExtHostTerminalShellIntegration extends Disposable implements IExtHostTerminalShellIntegration {

	readonly _serviceBrand: undefined;

	protected _proxy: MainThreadTerminalShellIntegrationShape;

	private _activeShellIntegrations: Map</*instanceId*/number, InternalTerminalShellIntegration> = new Map();

	protected readonly _onDidChangeTerminalShellIntegration = new Emitter<vscode.TerminalShellIntegrationChangeEvent>();
	readonly onDidChangeTerminalShellIntegration = this._onDidChangeTerminalShellIntegration.event;
	protected readonly _onDidStartTerminalShellExecution = new Emitter<vscode.TerminalShellExecutionStartEvent>();
	readonly onDidStartTerminalShellExecution = this._onDidStartTerminalShellExecution.event;
	protected readonly _onDidEndTerminalShellExecution = new Emitter<vscode.TerminalShellExecutionEndEvent>();
	readonly onDidEndTerminalShellExecution = this._onDidEndTerminalShellExecution.event;

	constructor(
		@IExtHostRpcService extHostRpc: IExtHostRpcService,
		@IExtHostTerminalService private readonly _extHostTerminalService: IExtHostTerminalService,
	) {
		super();

		this._proxy = extHostRpc.getProxy(MainContext.MainThreadTerminalShellIntegration);

		// Clean up listeners
		this._register(toDisposable(() => {
			for (const [_, integration] of this._activeShellIntegrations) {
				integration.dispose();
			}
			this._activeShellIntegrations.clear();
		}));

		// Convenient test code:
		// this.onDidChangeTerminalShellIntegration(e => {
		// 	console.log('*** onDidChangeTerminalShellIntegration', e);
		// });
		// this.onDidStartTerminalShellExecution(async e => {
		// 	console.log('*** onDidStartTerminalShellExecution', e);
		// 	// new Promise<void>(r => {
		// 	// 	(async () => {
		// 	// 		for await (const d of e.execution.read()) {
		// 	// 			console.log('data2', d);
		// 	// 		}
		// 	// 	})();
		// 	// });
		// 	for await (const d of e.execution.read()) {
		// 		console.log('data', d);
		// 	}
		// });
		// this.onDidEndTerminalShellExecution(e => {
		// 	console.log('*** onDidEndTerminalShellExecution', e);
		// });
		// setTimeout(() => {
		// 	console.log('before executeCommand(\"echo hello\")');
		// 	Array.from(this._activeShellIntegrations.values())[0].value.executeCommand('echo hello');
		// 	console.log('after executeCommand(\"echo hello\")');
		// }, 4000);
	}

	public $shellIntegrationChange(instanceId: number): void {
		const terminal = this._extHostTerminalService.getTerminalById(instanceId);
		if (!terminal) {
			return;
		}

		const apiTerminal = terminal.value;
		let shellIntegration = this._activeShellIntegrations.get(instanceId);
		if (!shellIntegration) {
			shellIntegration = new InternalTerminalShellIntegration(terminal.value, this._onDidStartTerminalShellExecution);
			this._activeShellIntegrations.set(instanceId, shellIntegration);
			shellIntegration.store.add(terminal.onWillDispose(() => this._activeShellIntegrations.get(instanceId)?.dispose()));
			shellIntegration.store.add(shellIntegration.onDidRequestShellExecution(commandLine => this._proxy.$executeCommand(instanceId, commandLine)));
			shellIntegration.store.add(shellIntegration.onDidRequestEndExecution(e => this._onDidEndTerminalShellExecution.fire(e)));
			shellIntegration.store.add(shellIntegration.onDidRequestChangeShellIntegration(e => this._onDidChangeTerminalShellIntegration.fire(e)));
			terminal.shellIntegration = shellIntegration.value;
		}
		this._onDidChangeTerminalShellIntegration.fire({
			terminal: apiTerminal,
			shellIntegration: shellIntegration.value
		});
	}

	public $shellExecutionStart(instanceId: number, commandLineValue: string, commandLineConfidence: TerminalShellExecutionCommandLineConfidence, isTrusted: boolean, cwd: UriComponents | undefined): void {
		// Force shellIntegration creation if it hasn't been created yet, this could when events
		// don't come through on startup
		if (!this._activeShellIntegrations.has(instanceId)) {
			this.$shellIntegrationChange(instanceId);
		}
		const commandLine: vscode.TerminalShellExecutionCommandLine = {
			value: commandLineValue,
			confidence: commandLineConfidence,
			isTrusted
		};
		this._activeShellIntegrations.get(instanceId)?.startShellExecution(commandLine, URI.revive(cwd));
	}

	public $shellExecutionEnd(instanceId: number, commandLineValue: string, commandLineConfidence: TerminalShellExecutionCommandLineConfidence, isTrusted: boolean, exitCode: number | undefined): void {
		const commandLine: vscode.TerminalShellExecutionCommandLine = {
			value: commandLineValue,
			confidence: commandLineConfidence,
			isTrusted
		};
		this._activeShellIntegrations.get(instanceId)?.endShellExecution(commandLine, exitCode);
	}

	public $shellExecutionData(instanceId: number, data: string): void {
		this._activeShellIntegrations.get(instanceId)?.emitData(data);
	}

	public $shellEnvChange(instanceId: number, shellEnvKeys: string[], shellEnvValues: string[], isTrusted: boolean): void {
		this._activeShellIntegrations.get(instanceId)?.setEnv(shellEnvKeys, shellEnvValues, isTrusted);
	}

	public $cwdChange(instanceId: number, cwd: UriComponents | undefined): void {
		this._activeShellIntegrations.get(instanceId)?.setCwd(URI.revive(cwd));
	}

	public $closeTerminal(instanceId: number): void {
		this._activeShellIntegrations.get(instanceId)?.dispose();
		this._activeShellIntegrations.delete(instanceId);
	}

	public $setHasRichCommandDetection(instanceId: number, value: boolean): void {
		this._activeShellIntegrations.get(instanceId)?.setHasRichCommandDetection(value);
	}
}

class InternalTerminalShellIntegration extends Disposable {
	private _activeExecutions: InternalTerminalShellExecution[] = [];

	private _currentExecution: InternalTerminalShellExecution | undefined;
	get currentExecution(): InternalTerminalShellExecution | undefined { return this._currentExecution; }

	private _env: vscode.TerminalShellIntegrationEnvironment | undefined;
	private _cwd: URI | undefined;
	private _hasRichCommandDetection: boolean = false;

	readonly store: DisposableStore = this._register(new DisposableStore());

	readonly value: vscode.TerminalShellIntegration;

	protected readonly _onDidRequestChangeShellIntegration = this._register(new Emitter<vscode.TerminalShellIntegrationChangeEvent>());
	readonly onDidRequestChangeShellIntegration = this._onDidRequestChangeShellIntegration.event;
	protected readonly _onDidRequestShellExecution = this._register(new Emitter<string>());
	readonly onDidRequestShellExecution = this._onDidRequestShellExecution.event;
	protected readonly _onDidRequestEndExecution = this._register(new Emitter<vscode.TerminalShellExecutionEndEvent>());
	readonly onDidRequestEndExecution = this._onDidRequestEndExecution.event;
	protected readonly _onDidRequestNewExecution = this._register(new Emitter<string>());
	readonly onDidRequestNewExecution = this._onDidRequestNewExecution.event;

	constructor(
		private readonly _terminal: vscode.Terminal,
		private readonly _onDidStartTerminalShellExecution: Emitter<vscode.TerminalShellExecutionStartEvent>
	) {
		super();

		const that = this;
		this.value = {
			get cwd(): URI | undefined {
				return that._cwd;
			},
			get env(): vscode.TerminalShellIntegrationEnvironment | undefined {
				return that._env;
			},
			get hasRichCommandDetection(): boolean {
				return that._hasRichCommandDetection;
			},
			// executeCommand(commandLine: string): vscode.TerminalShellExecution;
			// executeCommand(executable: string, args: string[]): vscode.TerminalShellExecution;
			executeCommand(commandLineOrExecutable: string, args?: string[]): vscode.TerminalShellExecution {
				let commandLineValue = commandLineOrExecutable;
				if (args) {
					for (const arg of args) {
						const wrapInQuotes = !arg.match(/["'`]/) && arg.match(/\s/);
						if (wrapInQuotes) {
							commandLineValue += ` "${arg}"`;
						} else {
							commandLineValue += ` ${arg}`;
						}
					}
				}

				that._onDidRequestShellExecution.fire(commandLineValue);
				// Fire the event in a microtask to allow the extension to use the execution before
				// the start event fires
				const commandLine: vscode.TerminalShellExecutionCommandLine = {
					value: commandLineValue,
					confidence: TerminalShellExecutionCommandLineConfidence.High,
					isTrusted: true
				};
				const execution = that.requestNewShellExecution(commandLine, that._cwd).value;
				return execution;
			}
		};
	}

	requestNewShellExecution(commandLine: vscode.TerminalShellExecutionCommandLine, cwd: URI | undefined) {
		const execution = new InternalTerminalShellExecution(commandLine, cwd ?? this._cwd);
		this._activeExecutions.push(execution);
		this._onDidRequestNewExecution.fire(commandLine.value);
		return execution;
	}

	startShellExecution(commandLine: vscode.TerminalShellExecutionCommandLine, cwd: URI | undefined): InternalTerminalShellExecution {
		if (this._currentExecution) {
			if (this._hasRichCommandDetection) {
				console.warn('Rich command detection is enabled but an execution started before the last ended');
			}
			this._currentExecution.endExecution(undefined);
			this._onDidRequestEndExecution.fire({ terminal: this._terminal, shellIntegration: this.value, execution: this._currentExecution.value, exitCode: undefined });
		}

		// Get the active execution, how strict this is depends on whether the terminal has rich
		// command detection
		let currentExecution: InternalTerminalShellExecution | undefined;
		if (commandLine.confidence === TerminalShellExecutionCommandLineConfidence.High) {
			const index = this._activeExecutions.findIndex(e => e.value.commandLine.value === commandLine.value);
			if (index !== -1) {
				currentExecution = this._activeExecutions.splice(index, 1)[0];
			}
		} else {
			currentExecution = this._activeExecutions.shift();
		}

		// If there is no execution, create a new one
		if (!currentExecution) {
			// Fallback to the shell integration's cwd as the cwd may not have been restored after a reload
			currentExecution = new InternalTerminalShellExecution(commandLine, cwd ?? this._cwd);
		}

		this._currentExecution = currentExecution;

		this._onDidStartTerminalShellExecution.fire({ terminal: this._terminal, shellIntegration: this.value, execution: this._currentExecution.value });
		return this._currentExecution;
	}

	emitData(data: string): void {
		this.currentExecution?.emitData(data);
	}

	endShellExecution(commandLine: vscode.TerminalShellExecutionCommandLine | undefined, exitCode: number | undefined): void {
		if (this._currentExecution) {
			this._currentExecution.endExecution(commandLine);
			const currentExecution = this._currentExecution;
			// IMPORTANT: Ensure the current execution's data events are flushed in order to
			// prevent data events firing after the end event fires.
			currentExecution.flush().then(() => {
				// Only fire if it's still the same execution, if it's changed it would have already
				// been fired.
				if (this._currentExecution === currentExecution) {
					this._onDidRequestEndExecution.fire({ terminal: this._terminal, shellIntegration: this.value, execution: currentExecution.value, exitCode });
					this._currentExecution = undefined;
				}
			});
		}
	}

	setHasRichCommandDetection(value: boolean): void {
		if (this._hasRichCommandDetection !== value) {
			this._hasRichCommandDetection = value;
			this._fireChangeEvent();
		}
	}

	setEnv(keys: string[], values: string[], isTrusted: boolean): void {
		const env: { [key: string]: string | undefined } = {};
		for (let i = 0; i < keys.length; i++) {
			env[keys[i]] = values[i];
		}
		this._env = { value: env, isTrusted };
		this._fireChangeEvent();
	}

	setCwd(cwd: URI | undefined): void {
		let wasChanged = false;
		if (URI.isUri(this._cwd)) {
			wasChanged = !URI.isUri(cwd) || this._cwd.toString() !== cwd.toString();
		} else if (this._cwd !== cwd) {
			wasChanged = true;
		}
		if (wasChanged) {
			this._cwd = cwd;
			this._fireChangeEvent();
		}
	}

	private _fireChangeEvent() {
		this._onDidRequestChangeShellIntegration.fire({ terminal: this._terminal, shellIntegration: this.value });
	}
}

class InternalTerminalShellExecution {
	private _dataStream: ShellExecutionDataStream | undefined;

	private _ended: boolean = false;

	readonly value: vscode.TerminalShellExecution;

	constructor(
		private _commandLine: vscode.TerminalShellExecutionCommandLine,
		readonly cwd: URI | undefined,
	) {
		const that = this;
		this.value = {
			get commandLine(): vscode.TerminalShellExecutionCommandLine {
				return that._commandLine;
			},
			get cwd(): URI | undefined {
				return that.cwd;
			},
			read(): AsyncIterable<string> {
				return that._createDataStream();
			}
		};
	}

	private _createDataStream(): AsyncIterable<string> {
		if (!this._dataStream) {
			if (this._ended) {
				return AsyncIterableObject.EMPTY;
			}
			this._dataStream = new ShellExecutionDataStream();
		}
		return this._dataStream.createIterable();
	}

	emitData(data: string): void {
		this._dataStream?.emitData(data);
	}

	endExecution(commandLine: vscode.TerminalShellExecutionCommandLine | undefined): void {
		if (commandLine) {
			this._commandLine = commandLine;
		}
		this._dataStream?.endExecution();
		this._dataStream = undefined;
		this._ended = true;
	}

	async flush(): Promise<void> {
		await this._dataStream?.flush();
	}
}

class ShellExecutionDataStream extends Disposable {
	private _barrier: Barrier | undefined;
	private _iterables: AsyncIterableObject<string>[] = [];
	private _emitters: AsyncIterableEmitter<string>[] = [];

	createIterable(): AsyncIterable<string> {
		if (!this._barrier) {
			this._barrier = new Barrier();
		}
		const barrier = this._barrier;
		const iterable = new AsyncIterableObject<string>(async emitter => {
			this._emitters.push(emitter);
			await barrier.wait();
		});
		this._iterables.push(iterable);
		return iterable;
	}

	emitData(data: string): void {
		for (const emitter of this._emitters) {
			emitter.emitOne(data);
		}
	}

	endExecution(): void {
		this._barrier?.open();
		this._barrier = undefined;
	}

	async flush(): Promise<void> {
		await Promise.all(this._iterables.map(e => e.toPromise()));
	}
}
