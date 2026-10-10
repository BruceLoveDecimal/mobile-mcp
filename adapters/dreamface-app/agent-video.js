import { defineAdapter, errors } from './_webview.js';
import { ORIGIN_ARG, runAgent, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'Have the DreamFace agent generate a short video from a description; waits for it (minutes) and returns its URL. Uses credits. （智能体 生成视频）',
  access: 'write',
  domain: 'facemojiapp.com',
  args: [
    { name: 'prompt', type: 'string', required: true, help: 'What the video should show', example: '一只橘猫在窗台上伸懒腰' },
    { name: 'duration_sec', type: 'int', default: 5, min: 3, max: 15, help: 'Desired length' },
    { name: 'cheapest', type: 'boolean', default: true, help: 'Ask the agent for its cheapest configuration' },
    { name: 'model', type: 'string', default: '', help: 'If omitted uses the first model of this App environment; see dreamface-app agent-models' },
    { name: 'timeout_sec', type: 'int', default: 900, min: 60, max: 3600 },
    ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'The agent turn', fields: { answer: 'string', videos: 'media[]', project_id: 'string', tools: 'string[]', credits_used: 'number' } },
  async run({ tab, args }) {
    const prompt = String(args.prompt || '').trim();
    if (!prompt) throw errors.argument('`prompt` is required');
    const duration = args.duration_sec ?? 5;
    const message = `生成一段 ${duration} 秒的短视频：${prompt}。只要一段${args.cheapest === false ? '' : '，用最便宜的配置'}，直接生成，不要追问。`;
    const turn = await runAgent(tab, siteOrigin(args), { message, model: args.model || '', timeoutSec: args.timeout_sec ?? 900 });
    if (!turn.videos.length) throw errors.empty(`The agent produced no video. It said: ${turn.answer.slice(0, 300)}`);
    return turn;
  },
});
