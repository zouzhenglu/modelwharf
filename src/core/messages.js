'use strict';
/**
 * Message normalization: convert OpenAI-style messages to a canonical form
 * that provider plugins consume. Plugins may further transform per platform.
 *
 * Canonical message: { role, text, parts?: [{type:'text'|'image_url',...}] }
 */
function normalizeMessages(openaiMessages = []) {
  return openaiMessages.map(m => {
    if (typeof m.content === 'string') return { role: m.role, text: m.content, name: m.name };
    if (Array.isArray(m.content)) {
      const parts = m.content.map(p => {
        if (p.type === 'text') return { type: 'text', text: p.text };
        if (p.type === 'image_url') return { type: 'image_url', url: p.image_url?.url };
        return { type: p.type, ...p };
      });
      return { role: m.role, text: parts.filter(p => p.type === 'text').map(p => p.text).join('\n'), parts, name: m.name };
    }
    // tool messages etc: keep raw
    return { role: m.role, text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content), raw: m };
  });
}

module.exports = { normalizeMessages };
