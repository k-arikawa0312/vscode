/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ChatAgentLocation, IChatAgentService } from '../../common/chatAgents.js';
import { ChatContextKeys } from '../../common/chatContextKeys.js';
import { IChatEditingService, IChatEditingSession, WorkingSetEntryState } from '../../common/chatEditingService.js';
import { chatAgentLeader, extractAgentAndCommand } from '../../common/chatParserTypes.js';
import { IChatService } from '../../common/chatService.js';
import { ChatMode } from '../../common/constants.js';
import { EditsViewId, IChatWidget, IChatWidgetService } from '../chat.js';
import { discardAllEditsWithConfirmation, EditingSessionAction } from '../chatEditing/chatEditingActions.js';
import { ChatViewPane } from '../chatViewPane.js';
import { CHAT_CATEGORY } from './chatActions.js';
import { ChatDoneActionId } from './chatClearActions.js';

export interface IVoiceChatExecuteActionContext {
	readonly disableTimeout?: boolean;
}

export interface IChatExecuteActionContext {
	widget?: IChatWidget;
	inputValue?: string;
	voice?: IVoiceChatExecuteActionContext;
}

abstract class SubmitAction extends Action2 {
	run(accessor: ServicesAccessor, ...args: any[]) {
		const context: IChatExecuteActionContext | undefined = args[0];

		const widgetService = accessor.get(IChatWidgetService);
		const widget = context?.widget ?? widgetService.lastFocusedWidget;
		widget?.acceptInput(context?.inputValue);
	}
}

const whenNotInProgressOrPaused = ContextKeyExpr.or(ChatContextKeys.isRequestPaused, ChatContextKeys.requestInProgress.negate());

export class ChatSubmitAction extends SubmitAction {
	static readonly ID = 'workbench.action.chat.submit';

	constructor() {
		const precondition = ContextKeyExpr.and(
			// if the input has prompt instructions attached, allow submitting requests even
			// without text present - having instructions is enough context for a request
			ContextKeyExpr.or(ChatContextKeys.inputHasText, ChatContextKeys.instructionsAttached),
			whenNotInProgressOrPaused,
			ChatContextKeys.location.notEqualsTo(ChatAgentLocation.EditingSession),
		);

		super({
			id: ChatSubmitAction.ID,
			title: localize2('interactive.submit.label', "Send and Dispatch"),
			f1: false,
			category: CHAT_CATEGORY,
			icon: Codicon.send,
			precondition,
			keybinding: {
				when: ChatContextKeys.inChatInput,
				primary: KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib
			},
			menu: [
				{
					id: MenuId.ChatExecuteSecondary,
					group: 'group_1',
					order: 1
				},
				{
					id: MenuId.ChatExecute,
					order: 4,
					when: ContextKeyExpr.and(
						whenNotInProgressOrPaused,
						ChatContextKeys.location.notEqualsTo(ChatAgentLocation.EditingSession),
					),
					group: 'navigation',
				},
			]
		});
	}
}

export const ToggleAgentModeActionId = 'workbench.action.chat.toggleAgentMode';

export interface IToggleAgentModeArgs {
	agentMode: boolean;
}

export class ToggleAgentModeAction extends EditingSessionAction {

	static readonly ID = ToggleAgentModeActionId;

	constructor() {
		super({
			id: ToggleAgentModeAction.ID,
			title: localize2('interactive.toggleMode.label', "Toggle Chat Mode (Experimental)"),
			f1: true,
			category: CHAT_CATEGORY,
			precondition: ContextKeyExpr.and(
				ChatContextKeys.enabled,
				ChatContextKeys.Editing.hasToolsAgent,
				ChatContextKeys.requestInProgress.negate()),
			tooltip: localize('setChatMode', "Set Mode (Experimental)"),
			keybinding: {
				when: ContextKeyExpr.and(
					ChatContextKeys.inChatInput,
					ChatContextKeys.location.isEqualTo(ChatAgentLocation.EditingSession)),
				primary: KeyMod.CtrlCmd | KeyCode.Period,
				weight: KeybindingWeight.EditorContrib
			},
			menu: [
				{
					id: MenuId.ChatExecute,
					order: 1,
					when: ContextKeyExpr.and(
						ChatContextKeys.location.isEqualTo(ChatAgentLocation.EditingSession),
						ChatContextKeys.Editing.hasToolsAgent),
					group: 'navigation',
				},
			]
		});
	}

