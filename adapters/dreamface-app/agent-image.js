import { defineAdapter, errors } from './_webview.js';
import { ORIGIN_ARG, runAgent, siteOrigin } from './_shared.js';

export default defineAdapter({
  description: 'Have the DreamFace agent generate images from a description; waits for them and returns their URLs. Uses credits. （智能体 生成图片 图像）',
  access: 'write',
  domain: 'facemojiapp.com',
  args: [
    { name: 'prompt', type: 'string', required: true, help: 'What the image should show', example: '一只戴墨镜的柯基在海边，扁平插画风格' },
    { name: 'count', type: 'int', default: 1, min: 1, max: 4, help: 'How many images to ask for' },
    { name: 'model', type: 'string', default: '', help: 'If omitted uses the first model of this App environment; see dreamface-app agent-models' },
    { name: 'timeout_sec', type: 'int', default: 300, min: 30, max: 1800 },
    ORIGIN_ARG,
  ],
  result: { kind: 'value', description: 'The agent turn', fields: { answer: 'string', images: 'media[]', project_id: 'string', tools: 'string[]', credits_used: 'number' } },
  async run({ tab, args }) {
    const prompt = String(args.prompt || '').trim();
    if (!prompt) throw errors.argument('`prompt` is required');
    const count = args.count ?? 1;
    const turn = await runAgent(tab, siteOrigin(args), { message: `生成${count}张图片：${prompt}。只要${count}张，直接生成，不要追问。`, model: args.model || '', timeoutSec: args.timeout_sec ?? 300 });
    if (!turn.images.length) throw errors.empty(`The agent produced no image. It said: ${turn.answer.slice(0, 300)}`);
    return turn;
  },
});
