import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageMarkdown } from './MessageMarkdown';
import { MessageContent } from './MessageContent';

describe('paragraph bubble presentation', () => {
  it('shows blank-line separated prose in separate bubbles while keeping soft line breaks together', () => {
    const content = '第一段\n同段换行\n\n第二段\n\n第三段🙂';
    const html = renderToStaticMarkup(<MessageMarkdown content={content} assistantBubbles />);
    expect(html.match(/assistant-paragraph-frame/g)).toHaveLength(3);
    expect(html).toContain('同段换行');
    expect(html).toContain('第三段🙂');
  });

  it('keeps headings with their block and preserves complete lists, code, and tables', () => {
    const html = renderToStaticMarkup(<MessageMarkdown assistantBubbles content={[
      '## 计划', '', '- 第一项', '- 第二项', '',
      '```text', '代码前半', '', '代码后半', '```', '',
      '| 项 | 值 |', '| --- | --- |', '| A | B |'
    ].join('\n')} />);
    expect(html.match(/assistant-paragraph-frame/g)).toHaveLength(3);
    expect(html.match(/<ul/g)).toHaveLength(1);
    expect(html.match(/<table/g)).toHaveLength(1);
    expect(html).toContain('代码前半');
    expect(html).toContain('代码后半');
  });

  it('changes only assistant presentation and leaves the original source message intact', () => {
    const message = { id: 'source-message', role: 'assistant' as const, timestamp: 1, content: '甲\n\n乙' };
    const before = JSON.stringify(message);
    const props = { message, codeCardActionMode: 'hidden' as const, isCodeExpanded: false,
      showThinking: false, onToggleCodeExpanded: () => {}, onApplyCustomCss: () => {} };
    expect(renderToStaticMarkup(<MessageContent {...props} splitAssistantBubbles />).match(/assistant-paragraph-frame/g)).toHaveLength(2);
    expect(JSON.stringify(message)).toBe(before);
    expect(renderToStaticMarkup(<MessageContent {...props} message={{ ...message, role: 'user' }} splitAssistantBubbles />)).not.toContain('assistant-paragraph-frame');
  });
});
