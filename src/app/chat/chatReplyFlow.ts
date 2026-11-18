import type { ChatMessage } from '../../types/domain';
import { resolvePersonaProviderBinding } from '../../engines/personaProviderBinding';
import { isPolarisToolPromptGroupEnabled } from '../../engines/tool-protocol/toolPromptPreferences';
import { resolvePersonaMcpServers } from '../persona/personaMcpSettings';
import { requestReply, type ChatReplyRunResult, type RequestReplyChatPort } from './chatReplyRuntime';
import type { ToolActions } from './chatToolActions';
import type { ChatDerivedStatePort, ChatReplyStoreBindings, ChatUiReplyControllerState } from './chatPorts';
import { createChatReplyRequestSnapshot } from './chatReplyContext';
import type { ChatReplyRequestSnapshotSource } from './chatReplyContext';
import {
  readRequestSemanticRecallConversationBodies,
  readRequestSemanticRecallConversations
} from './chatSemanticRecallCorpus';
import { ensureChatSendPerformanceTrace, finishChatSendPerformanceTrace, recordChatSendPerformanceMark } from './chatSendPerformanceTrace';
import { selectChatConversations } from './liveConversationCatalog';
import { awaitReplyPreparation } from './chatReplyPreparation';
import { isAbortError } from './chatAbortError';

type CreateChatReplyRunnerArgs = {
  ui: ChatUiReplyControllerState;
  store: ChatReplyStoreBindings;
  derived: ChatDerivedStatePort;
  toolActions: Pick<ToolActions, 'submitAssistantToolActions'>;
  createToolActions?: (derived: ChatDerivedStatePort) => Pick<ToolActions, 'submitAssistantToolActions'>;
  includeGroupConversations?: boolean;
  disableTaskState?: boolean;
  resolveGenerationKey?: (params: {
    conversationId: string;
    collaboratorId: string;
  }) => string;
  overrideReplyChatPort?: (chat: ChatReplyStoreBindings['chat']) => RequestReplyChatPort;
  buildRequestMessages?: (args: {
    conversationId: string;
    collaboratorId: string;
    messages: ChatMessage[];
    activeCollaborator: ChatDerivedStatePort['persona'];
  }) => ChatMessage[];
  overrideRequestSource?: (args: {
    conversationId: string;
    collaboratorId: string;
    source: ChatReplyRequestSnapshotSource;
  }) => ChatReplyRequestSnapshotSource;
  resolveSemanticRecallEnabled?: (args: {
    conversationId: string;
    collaboratorId: string;
    activeCollaborator: ChatDerivedStatePort['persona'];
    defaultEnabled: boolean;
  }) => boolean;
};

