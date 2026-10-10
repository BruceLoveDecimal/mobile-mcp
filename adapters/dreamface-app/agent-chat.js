import { defineAdapter, errors } from './_webview.js';
import { ORIGIN_ARG, runAgent, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'Ask the DreamFace agent (home page / canvas) a question and get its answer. Starts a new canvas project; may use a free daily agent use or credits. （智能体 问答 对话）',
  access: 'write',
  domain: 'facemojiapp.com',
  args: [
    { name: 'message', type: 'string', required: true, help: 'What to ask the agent', example: '用一句话介绍 DreamFace 能做什么' },
    { name: 'model', type: 'string', default: '', help: 'If omitted uses the first model of this App environment; see dreamface-app agent-models' },
    { name: 'timeout_sec', type: 'int', default: 180, min: 10, max: 1800 },
    ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'The agent turn', fields: { answer: 'string', images: 'media[]', videos: 'media[]', project_id: 'string', conversation_id: 'string', tools: 'string[]', credits_used: 'number' } },
  async run({ tab, args }) {
    const message = String(args.message || '').trim();
    if (!message) throw errors.argument('`message` is required');
    return runAgent(tab, siteOrigin(args), { message, model: args.model || '', timeoutSec: args.timeout_sec ?? 180 });
  },
});
