// Non-streamed replies: text, reasoning, usage, tools, JSON output.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { findJsonSchemaBlock, schemaInstance } from '../../mock-server/schema-instance.mjs';
import { postChat, startMock, userChat } from './helpers.mjs';

let mock;
before(async () => {
  mock = await startMock({ rateLimit: 0 });
});
after(() => mock.close());

async function complete(body) {
  const res = await postChat(mock.baseUrl, body);
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Current weather for a city',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
        days: { type: 'integer' },
        detailed: { type: 'boolean' },
      },
      required: ['city'],
    },
  },
};

describe('text replies', () => {
  test('a chat.completion with reasoning for a reasoning model', async () => {
    const body = await complete(userChat('What is SSE?'));
    assert.match(body.id, /^chatcmpl-mock-\d+$/);
    assert.equal(body.object, 'chat.completion');
    assert.equal(typeof body.created, 'number');
    assert.equal(body.model, 'glm-5.3-flash');
    assert.equal(body.choices.length, 1);
    const [choice] = body.choices;
    assert.equal(choice.index, 0);
    assert.equal(choice.finish_reason, 'stop');
    assert.deepEqual(choice.message, {
      role: 'assistant',
      content: 'Mock reply from glm-5.3-flash: What is SSE?',
      reasoning_content: 'Mock reasoning for glm-5.3-flash.',
    });
  });

  test('the non-reasoning model has no reasoning_content', async () => {
    const body = await complete(userChat('hi', { model: 'llama-3.3-70b-instruct-abliterated' }));
    assert.equal(body.model, 'llama-3.3-70b-instruct-abliterated');
    assert.equal(body.choices[0].message.reasoning_content, undefined);
    assert.equal(body.choices[0].message.content, 'Mock reply from llama-3.3-70b-instruct-abliterated: hi');
  });

  test('every other model reasons', async () => {
    for (const model of ['glm-4.7-flash-uncensored', 'gemma4-26b-a4b-qat', 'qwen3.8-27b-uncensored']) {
      const body = await complete(userChat('hi', { model }));
      assert.equal(body.choices[0].message.reasoning_content, `Mock reasoning for ${model}.`);
    }
  });

  test('replies quote the first 120 characters of the last user message', async () => {
    const long = 'x'.repeat(200);
    const body = await complete({
      model: 'glm-5.3-flash',
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: long },
      ],
    });
    assert.equal(body.choices[0].message.content, `Mock reply from glm-5.3-flash: ${'x'.repeat(120)}`);
  });

  test('array content uses the text parts', async () => {
    const body = await complete({
      model: 'gemma4-26b-a4b-qat',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          ],
        },
      ],
    });
    assert.equal(body.choices[0].message.content, 'Mock reply from gemma4-26b-a4b-qat: Describe this image.');
  });

  test('ids count up', async () => {
    const a = await complete(userChat('one'));
    const b = await complete(userChat('two'));
    const n = (id) => Number(id.split('-').at(-1));
    assert.ok(n(b.id) > n(a.id));
  });
});

describe('usage', () => {
  test('prompt is ceil(chars/4) over all message contents; completion counts reply and reasoning', async () => {
    const messages = [
      { role: 'system', content: 'abcde' }, // 5
      { role: 'user', content: [{ type: 'text', text: 'abc' }] }, // 3
      { role: 'assistant', content: null }, // 0
      { role: 'user', content: 'hello' }, // 5
    ];
    const body = await complete({ model: 'glm-5.3-flash', messages });
    const { content, reasoning_content } = body.choices[0].message;
    const expectedCompletion = Math.ceil((content.length + reasoning_content.length) / 4);
    assert.deepEqual(body.usage, {
      prompt_tokens: Math.ceil(13 / 4),
      completion_tokens: expectedCompletion,
      total_tokens: Math.ceil(13 / 4) + expectedCompletion,
    });
  });
});

