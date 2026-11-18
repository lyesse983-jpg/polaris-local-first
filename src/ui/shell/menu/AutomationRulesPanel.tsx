import { HeartbeatWorkerPanel } from './HeartbeatWorkerPanel';
import { useEffect, useMemo, useState } from 'react';
import type { I18nTranslator } from '../../../i18n/translator';
import { useI18n } from '../../../i18n/useI18n';
import type { Conversation, Persona, PolarisTriggerRule, PolarisTriggerSchedule } from '../../../types/domain';
import { Icon } from '../../Icon';
import {
  buildAutomationSchedule,
  defaultOnceInput,
  earliestOnceInput,
  isConsumedOnceRule,
  toLocalDateTimeInput,
  type AutomationDelivery,
  type AutomationScheduleMode
} from './automationHeartbeatForm';

type ConversationSelectMode = PolarisTriggerRule['target']['conversationMode'];

export type AutomationRulesPanelProps = {
  personas: Persona[];
  conversations: Conversation[];
  triggerRules: PolarisTriggerRule[];
  lockedCollaboratorId?: string | null;
  formInitiallyOpen?: boolean;
  emptyTitle?: string;
  emptyActionLabel?: string | null;
  formNote?: string;
  rulesNote?: string;
  onCreateTriggerRule: (seed: {
    collaboratorId: string;
    conversationMode?: ConversationSelectMode;
    conversationId?: string | null;
    schedule: PolarisTriggerSchedule;
    prompt: string;
    delivery?: AutomationDelivery;
    autonomous?: boolean;
    name?: string;
  }) => string | null;
  onUpdateTriggerRule: (ruleId: string, patch: Partial<PolarisTriggerRule>) => void;
  onDeleteTriggerRule: (ruleId: string) => void;
  onTestTriggerRule: (ruleId: string) => void;
  onCopyTriggerUrl: (ruleId: string) => void;
  onAfterTestTriggerRule?: () => void;
};