	override async runEditingSessionAction(accessor: ServicesAccessor, currentEditingSession: IChatEditingSession, chatWidget: IChatWidget, ...args: any[]) {

		const chatService = accessor.get(IChatService);
		const commandService = accessor.get(ICommandService);
		const dialogService = accessor.get(IDialogService);

		const entries = currentEditingSession.entries.get();
		if (entries.length > 0 && entries.some(entry => entry.state.get() === WorkingSetEntryState.Modified)) {
			if (!await discardAllEditsWithConfirmation(accessor, currentEditingSession)) {
				// User cancelled
				return;
			}
		} else {
			const chatSession = chatService.getSession(currentEditingSession.chatSessionId);
			if (chatSession?.getRequests().length) {
				const confirmation = await dialogService.confirm({
					title: localize('agent.newSession', "Start new session?"),
					message: localize('agent.newSessionMessage', "Toggling agent mode will start a new session. Would you like to continue?"),
					primaryButton: localize('agent.newSession.confirm', "Yes"),
					type: 'info'
				});
				if (!confirmation.confirmed) {
					return;
				}
			}
		}

		const arg = args[0] as IToggleAgentModeArgs | undefined;
		const setTo = arg ?
			(arg.agentMode ? ChatMode.Agent : ChatMode.Edit) :
			(chatWidget.input.toolsAgentModeEnabled ? ChatMode.Edit : ChatMode.Agent);
		chatWidget.input.setChatMode(setTo);

		await commandService.executeCommand(ChatDoneActionId);
	}
}

export const ToggleRequestPausedActionId = 'workbench.action.chat.toggleRequestPaused';
export class ToggleRequestPausedAction extends Action2 {
	static readonly ID = ToggleRequestPausedActionId;

	constructor() {
		super({
			id: ToggleRequestPausedAction.ID,
			title: localize2('interactive.toggleRequestPausd.label', "Toggle Request Paused"),
			category: CHAT_CATEGORY,
			icon: Codicon.debugPause,
			toggled: {
				condition: ChatContextKeys.isRequestPaused,
				icon: Codicon.play,
				tooltip: localize('requestIsPaused', "Resume Request"),
			},
			tooltip: localize('requestNotPaused', "Pause Request"),
			menu: [
				{
					id: MenuId.ChatExecute,
					order: 3.5,
					when: ContextKeyExpr.and(
						ChatContextKeys.canRequestBePaused,
						ChatContextKeys.Editing.agentMode,
						ChatContextKeys.location.isEqualTo(ChatAgentLocation.EditingSession),
						ContextKeyExpr.or(ChatContextKeys.isRequestPaused.negate(), ChatContextKeys.inputHasText.negate()),
					),
					group: 'navigation',
				},
			]
		});
	}

	override run(accessor: ServicesAccessor, ...args: any[]): void {
		const context: IChatExecuteActionContext | undefined = args[0];
		const widgetService = accessor.get(IChatWidgetService);
		const widget = context?.widget ?? widgetService.lastFocusedWidget;
		widget?.togglePaused();
	}
}

export const ChatSwitchToNextModelActionId = 'workbench.action.chat.switchToNextModel';
export class SwitchToNextModelAction extends Action2 {
	static readonly ID = ChatSwitchToNextModelActionId;