describe('tools', () => {
  test('tools plus a user turn: one call to the first tool, built from its schema', async () => {
    const body = await complete(
      userChat('Weather in Oslo?', { tools: [weatherTool, { type: 'function', function: { name: 'other' } }] }),
    );
    const [choice] = body.choices;
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.equal(choice.message.content, null);
    assert.equal(choice.message.reasoning_content, 'Mock reasoning for glm-5.3-flash.');
    assert.equal(choice.message.tool_calls.length, 1);
    const [call] = choice.message.tool_calls;
    assert.match(call.id, /^call_mock_\d+$/);
    assert.equal(call.type, 'function');
    assert.equal(call.function.name, 'get_weather');
    assert.equal(typeof call.function.arguments, 'string');
    assert.deepEqual(JSON.parse(call.function.arguments), {
      city: 'example',
      unit: 'celsius',
      days: 1,
      detailed: true,
    });
  });

  test('a tool without parameters gets "{}"', async () => {
    const body = await complete(userChat('go', { tools: [{ type: 'function', function: { name: 'ping' } }] }));
    assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{}');
  });

  test('after a tool result, the reply names the tool and quotes the result', async () => {
    const first = await complete(userChat('Weather in Oslo?', { tools: [weatherTool] }));
    const assistant = first.choices[0].message;
    const result = JSON.stringify({ temp_c: 4, sky: 'overcast', note: 'n'.repeat(100) });
    const body = await complete({
      model: 'glm-5.3-flash',
      tools: [weatherTool],
      messages: [
        { role: 'user', content: 'Weather in Oslo?' },
        assistant,
        { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: result },
      ],
    });
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(
      body.choices[0].message.content,
      `Mock reply from glm-5.3-flash after tool get_weather: ${result.slice(0, 80)}`,
    );
  });

  test('the tool name falls back to the tool message name', async () => {
    const body = await complete({
      model: 'glm-5.3-flash',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'tool', tool_call_id: 'nope', name: 'lookup', content: 'found it' },
      ],
    });
    assert.equal(body.choices[0].message.content, 'Mock reply from glm-5.3-flash after tool lookup: found it');
  });
});

describe('JSON replies', () => {
  test('a ```json schema in a message yields an instance of it', async () => {
    const schema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        rating: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
        author: { type: 'object', properties: { name: { type: 'string' }, verified: { type: 'boolean' } } },
        kind: { type: 'string', enum: ['book', 'film'] },
      },
    };
    const body = await complete({
      model: 'glm-5.3-flash',
      messages: [
        {
          role: 'system',
          content: `Reply with JSON matching this schema:\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``,
        },
        { role: 'user', content: 'Review Dune.' },
      ],
    });
    assert.deepEqual(JSON.parse(body.choices[0].message.content), {
      title: 'example',
      rating: 1,
      tags: ['example'],
      author: { name: 'example', verified: true },
      kind: 'book',
    });
  });

  test('the word JSON without a schema yields a fixed object', async () => {
    const body = await complete(userChat('Answer in JSON please'));
    assert.equal(body.choices[0].message.content, '{"mock": true, "model": "glm-5.3-flash"}');
    assert.deepEqual(JSON.parse(body.choices[0].message.content), { mock: true, model: 'glm-5.3-flash' });
  });

  test('lowercase "json" alone does not switch to JSON', async () => {
    const body = await complete(userChat('a json file'));
    assert.equal(body.choices[0].message.content, 'Mock reply from glm-5.3-flash: a json file');
  });

  test('a ```json block that is not a schema falls back to the fixed object', async () => {
    const body = await complete(userChat('Format like this JSON:\n```json\n{"a": 1}\n```'));
    assert.equal(body.choices[0].message.content, '{"mock": true, "model": "glm-5.3-flash"}');
  });
});

describe('schemaInstance', () => {
  test('primitive rules', () => {
    assert.equal(schemaInstance({ type: 'string' }), 'example');
    assert.equal(schemaInstance({ type: 'number' }), 1);
    assert.equal(schemaInstance({ type: 'integer' }), 1);
    assert.equal(schemaInstance({ type: 'boolean' }), true);
    assert.equal(schemaInstance({ type: 'null' }), null);
    assert.equal(schemaInstance({ type: 'string', enum: ['a', 'b'] }), 'a');
    assert.equal(schemaInstance({ enum: [3, 4] }), 3);
    assert.equal(schemaInstance({ type: ['null', 'integer'] }), 1);
    assert.equal(schemaInstance({}), null);
    assert.equal(schemaInstance(null), null);
  });

  test('arrays get one item, objects recurse without type', () => {
    assert.deepEqual(schemaInstance({ type: 'array', items: { type: 'integer' } }), [1]);
    assert.deepEqual(schemaInstance({ items: { type: 'boolean' } }), [true]);
    assert.deepEqual(schemaInstance({ properties: { a: { properties: { b: { type: 'string' } } } } }), {
      a: { b: 'example' },
    });
  });

  test('findJsonSchemaBlock takes the last schema-shaped block', () => {
    const text =
      '```json\n{"properties":{"a":{"type":"string"}}}\n```\nthen\n```json\n{"properties":{"b":{"type":"number"}}}\n```';
    assert.deepEqual(findJsonSchemaBlock(text), { properties: { b: { type: 'number' } } });
    assert.equal(findJsonSchemaBlock('```json\nnot json\n```'), null);
    assert.equal(findJsonSchemaBlock('```js\n{"properties":{}}\n```'), null);
  });
});