function formatDateTime(value: number | null, i18n: I18nTranslator) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return i18n.t('settings.automation.unscheduled');
  return new Intl.DateTimeFormat(i18n.language, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatSchedule(schedule: PolarisTriggerSchedule, i18n: I18nTranslator) {
  const { t, language } = i18n;
  if (schedule.kind === 'once') {
    return `${language === 'en-US' ? 'Once' : '一次性'} · ${formatDateTime(schedule.at, i18n)}`;
  }
  return schedule.kind === 'daily'
    ? t('settings.automation.scheduleDaily', { time: schedule.time })
    : t('settings.automation.scheduleInterval', { minutes: schedule.everyMinutes });
}

function resolvePersonaName(personas: Persona[], collaboratorId: string, t: I18nTranslator['t']) {
  return personas.find((persona) => persona.id === collaboratorId)?.name ?? t('settings.automation.unknownPersona');
}

function formatConversationUpdatedAt(conversation: Conversation, language: I18nTranslator['language']) {
  return new Intl.DateTimeFormat(language, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(conversation.updatedAt));
}

function resolveConversationTitle(conversations: Conversation[], conversationId: string | null) {
  if (!conversationId) return null;
  return conversations.find((conversation) => conversation.id === conversationId)?.title.trim() || null;
}

function isSelectedConversationTarget(
  conversationMode: ConversationSelectMode,
  selectedConversationId: string,
  optionId: string
) {
  return conversationMode === 'fixed' && selectedConversationId === optionId;
}

export function AutomationRulesPanel({
  personas,
  conversations,
  triggerRules,
  lockedCollaboratorId = null,
  formInitiallyOpen,
  emptyTitle,
  emptyActionLabel,
  formNote,
  rulesNote,
  onCreateTriggerRule,
  onUpdateTriggerRule,
  onDeleteTriggerRule,
  onTestTriggerRule,
  onCopyTriggerUrl,
  onAfterTestTriggerRule
}: AutomationRulesPanelProps) {
  const i18n = useI18n();
  const { t, language } = i18n;
  const resolvedEmptyTitle = emptyTitle ?? t('settings.automation.defaultEmptyTitle');
  const resolvedEmptyActionLabel = emptyActionLabel === undefined
    ? t('settings.automation.defaultEmptyAction')
    : emptyActionLabel;
  const resolvedFormNote = formNote ?? t('settings.automation.defaultFormNote');
  const resolvedRulesNote = rulesNote ?? t('settings.automation.defaultRulesNote');
  const visiblePersonas = lockedCollaboratorId
    ? personas.filter((persona) => persona.id === lockedCollaboratorId)
    : personas;
  const visibleRules = useMemo(
    () => lockedCollaboratorId
      ? triggerRules.filter((rule) => rule.target.collaboratorId === lockedCollaboratorId)
      : triggerRules,
    [lockedCollaboratorId, triggerRules]
  );
  const firstPersonaId = lockedCollaboratorId ?? visiblePersonas[0]?.id ?? '';
  const [formOpen, setFormOpen] = useState(formInitiallyOpen ?? visibleRules.length === 0);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [collaboratorId, setCollaboratorId] = useState(firstPersonaId);
  const [mode, setMode] = useState<AutomationScheduleMode>('once');
  const [onceAt, setOnceAt] = useState(() => defaultOnceInput());
  const [delivery, setDelivery] = useState<AutomationDelivery>('message');
  const [autonomous, setAutonomous] = useState(false);
  const [dailyTime, setDailyTime] = useState('22:30');
  const [intervalMinutes, setIntervalMinutes] = useState('180');
  const [conversationMode, setConversationMode] = useState<ConversationSelectMode>('follow-latest');
  const [conversationId, setConversationId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [rulesHelpOpen, setRulesHelpOpen] = useState(false);

  const sortedRules = useMemo(
    () => [...visibleRules].sort((left, right) => {
      if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
      return (left.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (right.nextRunAt ?? Number.MAX_SAFE_INTEGER);
    }),
    [visibleRules]
  );
  const hasRules = sortedRules.length > 0;
  const showRulesSection = hasRules || !formOpen;
  const editingRule = editingRuleId
    ? visibleRules.find((rule) => rule.id === editingRuleId) ?? null
    : null;
  const editing = editingRuleId !== null;
  const targetConversationOptions = useMemo(
    () => conversations.filter((conversation) =>
      conversation.collaboratorId === (lockedCollaboratorId ?? collaboratorId)
      && (conversation.activeProjectId ?? null) === null
    ),
    [collaboratorId, conversations, lockedCollaboratorId]
  );

  useEffect(() => {
    if (lockedCollaboratorId && collaboratorId !== lockedCollaboratorId) {
      setCollaboratorId(lockedCollaboratorId);
      return;
    }
    if (!collaboratorId && firstPersonaId) setCollaboratorId(firstPersonaId);
  }, [collaboratorId, firstPersonaId, lockedCollaboratorId]);

  useEffect(() => {
    if (conversationMode !== 'fixed') return;
    if (!conversationId) return;
    if (targetConversationOptions.some((conversation) => conversation.id === conversationId)) return;
    setConversationMode('follow-latest');
    setConversationId('');
  }, [conversationId, conversationMode, targetConversationOptions]);

  const resetForm = () => {
    setEditingRuleId(null);
    setName('');
    setCollaboratorId(firstPersonaId);
    setMode('once');
    setOnceAt(defaultOnceInput());
    setDelivery('message');
    setAutonomous(false);
    setDailyTime('22:30');
    setIntervalMinutes('180');
    setConversationMode('follow-latest');
    setConversationId('');
    setPrompt('');
  };

  const openCreateForm = () => {
    resetForm();
    setFormOpen(true);
  };

  const openEditForm = (rule: PolarisTriggerRule) => {
    setEditingRuleId(rule.id);
    setName(rule.name);
    setCollaboratorId(lockedCollaboratorId ?? rule.target.collaboratorId);
    setConversationMode(rule.target.conversationMode === 'fixed' && rule.target.conversationId ? 'fixed' : 'follow-latest');
    setConversationId(rule.target.conversationMode === 'fixed' ? rule.target.conversationId ?? '' : '');
    setPrompt(rule.action.prompt);
    setDelivery(rule.action.delivery === 'silent' ? 'silent' : 'message');
    setAutonomous(rule.action.autonomous === true);
    setOnceAt(rule.schedule.kind === 'once' ? toLocalDateTimeInput(rule.schedule.at) : defaultOnceInput());
    if (rule.schedule.kind === 'once') {
      setMode('once');
      setDailyTime('22:30');
      setIntervalMinutes('180');
    } else if (rule.schedule.kind === 'daily') {
      setMode('daily');
      setDailyTime(rule.schedule.time);
      setIntervalMinutes('180');
    } else {
      setMode('interval');
      setDailyTime('22:30');
      setIntervalMinutes(String(rule.schedule.everyMinutes));
    }
    setFormOpen(true);
  };

  const closeForm = () => {
    resetForm();
    setFormOpen(false);
  };

  const submitForm = () => {
    const schedule = buildAutomationSchedule({ mode, dailyTime, intervalMinutes, onceAt });
    if (!schedule) {
      window.alert(mode === 'once'
        ? (language === 'en-US' ? 'Choose a local time from one minute to 30 days ahead.' : '请选择 1 分钟至 30 天内的一次性唤醒时间。')
        : mode === 'daily' ? t('settings.automation.invalidDaily') : t('settings.automation.invalidInterval'));
      return;
    }
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      window.alert(t('settings.automation.emptyPrompt'));
      return;
    }
    const targetCollaboratorId = lockedCollaboratorId ?? collaboratorId;
    if (!targetCollaboratorId) {
      window.alert(t('settings.automation.missingPersona'));
      return;
    }
    if (conversationMode === 'fixed' && !conversationId) {
      window.alert(t('settings.automation.missingConversation'));
      return;
    }

    if (editing) {
      if (!editingRule) {
        window.alert(t('settings.automation.ruleMissing'));
        closeForm();
        return;
      }
      onUpdateTriggerRule(editingRuleId, {
        name: name.trim() || editingRule.name,
        schedule,
        target: {
          ...editingRule.target,
          collaboratorId: targetCollaboratorId,
          conversationMode,
          conversationId: conversationMode === 'fixed' ? conversationId : null
        },
        action: {
          prompt: trimmedPrompt,
          delivery,
          autonomous
        },
        ...(schedule.kind === 'once' ? { enabled: true } : {}),
        lastError: null
      });
      closeForm();
      return;
    }

    const createdId = onCreateTriggerRule({
      name,
      collaboratorId: targetCollaboratorId,
      conversationMode,
      conversationId: conversationMode === 'fixed' ? conversationId : null,
      schedule,
      prompt: trimmedPrompt,
      delivery,
      autonomous
    });
    if (createdId) closeForm();
  };

  return (
    <div className={`automation-rules-panel ${lockedCollaboratorId ? 'automation-rules-panel--collaborator' : 'automation-rules-panel--menu'}`}>
      <HeartbeatWorkerPanel />
      <section className="menu-section automation-form-section automation-rules-head-section">
        <div className="menu-section-head">
          <span className="menu-section-kicker">{t('settings.automation.rulesSection')}</span>
          <p className="menu-section-note">{resolvedRulesNote}</p>
          <p className="menu-section-note">{language === 'en-US'
            ? 'Wake-ups continue with the same collaborator, memories and conversation. Enable “Proactive messages” in the toolbox to let the collaborator manage appointments.'
            : '唤醒会沿用同一位协作者、记忆和聊天记录。开启工具箱里的「主动消息」，协作者才能管理自己的预约。'}</p>
          <p className="menu-section-note" role="note">{language === 'en-US'
            ? 'This test version runs model and tool work while the app runtime is active. A scheduled system notification alone does not mean background AI work has run.'
            : '此测试版需要应用运行环境保持活动，才能执行模型和工具。收到定时系统通知，不代表后台已经运行了 AI。'}</p>
        </div>
        <div className="automation-rules-head-actions">
          {!formOpen ? (
            <div className="mcp-page-actions">
              <button type="button" className="mcp-icon-button mcp-page-action-button" onClick={openCreateForm} aria-label={t('settings.automation.addTriggerAria')}>
                <Icon name="plus" size={14} />
                <span>{t('settings.automation.addRule')}</span>
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className={`automation-rules-help-toggle ${rulesHelpOpen ? 'automation-rules-help-toggle--open' : ''}`}
            aria-expanded={rulesHelpOpen}
            onClick={() => setRulesHelpOpen((open) => !open)}
          >
            <Icon name="infoCard" size={14} />
            <span>{t('settings.automation.localNotification')}</span>
            <Icon name="chevronDown" size={13} />
          </button>
        </div>
        {rulesHelpOpen ? (
          <div className="automation-rules-help-panel" role="note">
            <strong>{t('settings.automation.helpTitle')}</strong>
            <span>{t('settings.automation.helpDetail')}</span>
            <span>{language === 'en-US'
              ? 'A one-time appointment is consumed after it fires. To wake again, the collaborator needs to create or update an appointment. Silent work keeps tool actions and results in the conversation without sending a chat message.'
              : '一次性预约触发后即结束。下一次醒来需要协作者重新创建或修改预约。安静做事会保留会话里的工具操作和结果，不发送聊天消息。'}</span>
          </div>
        ) : null}
      </section>

      {formOpen ? (
        <section className="menu-section automation-form-section">
          <div className="menu-section-head automation-form-head">
            <span className="menu-section-kicker ps-field-label">{editing ? t('settings.automation.editMode') : t('settings.automation.createMode')}</span>
            <p className="menu-section-note ps-field-hint">{editing ? editingRule?.name ?? t('settings.automation.editingCurrent') : resolvedFormNote}</p>
          </div>
          <div className="settings-form automation-settings-form">
            <label className="automation-field ps-field">
              <span className="ps-field-label">{t('settings.automation.nameLabel')}</span>
              <input className="ps-input" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('settings.automation.namePlaceholder')} />
            </label>

            {lockedCollaboratorId ? null : (
              <label className="automation-field ps-field">
                <span className="ps-field-label">{t('settings.automation.personaLabel')}</span>
                <select className="ps-input" value={collaboratorId} onChange={(event) => setCollaboratorId(event.target.value)}>
                  {visiblePersonas.map((persona) => (
                    <option key={persona.id} value={persona.id}>{persona.name}</option>
                  ))}
                </select>
              </label>
            )}

            <fieldset className="automation-field automation-conversation-field ps-field">
              <legend className="ps-field-label automation-field-label-row">
                <span>{t('settings.automation.targetLabel')}</span>
                <small>{t('settings.automation.required')}</small>
              </legend>
              <div className="automation-conversation-list" role="radiogroup" aria-label={t('settings.automation.targetAria')}>
                <button
                  type="button"
                  className={`automation-conversation-option ${conversationMode === 'follow-latest' ? 'selected' : ''}`}
                  role="radio"
                  aria-checked={conversationMode === 'follow-latest'}
                  onClick={() => {
                    setConversationMode('follow-latest');
                    setConversationId('');
                  }}
                >
                  <span>{t('settings.automation.followLatest')}</span>
                  <small>{t('settings.automation.followLatestDetail')}</small>
                </button>
                {targetConversationOptions.map((conversation) => {
                  const selected = isSelectedConversationTarget(conversationMode, conversationId, conversation.id);
                  return (
                    <button
                      key={conversation.id}
                      type="button"
                      className={`automation-conversation-option ${selected ? 'selected' : ''}`}
                      role="radio"
                      aria-checked={selected}
                      onClick={() => {
                        setConversationMode('fixed');
                        setConversationId(conversation.id);
                      }}
                    >
                      <span>{conversation.title.trim() || t('settings.automation.untitledConversation')}</span>
                      <small>{formatConversationUpdatedAt(conversation, language)}</small>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div className="mcp-transport-field automation-schedule-field ps-field">
              <span className="ps-field-label automation-field-label-row">
                <span>{t('settings.automation.timeLabel')}</span>
                <small>{t('settings.automation.required')}</small>
              </span>
              <select aria-label={t('settings.automation.timeLabel')} value={mode} onChange={(event) => setMode(event.target.value as AutomationScheduleMode)}>
                <option value="once">{language === 'en-US' ? 'One-time wake-up' : '一次性唤醒'}</option>
                <option value="daily">{t('settings.automation.dailyMode')}</option>
                <option value="interval">{t('settings.automation.intervalMode')}</option>
              </select>
              {mode === 'once' ? (
                <>
                  <input
                    className="ps-input"
                    type="datetime-local"
                    aria-label={language === 'en-US' ? 'One-time wake-up time' : '一次性唤醒时间'}
                    min={earliestOnceInput()}
                    value={onceAt}
                    onChange={(event) => setOnceAt(event.target.value)}
                  />
                  <span className="ps-field-hint">{language === 'en-US' ? 'Device local time · one minute to 30 days ahead.' : '按设备本地时间预约，范围为 1 分钟至 30 天。'}</span>
                </>
              ) : mode === 'daily' ? (
                <input
                  className="ps-input"
                  type="time"
                  value={dailyTime}
                  onChange={(event) => setDailyTime(event.target.value)}
                  placeholder="22:30"
                />
              ) : (
                <div className="automation-interval-input-wrap">
                  <input
                    className="ps-input"
                    type="number"
                    min="1"
                    step="1"
                    value={intervalMinutes}
                    onChange={(event) => setIntervalMinutes(event.target.value)}
                    placeholder="180"
                    inputMode="numeric"
                  />
                  <span>{t('settings.automation.minutesUnit')}</span>
                </div>
              )}
            </div>

            <label className="automation-field ps-field">
              <span className="ps-field-label">{language === 'en-US' ? 'When awake' : '醒来之后'}</span>
              <select value={delivery} onChange={(event) => setDelivery(event.target.value as AutomationDelivery)}>
                <option value="message">{language === 'en-US' ? 'Start a conversation' : '主动聊天'}</option>
                <option value="silent">{language === 'en-US' ? 'Work quietly' : '安静做事'}</option>
              </select>
              <span className="ps-field-hint">{delivery === 'silent'
                ? (language === 'en-US' ? 'Keep tool activity and results in this conversation without a chat reply or reply notification.' : '保留本会话里的工具操作和结果，不发送聊天回复或回复通知。')
                : (language === 'en-US' ? 'The reply appears in the selected conversation.' : '回复会出现在选定的会话中。')}</span>
            </label>

            <div className="automation-field ps-field">
              <div className="automation-autonomy-row">
                <span className="ps-field-label">{language === 'en-US' ? 'Let the collaborator arrange the next wake-up' : '允许协作者自行安排下一次唤醒'}</span>
                <button
                  type="button"
                  role="switch"
                  className={`ps-toggle-sw automation-autonomy-switch ${autonomous ? 'ps-toggle-sw--on' : ''}`}
                  aria-checked={autonomous}
                  aria-label={language === 'en-US' ? 'Let the collaborator arrange the next wake-up' : '允许协作者自行安排下一次唤醒'}
                  onClick={() => setAutonomous((current) => !current)}
                ><span className="ps-toggle-knob" /></button>
              </div>
              <span className="ps-field-hint">{language === 'en-US'
                ? 'During this wake-up, the collaborator may choose when to continue, work quietly, or leave no next appointment. This also enables the “Proactive messages” tools; other tool permissions stay as configured.'
                : '这次醒来时，协作者可以决定何时继续、安静做事，或暂不预约下一次。保存时会同时开启「主动消息」工具，其他工具仍沿用原设置。'}</span>
            </div>

            <label className="automation-field ps-field">
              <span className="ps-field-label automation-field-label-row">
                <span>{t('settings.automation.promptLabel')}</span>
                <small>{t('settings.automation.required')}</small>
              </span>
              <textarea
                className="ps-textarea"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={t('settings.automation.promptPlaceholder')}
              />
            </label>

            <div className="automation-form-actions">
              <button type="button" className="mcp-btn secondary" onClick={closeForm}>
                {t('settings.automation.cancel')}
              </button>
              <button type="button" className="mcp-btn primary" onClick={submitForm}>
                {editing ? t('settings.automation.save') : t('settings.automation.create')}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {showRulesSection ? (
        <section className="menu-section">
          {hasRules ? (
            <div className="automation-rule-list">
              {sortedRules.map((rule) => (
                <article key={rule.id} className={`automation-rule-card ${rule.enabled ? 'enabled' : 'disabled'}`}>
                  <button type="button" className="mcp-btn danger automation-rule-delete-btn" onClick={() => onDeleteTriggerRule(rule.id)} aria-label={t('settings.automation.deleteAria', { name: rule.name })}>
                    <Icon name="x" size={13} />
                    <span className="automation-rule-action-label">{t('settings.automation.delete')}</span>
                  </button>
                  <div className="automation-rule-main">
                    <div className="automation-rule-title-row">
                      <span className={`mcp-server-dot ${rule.enabled ? 'active' : 'inactive'}`} />
                      <strong>{rule.name}</strong>
                    </div>
                    <div className="automation-rule-badges">
                      <span className={`automation-rule-badge ${rule.enabled ? 'active' : 'inactive'}`}>
                        {isConsumedOnceRule(rule)
                          ? (rule.lastError ? (language === 'en-US' ? 'Run failed' : '本次执行失败') : (language === 'en-US' ? 'Appointment fired' : '本次已触发'))
                          : rule.enabled ? t('settings.automation.enabled') : t('settings.automation.disabled')}
                      </span>
                      {lockedCollaboratorId ? null : (
                        <span className="automation-rule-badge">{resolvePersonaName(personas, rule.target.collaboratorId, t)}</span>
                      )}
                      <span className="automation-rule-badge">
                        {rule.target.conversationMode === 'fixed'
                          ? t('settings.automation.fixedConversation', { title: resolveConversationTitle(conversations, rule.target.conversationId) ?? t('settings.automation.missingConversationTitle') })
                          : t('settings.automation.followLatestBadge')}
                      </span>
                      <span className="automation-rule-badge">{formatSchedule(rule.schedule, i18n)}</span>
                      <span className="automation-rule-badge">{rule.action.delivery === 'silent'
                        ? (language === 'en-US' ? 'Quiet work' : '安静做事')
                        : (language === 'en-US' ? 'Chat reply' : '主动聊天')}</span>
                      {rule.action.autonomous ? <span className="automation-rule-badge">{language === 'en-US' ? 'Self-scheduled continuation allowed' : '可自主续约'}</span> : null}
                    </div>
                    <p className="automation-rule-prompt">{rule.action.prompt}</p>
                    <div className="automation-rule-meta">
                      <span>{t('settings.automation.nextRun', { time: formatDateTime(rule.nextRunAt, i18n) })}</span>
                      <span>{t('settings.automation.lastRun', { time: formatDateTime(rule.lastRunAt, i18n) })}</span>
                    </div>
                    {rule.lastError ? <div className="automation-rule-error">{rule.lastError}</div> : null}
                  </div>
                  <div className="automation-rule-actions">
                    <button
                      type="button"
                      className={`ps-toggle-sw ${rule.enabled ? 'ps-toggle-sw--on' : ''}`}
                      aria-label={t('settings.automation.toggleAria', { name: rule.name, status: rule.enabled ? t('settings.automation.enabled') : t('settings.automation.disabled') })}
                      aria-pressed={rule.enabled}
                      onClick={() => {
                        if (isConsumedOnceRule(rule)) {
                          openEditForm(rule);
                          return;
                        }
                        onUpdateTriggerRule(rule.id, { enabled: !rule.enabled });
                      }}
                    >
                      <span className="ps-toggle-knob" />
                    </button>
                    <button type="button" className="mcp-btn secondary automation-rule-action-btn" onClick={() => openEditForm(rule)} aria-label={t('settings.automation.editAria', { name: rule.name })}>
                      <Icon name="edit" size={14} />
                      <span className="automation-rule-action-label">{t('settings.automation.edit')}</span>
                    </button>
                    <button type="button" className="mcp-btn secondary automation-rule-action-btn" aria-label={t('settings.automation.testAria', { name: rule.name })} onClick={() => {
                      onTestTriggerRule(rule.id);
                      onAfterTestTriggerRule?.();
                    }}>
                      <Icon name="play" size={14} />
                      <span className="automation-rule-action-label">{t('settings.automation.test')}</span>
                    </button>
                    <button type="button" className="mcp-btn secondary automation-rule-action-btn" onClick={() => onCopyTriggerUrl(rule.id)} aria-label={t('settings.automation.copyShortcutAria', { name: rule.name })}>
                      <Icon name="copy" size={14} />
                      <span className="automation-rule-action-label">{t('settings.automation.copy')}</span>
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="automation-empty-state">
              <strong>{resolvedEmptyTitle}</strong>
              {resolvedEmptyActionLabel ? (
                <button type="button" className="mcp-btn primary" onClick={openCreateForm}>
                  {resolvedEmptyActionLabel}
                </button>
              ) : null}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