	constructor() {
		super({
			id: SwitchToNextModelAction.ID,
			title: localize2('interactive.switchToNextModel.label', "Switch to Next Model"),
			category: CHAT_CATEGORY,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Period,
				weight: KeybindingWeight.WorkbenchContrib,
				when: ChatContextKeys.inChatInput
			},
			menu: {
				id: MenuId.ChatExecute,
				order: 3,
				group: 'navigation',
				when: ContextKeyExpr.and(
					ChatContextKeys.languageModelsAreUserSelectable,
					ContextKeyExpr.or(
						ContextKeyExpr.equals(ChatContextKeys.location.key, ChatAgentLocation.Panel),
						ContextKeyExpr.equals(ChatContextKeys.location.key, ChatAgentLocation.EditingSession),
						ContextKeyExpr.equals(ChatContextKeys.location.key, ChatAgentLocation.Editor),
						ContextKeyExpr.equals(ChatContextKeys.location.key, ChatAgentLocation.Notebook),
						ContextKeyExpr.equals(ChatContextKeys.location.key, ChatAgentLocation.Terminal)
					)
				),
			}
		});
	}

	override run(accessor: ServicesAccessor, ...args: any[]): void {
		const widgetService = accessor.get(IChatWidgetService);
		const widget = widgetService.lastFocusedWidget;
		widget?.input.switchToNextModel();
	}
}

export class ChatEditingSessionSubmitAction extends SubmitAction {
	static readonly ID = 'workbench.action.edits.submit';

	constructor() {
		const precondition = ContextKeyExpr.and(
			// if the input has prompt instructions attached, allow submitting requests even
			// without text present - having instructions is enough context for a request
			ContextKeyExpr.or(ChatContextKeys.inputHasText, ChatContextKeys.instructionsAttached),
			whenNotInProgressOrPaused,
			ChatContextKeys.location.isEqualTo(ChatAgentLocation.EditingSession),
		);

		super({
			id: ChatEditingSessionSubmitAction.ID,
			title: localize2('edits.submit.label', "Send"),
			f1: false,
			category: CHAT_CATEGORY,
			icon: Codicon.send,
			precondition,
			keybinding: {
				when: ChatContextKeys.inChatInput,
				primary: KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib
			},
			menu: [
				{
					id: MenuId.ChatExecuteSecondary,
					group: 'group_1',
					when: ContextKeyExpr.and(whenNotInProgressOrPaused, ChatContextKeys.location.isEqualTo(ChatAgentLocation.EditingSession)),
					order: 1
				},
				{
					id: MenuId.ChatExecute,
					order: 4,
					when: ContextKeyExpr.and(
						ContextKeyExpr.or(
							ContextKeyExpr.and(ChatContextKeys.isRequestPaused, ChatContextKeys.inputHasText),
							ChatContextKeys.requestInProgress.negate(),
						),
						ChatContextKeys.location.isEqualTo(ChatAgentLocation.EditingSession),
					),
					group: 'navigation',
				},
			]
		});
	}
}

class SubmitWithoutDispatchingAction extends Action2 {
	static readonly ID = 'workbench.action.chat.submitWithoutDispatching';

	constructor() {
		const precondition = ContextKeyExpr.and(
			// if the input has prompt instructions attached, allow submitting requests even
			// without text present - having instructions is enough context for a request
			ContextKeyExpr.or(ChatContextKeys.inputHasText, ChatContextKeys.instructionsAttached),
			whenNotInProgressOrPaused,
			ContextKeyExpr.and(ContextKeyExpr.or(
				ChatContextKeys.location.isEqualTo(ChatAgentLocation.Panel),
				ChatContextKeys.location.isEqualTo(ChatAgentLocation.Editor),
			)),
		);

		super({
			id: SubmitWithoutDispatchingAction.ID,
			title: localize2('interactive.submitWithoutDispatch.label', "Send"),
			f1: false,
			category: CHAT_CATEGORY,
			precondition,
			keybinding: {
				when: ChatContextKeys.inChatInput,
				primary: KeyMod.Alt | KeyMod.Shift | KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib
			},
			menu: [
				{
					id: MenuId.ChatExecuteSecondary,
					group: 'group_1',
					order: 2
				} // need 'when'?
			]
		});
	}

	run(accessor: ServicesAccessor, ...args: any[]) {
		const context: IChatExecuteActionContext | undefined = args[0];

		const widgetService = accessor.get(IChatWidgetService);
		const widget = context?.widget ?? widgetService.lastFocusedWidget;
		widget?.acceptInput(context?.inputValue, { noCommandDetection: true });
	}
}

export class ChatSubmitSecondaryAgentAction extends Action2 {
	static readonly ID = 'workbench.action.chat.submitSecondaryAgent';

