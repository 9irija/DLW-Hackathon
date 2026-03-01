/**
 * LLM helper: Chat Completions API vs Responses API (Codex).
 * When model name includes "codex", use Responses API (v1/responses); otherwise Chat Completions.
 */
const openai = require('./openai');

/**
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.system - System/developer prompt
 * @param {string} opts.user   - User message
 * @param {number} [opts.temperature]
 * @param {number} [opts.max_tokens]
 * @param {boolean} [opts.jsonMode] - Ask for JSON output (response_format / text.format)
 * @returns {Promise<string>} Raw text from the model
 */
async function complete({ model, system, user, temperature, max_tokens, jsonMode }) {
  const useResponses = typeof model === 'string' && model.toLowerCase().includes('codex');

  if (useResponses) {
    const body = {
      model,
      input: [
        { role: 'developer', content: system },
        { role: 'user', content: user },
      ],
      max_output_tokens: max_tokens ?? 2048,
    };
    // Codex/Responses: omit temperature — many Codex models do not support it (400 if sent)
    if (jsonMode) body.text = { format: { type: 'json_object' } };
    const response = await openai.responses.create(body);
    return (response.output_text || '').trim();
  }

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const body = {
    model,
    temperature: temperature ?? 0.2,
    max_tokens: max_tokens ?? 2048,
    messages,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const completion = await openai.chat.completions.create(body);
  return (completion.choices?.[0]?.message?.content ?? '').trim();
}

module.exports = { complete };