export function createChatReplyRunner({
  ui,
  store,
  derived,
  toolActions,
  createToolActions,
  includeGroupConversations = false,
  disableTaskState = false,
  resolveGenerationKey,
  overrideReplyChatPort,
  buildRequestMessages,
  overrideRequestSource,
  resolveSemanticRecallEnabled
}: CreateChatReplyRunnerArgs) {
  return async (params: {
    conversationId: string;
    collaboratorId: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
    onAssistantMessageCommitted?: (messageId: string) => void;
  }) => {
    if (params.signal?.aborted) return { status: 'aborted' } satisfies ChatReplyRunResult;
    const generationControls = ui.getConversationGenerationControls(resolveGenerationKey?.({
      conversationId: params.conversationId, collaboratorId: params.collaboratorId
    }) ?? params.conversationId);
    const preparationController = new AbortController();
    const runSignal = preparationController.signal;
    const abortPreparation = () => preparationController.abort();
    params.signal?.addEventListener('abort', abortPreparation, { once: true });
    generationControls.abortControllerRef.current = preparationController;
    generationControls.setSending(true);
    ensureChatSendPerformanceTrace(params.conversationId, { messageCount: params.messages.length });
    let outcome: ChatReplyRunResult['status'] = 'failed';
    try {
      const writableConversation = await awaitReplyPreparation(store.chat.ensureConversationWritable(params.conversationId), runSignal);
      if (!writableConversation) {
        return { status: 'failed' } satisfies ChatReplyRunResult;
      }
      const baseRequestMessages = writableConversation.messages;
      const personaState = store.persona.readLatestState();
      const activeCollaborator = personaState.personas.find(
        (persona) => persona.id === params.collaboratorId
      ) ?? derived.persona;
      const requestMessages = buildRequestMessages?.({
        conversationId: params.conversationId,
        collaboratorId: params.collaboratorId,
        messages: baseRequestMessages,
        activeCollaborator
      }) ?? baseRequestMessages;
      recordChatSendPerformanceMark(params.conversationId, '聊天发送 · 回复历史就绪', {
        messageCount: requestMessages.length
      });
      const defaultSemanticRecallEnabled = activeCollaborator?.memory?.crossConversationRecallEnabled !== false;
      const semanticRecallEnabled = resolveSemanticRecallEnabled?.({
        conversationId: params.conversationId,
        collaboratorId: params.collaboratorId,
        activeCollaborator,
        defaultEnabled: defaultSemanticRecallEnabled
      }) ?? defaultSemanticRecallEnabled;
      const semanticRecallChatState = store.chat.readLatestState();
      const semanticRecallLiveConversations = selectChatConversations(semanticRecallChatState.conversations, {
        includeGroupConversations
      });
      const semanticRecallConversations = semanticRecallEnabled
        ? await awaitReplyPreparation(readRequestSemanticRecallConversations({
            liveConversations: semanticRecallLiveConversations,
            activeConversationId: params.conversationId,
            activeMessages: requestMessages,
            currentCollaboratorId: params.collaboratorId,
            config: activeCollaborator?.memory?.semanticRecall
          }), runSignal)
        : [];
      recordChatSendPerformanceMark(params.conversationId, '聊天发送 · 记忆召回目录就绪', {
        messageCount: requestMessages.length,
        extra: [
          semanticRecallEnabled ? `recall ${semanticRecallConversations.length}` : 'recall off'
        ]
      });
      const loadSemanticRecallConversations = async (conversationIds: string[]) =>
        semanticRecallEnabled
          ? await readRequestSemanticRecallConversationBodies({
              conversationIds,
              catalogConversations: semanticRecallConversations,
              activeConversationId: params.conversationId,
              activeMessages: requestMessages
            })
          : [];
      const runtimeState = store.runtime.readLatestState();
      const taskToolsEnabled = isPolarisToolPromptGroupEnabled(runtimeState.toolPromptPreferences, 'task');
      const effectiveTaskModeEnabled = taskToolsEnabled && runtimeState.taskModeEnabled;
      if (!disableTaskState) {
        store.chat.ensureConversationTask(params.conversationId, requestMessages, {
          mode: effectiveTaskModeEnabled ? 'active' : 'seed'
        });
      }

      const buildRequestSnapshot = () => {
        const chatState = store.chat.readLatestState();
        const liveConversations = selectChatConversations(chatState.conversations, {
          includeGroupConversations
        });
        const collectionState = store.collection.readLatestState();
        const personaState = store.persona.readLatestState();
        const runtimeState = store.runtime.readLatestState();
        const taskToolsEnabled = isPolarisToolPromptGroupEnabled(runtimeState.toolPromptPreferences, 'task');
        const effectiveTaskModeEnabled = taskToolsEnabled && runtimeState.taskModeEnabled;
        const spaceState = store.space.readLatestState();
        const activeConversation = liveConversations.find(
          (conversation) => conversation.id === params.conversationId
        ) ?? null;
        const snapshotActiveCollaborator = personaState.personas.find(
          (persona) => persona.id === params.collaboratorId
        ) ?? derived.persona;
        const pendingWorkspaceProposal =
          chatState.pendingWorkspaceProposals.find((proposal) => proposal.conversationId === params.conversationId) ?? null;
        const effectiveProviderBinding = resolvePersonaProviderBinding({
          globalApi: runtimeState.api,
          providers: runtimeState.providers,
          persona: snapshotActiveCollaborator
        });

        const source: ChatReplyRequestSnapshotSource = {
            api: effectiveProviderBinding.api,
            providers: runtimeState.providers,
            globalApi: runtimeState.api,
            memoryVectorRetrieval: runtimeState.memoryVectorRetrieval,
            imageGeneration: runtimeState.imageGeneration,
            imageUnderstanding: runtimeState.imageUnderstanding,
            activeWorld: spaceState.activeWorld,
            collectionShelf: spaceState.collectionShelf,
            chatAvatarLayoutEnabled: spaceState.customization.showChatAvatars,
            themeToolMode: spaceState.themeToolMode,
            enabledToolGroups: runtimeState.toolPromptPreferences,
            taskModeEnabled: effectiveTaskModeEnabled,
            mcpServers: resolvePersonaMcpServers({
              persona: snapshotActiveCollaborator,
              mcpServers: runtimeState.mcpServers
            }),
            mcpToolTimeoutSeconds: runtimeState.mcpToolTimeoutSeconds,
            themePreviewActive: Boolean(spaceState.activeThemePreview),
            currentThemeFrame: spaceState.currentThemeFrame,
            recentThemeToolModeSwitch:
              ui.themeToolModeSwitchRef.current && ui.themeToolModeSwitchRef.current.pendingTurns > 0
                ? {
                    from: ui.themeToolModeSwitchRef.current.from,
                    to: ui.themeToolModeSwitchRef.current.to
                  }
                : undefined,
            selectedSurfaceCodes: spaceState.selectedSurfaceCodes,
            collectionCards: collectionState.cards,
            imageCards: collectionState.imageCards,
            projectFiles: collectionState.projectFiles,
            workspaceReferenceDocs: collectionState.workspaceReferenceDocs,
            roomProjects: collectionState.roomProjects,
            activeCardId: spaceState.activeCardId,
            currentTask: taskToolsEnabled ? activeConversation?.task ?? null : null,
            pendingWorkspaceProposal,
            runtimeFeedbackEvents: store.chat.getRuntimeFeedbackEvents(params.conversationId),
            conversations: liveConversations,
            semanticRecallEnabled,
            semanticRecallConversations,
            personas: personaState.personas,
            currentCollaboratorId: params.collaboratorId,
            activeConversationTitle: activeConversation?.title,
            activeCollaborator: snapshotActiveCollaborator
          };
        const scopedSource = overrideRequestSource?.({
          conversationId: params.conversationId,
          collaboratorId: params.collaboratorId,
          source
        }) ?? source;

        return createChatReplyRequestSnapshot({
          source: scopedSource,
          activeConversation: activeConversation
            ? {
                id: activeConversation.id,
                title: activeConversation.title,
                activeProjectId: activeConversation.activeProjectId ?? null
              }
            : null
        });
      };
      const buildScopedDerived = (): ChatDerivedStatePort => {
        const chatState = store.chat.readLatestState();
        const liveConversations = selectChatConversations(chatState.conversations, {
          includeGroupConversations
        });
        const personaState = store.persona.readLatestState();
        const activeConversation = liveConversations.find(
          (conversation) => conversation.id === params.conversationId
        ) ?? null;

        return {
          ...derived,
          activeConversation: activeConversation
            ? {
                id: activeConversation.id,
                title: activeConversation.title,
                collaboratorId: activeConversation.collaboratorId,
                activeProjectId: activeConversation.activeProjectId ?? null,
                messages: activeConversation.messages
              }
            : null,
          activeCollaboratorSourceId: params.collaboratorId,
          persona: personaState.personas.find((persona) => persona.id === params.collaboratorId) ?? derived.persona
        };
      };

      let result: ChatReplyRunResult;
      try {
        const scopedToolActions = createToolActions?.(buildScopedDerived()) ?? toolActions;
        const initialRequestSnapshot = buildRequestSnapshot();
        recordChatSendPerformanceMark(params.conversationId, '聊天发送 · 请求上下文就绪', {
          conversationCount: initialRequestSnapshot.conversations.length,
          messageCount: requestMessages.length,
          extra: [
            `cards ${initialRequestSnapshot.collectionCards.length}`,
            `projects ${initialRequestSnapshot.roomProjects.length}`,
            `files ${initialRequestSnapshot.projectFiles.length}`,
            `feedback ${initialRequestSnapshot.runtimeFeedbackEvents.length}`
          ]
        });
        if (runSignal.aborted) return { status: 'aborted' } satisfies ChatReplyRunResult;
        result = await requestReply({
          ui: generationControls,
          chat: overrideReplyChatPort?.(store.chat) ?? store.chat,
          executeToolActions: scopedToolActions.submitAssistantToolActions,
          requestSnapshot: initialRequestSnapshot,
          refreshRequestSnapshot: buildRequestSnapshot,
          loadSemanticRecallConversations,
          writableConversation,
          ...params,
          messages: requestMessages,
          signal: runSignal
        });
      } finally {
        const switchHint = ui.themeToolModeSwitchRef.current;
        if (switchHint) {
          if (switchHint.pendingTurns <= 1) {
            ui.themeToolModeSwitchRef.current = null;
          } else {
            ui.themeToolModeSwitchRef.current = {
              ...switchHint,
              pendingTurns: switchHint.pendingTurns - 1
            };
          }
        }
      }
      outcome = result?.status ?? 'completed';
      return result;
    } catch (error) {
      if (isAbortError(error)) { outcome = 'aborted'; return { status: 'aborted' } satisfies ChatReplyRunResult; }
      throw error;
    } finally {
      params.signal?.removeEventListener('abort', abortPreparation);
      if (generationControls.abortControllerRef.current === preparationController) {
        generationControls.abortControllerRef.current = null;
        generationControls.setSending(false);
      }
      finishChatSendPerformanceTrace(params.conversationId, runSignal.aborted ? 'aborted' : outcome);
    }
  };
}