	constructor() {
		const precondition = ContextKeyExpr.and(
			// if the input has prompt instructions attached, allow submitting requests even
			// without text present - having instructions is enough context for a request
			ContextKeyExpr.or(ChatContextKeys.inputHasText, ChatContextKeys.instructionsAttached),
			ChatContextKeys.inputHasAgent.negate(),
			whenNotInProgressOrPaused,
		);

		super({
			id: ChatSubmitSecondaryAgentAction.ID,
			title: localize2({ key: 'actions.chat.submitSecondaryAgent', comment: ['Send input from the chat input box to the secondary agent'] }, "Submit to Secondary Agent"),
			precondition,
			menu: {
				id: MenuId.ChatExecuteSecondary,
				group: 'group_1',
				order: 3,
				when: ContextKeyExpr.equals(ChatContextKeys.location.key, ChatAgentLocation.Panel)
			},
			keybinding: {
				when: ChatContextKeys.inChatInput,
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
				weight: KeybindingWeight.EditorContrib
			},
		});
	}

	run(accessor: ServicesAccessor, ...args: any[]) {
		const context: IChatExecuteActionContext | undefined = args[0];
		const agentService = accessor.get(IChatAgentService);
		const secondaryAgent = agentService.getSecondaryAgent();
		if (!secondaryAgent) {
			return;
		}

		const widgetService = accessor.get(IChatWidgetService);
		const widget = context?.widget ?? widgetService.lastFocusedWidget;
		if (!widget) {
			return;
		}

		if (extractAgentAndCommand(widget.parsedInput).agentPart) {
			widget.acceptInput();
		} else {
			widget.lastSelectedAgent = secondaryAgent;
			widget.acceptInputWithPrefix(`${chatAgentLeader}${secondaryAgent.name}`);
		}
	}
}

class SendToChatEditingAction extends Action2 {
	constructor() {
		const precondition = ContextKeyExpr.and(
			// if the input has prompt instructions attached, allow submitting requests even
			// without text present - having instructions is enough context for a request
			ContextKeyExpr.or(ChatContextKeys.inputHasText, ChatContextKeys.instructionsAttached),
			ChatContextKeys.inputHasAgent.negate(),
			whenNotInProgressOrPaused,
		);

		super({
			id: 'workbench.action.chat.sendToChatEditing',
			title: localize2('chat.sendToChatEditing.label', "Send to Copilot Edits"),
			precondition,
			category: CHAT_CATEGORY,
			f1: false,
			menu: {
				id: MenuId.ChatExecuteSecondary,
				group: 'group_1',
				order: 4,
				when: ContextKeyExpr.and(
					ChatContextKeys.enabled,
					ChatContextKeys.editingParticipantRegistered,
					ChatContextKeys.location.notEqualsTo(ChatAgentLocation.EditingSession),
					ChatContextKeys.location.notEqualsTo(ChatAgentLocation.Editor)
				)
			},
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Enter,
				when: ContextKeyExpr.and(
					ChatContextKeys.enabled,
					ChatContextKeys.editingParticipantRegistered,
					ChatContextKeys.location.notEqualsTo(ChatAgentLocation.EditingSession),
					ChatContextKeys.location.notEqualsTo(ChatAgentLocation.Editor),
				)
			}
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]) {
		if (!accessor.get(IChatAgentService).getDefaultAgent(ChatAgentLocation.EditingSession)) {
			return;
		}

		const widget = args.length > 0 && args[0].widget ? args[0].widget : accessor.get(IChatWidgetService).lastFocusedWidget;

		const viewsService = accessor.get(IViewsService);
		const dialogService = accessor.get(IDialogService);
		const chatEditingService = accessor.get(IChatEditingService);
		const currentEditingSession: IChatEditingSession | undefined = chatEditingService.editingSessionsObs.get().at(0);

		const currentEditCount = currentEditingSession?.entries.get().length;
		if (currentEditCount) {
			const result = await dialogService.confirm({
				title: localize('chat.startEditing.confirmation.title', "Start new editing session?"),
				message: currentEditCount === 1
					? localize('chat.startEditing.confirmation.message.one', "Starting a new editing session will end your current editing session containing {0} file. Do you wish to proceed?", currentEditCount)
					: localize('chat.startEditing.confirmation.message.many', "Starting a new editing session will end your current editing session containing {0} files. Do you wish to proceed?", currentEditCount),
				type: 'info',
				primaryButton: localize('chat.startEditing.confirmation.primaryButton', "Yes")
			});

			if (!result.confirmed) {
				return;
			}

			await currentEditingSession?.stop(true);
		}

		const { widget: editingWidget } = await viewsService.openView(EditsViewId) as ChatViewPane;
		if (!editingWidget.viewModel?.sessionId) {
			return;
		}
		const chatEditingSession = await chatEditingService.startOrContinueGlobalEditingSession(editingWidget.viewModel.sessionId);
		if (!chatEditingSession) {
			return;
		}
		for (const attachment of widget.attachmentModel.attachments) {
			editingWidget.attachmentModel.addContext(attachment);
		}

		editingWidget.setInput(widget.getInput());
		widget.setInput('');
		widget.attachmentModel.clear();
		editingWidget.acceptInput();
		editingWidget.focusInput();
	}
}

