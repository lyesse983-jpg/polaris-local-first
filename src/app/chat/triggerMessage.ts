import { createMessage } from '../../engines/chatMessageFactory';
import type { ChatMessage, PolarisTriggerRule } from '../../types/domain';
import type { RuntimeTriggerEvent } from '../../stores/runtimeStoreTriggers';

function buildTriggerRequestContent(rule: PolarisTriggerRule, event: RuntimeTriggerEvent | null) {
  const heartbeatContext = rule.action.autonomous || rule.action.delivery === 'silent'
    ? [
        `本次为应用触发的心跳，规则 ID：${rule.id}。当前时间：${new Date().toISOString()}。`,
        rule.action.autonomous
          ? `用户已在此规则中开启自主续约。结合当前人设、原始聊天、记忆和实际工具结果决定是否继续；如有需要，用 updateProactiveMessageRule 更新规则 ${rule.id}，scheduleKind 设为 once，用 afterMinutes 指定多久后再醒（1 至 43200 分钟），prompt 写具体原因和下次要做的事。也可以不续约。不要创建循环闲聊。`
          : '本次没有自主续约授权；按用户设置执行，不自行增加后续预约。',
        rule.action.delivery === 'silent'
          ? '本次为安静做事：可以读取已有材料、继续计划、保存真实成果或记忆，也可以什么都不做。最终只写简短的实际工作状态，不写面向用户的问候或催问。程序保留工具证据和工作备注，不发主动聊天通知。'
          : '本次可主动聊天。若没有新的内容可以表达，可以只用工具安排后续；不要编造离线期间的经历。',
        '手机应用不运行时，本地模型和工具不会继续执行；不要把计划中的事描述成已经发生。'
      ].join('\n')
    : null;
  return [rule.action.prompt, event?.prompt ?? null, heartbeatContext]
    .filter((line): line is string => Boolean(line?.trim()))
    .join('\n\n');
}

function buildTriggerTimelineContent(rule: PolarisTriggerRule, event: RuntimeTriggerEvent | null) {
  const sourceLabel = event?.source === 'shortcut'
    ? '快捷指令唤醒'
    : event?.source === 'notification'
      ? '通知唤醒'
      : rule.source === 'schedule'
        ? '定时唤醒'
        : '主动唤醒';
  return `（${sourceLabel}：${rule.name}）`;
}

export function createTriggerMessage(rule: PolarisTriggerRule, event: RuntimeTriggerEvent | null): ChatMessage {
  return {
    ...createMessage('system', buildTriggerTimelineContent(rule, event), undefined, 'trigger-runtime'),
    requestRole: 'user',
    requestContent: buildTriggerRequestContent(rule, event)
  };
}