class SendToNewChatAction extends Action2 {
	constructor() {
		const precondition = ContextKeyExpr.and(
			// if the input has prompt instructions attached, allow submitting requests even
			// without text present - having instructions is enough context for a request
			ContextKeyExpr.or(ChatContextKeys.inputHasText, ChatContextKeys.instructionsAttached),
			whenNotInProgressOrPaused,
		);

		super({
			id: 'workbench.action.chat.sendToNewChat',
			title: localize2('chat.newChat.label', "Send to New Chat"),
			precondition,
			category: CHAT_CATEGORY,
			f1: false,
			menu: {
				id: MenuId.ChatExecuteSecondary,
				group: 'group_2',
				when: ContextKeyExpr.equals(ChatContextKeys.location.key, ChatAgentLocation.Panel)

			},
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter,
				when: ChatContextKeys.inChatInput,
			}
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]) {
		const context: IChatExecuteActionContext | undefined = args[0];

		const widgetService = accessor.get(IChatWidgetService);
		const widget = context?.widget ?? widgetService.lastFocusedWidget;
		if (!widget) {
			return;
		}

		widget.clear();
		widget.acceptInput(context?.inputValue);
	}
}

export const CancelChatActionId = 'workbench.action.chat.cancel';
export class CancelAction extends Action2 {
	static readonly ID = CancelChatActionId;
	constructor() {
		super({
			id: CancelAction.ID,
			title: localize2('interactive.cancel.label', "Cancel"),
			f1: false,
			category: CHAT_CATEGORY,
			icon: Codicon.stopCircle,
			menu: {
				id: MenuId.ChatExecute,
				when: ContextKeyExpr.and(ChatContextKeys.isRequestPaused.negate(), ChatContextKeys.requestInProgress),
				order: 4,
				group: 'navigation',
			},
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.Escape,
				win: { primary: KeyMod.Alt | KeyCode.Backspace },
			}
		});
	}

	run(accessor: ServicesAccessor, ...args: any[]) {
		const context: IChatExecuteActionContext | undefined = args[0];

		const widgetService = accessor.get(IChatWidgetService);
		const widget = context?.widget ?? widgetService.lastFocusedWidget;
		if (!widget) {
			return;
		}

		const chatService = accessor.get(IChatService);
		if (widget.viewModel) {
			chatService.cancelCurrentRequestForSession(widget.viewModel.sessionId);
		}
	}
}

export function registerChatExecuteActions() {
	registerAction2(ChatSubmitAction);
	registerAction2(ChatEditingSessionSubmitAction);
	registerAction2(SubmitWithoutDispatchingAction);
	registerAction2(CancelAction);
	registerAction2(SendToNewChatAction);
	registerAction2(ChatSubmitSecondaryAgentAction);
	registerAction2(SendToChatEditingAction);
	registerAction2(ToggleAgentModeAction);
	registerAction2(ToggleRequestPausedAction);
	registerAction2(SwitchToNextModelAction);
}
