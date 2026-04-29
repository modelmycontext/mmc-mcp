import { describe, it, expect, vi } from 'vitest';
import { ConnectorExecutor, ConnectorContext } from '../../src/connectors/connectorExecutor.js';

// ─── Existing tests (unchanged) ─────────────────────────────────────────────

describe('ConnectorExecutor json-read', () => {
  it('should call json-read correctly', async () => {
    const mockUsers = [
      { id: '123', name: 'John Doe', email: 'john@example.com' },
      { id: '456', name: 'Jane Smith', email: 'jane@example.com' }
    ];

    const mockEventBus = { publish: vi.fn().mockResolvedValue(undefined) };
    const mockJsonData = { read: vi.fn().mockResolvedValue(mockUsers) };
    const ctx = {
      eventBus: mockEventBus,
      dataSources: { json: mockJsonData },
      tools: {}
    } as unknown as ConnectorContext;

    const executor = new ConnectorExecutor();
    const run = executor.createExecutor('json-read', { collection: 'users', find: '123', returns: 'user' });
    const result = await run(ctx, {});

    expect(result).toBeDefined();
    expect(result.user).toEqual(mockUsers[0]);
    expect(mockJsonData.read).toHaveBeenCalledWith('users');
    expect(mockEventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
      type: 'TOOL_CALLED',
      payload: expect.objectContaining({ tool: 'json-read' })
    }));
  });

  it('should handle template in find parameter', async () => {
    const mockUsers = [
      { id: '123', name: 'John Doe', email: 'john@example.com' },
      { id: '456', name: 'Jane Smith', email: 'jane@example.com' }
    ];
    const mockJsonData = { read: vi.fn().mockResolvedValue(mockUsers) };
    const ctx = {
      eventBus: { publish: vi.fn() },
      dataSources: { json: mockJsonData },
      tools: {}
    } as unknown as ConnectorContext;

    const executor = new ConnectorExecutor();
    const run = executor.createExecutor('json-read', { collection: 'users', find: '{{userId}}', returns: 'user' });
    const result = await run(ctx, { userId: '456' });

    expect(result.user).toEqual(mockUsers[1]);
    expect(mockJsonData.read).toHaveBeenCalledWith('users');
  });

  it('should handle mappings correctly', async () => {
    const mockUsers = [{ id: '123', name: 'John Doe', email: 'john@example.com' }];
    const mockJsonData = { read: vi.fn().mockResolvedValue(mockUsers) };
    const ctx = {
      eventBus: { publish: vi.fn() },
      dataSources: { json: mockJsonData },
      tools: {}
    } as unknown as ConnectorContext;

    const executor = new ConnectorExecutor();
    const run = executor.createExecutor('json-read', {
      collection: 'users', find: '123', returns: 'user',
      mappings: { 'userName': 'user.name' }
    });
    const result = await run(ctx, {});

    expect(result.user).toEqual(mockUsers[0]);
    expect(result.userName).toBe('John Doe');
  });
});

// ─── New tests ───────────────────────────────────────────────────────────────

function makeCtx(overrides: Record<string, any> = {}): ConnectorContext {
  return {
    eventBus: { publish: vi.fn().mockResolvedValue(undefined) },
    dataSources: {
      json: {
        read: vi.fn().mockResolvedValue([]),
        write: vi.fn().mockResolvedValue(undefined),
      },
    },
    tools: {},
    ...overrides,
  } as unknown as ConnectorContext;
}

describe('ConnectorExecutor — json-write', () => {
  it('writes a new record and returns success', async () => {
    const ctx = makeCtx();
    (ctx.dataSources.json.read as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const executor = new ConnectorExecutor();
    const run = executor.createExecutor('json-write', { collection: 'users', upsert: true });
    const result = await run(ctx, { id: '1', name: 'Alice' });
    expect(ctx.dataSources.json.write).toHaveBeenCalled();
    const written = (ctx.dataSources.json.write as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(written.some((r: any) => r.name === 'Alice')).toBe(true);
    expect(result.success).toBe(true);
  });

  it('upserts an existing record by id', async () => {
    const existing = [{ id: '1', name: 'Old Name' }];
    const ctx = makeCtx();
    (ctx.dataSources.json.read as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    const executor = new ConnectorExecutor();
    const run = executor.createExecutor('json-write', { collection: 'users', upsert: true });
    await run(ctx, { id: '1', name: 'New Name' });
    const written = (ctx.dataSources.json.write as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(written).toHaveLength(1);
    expect(written[0].name).toBe('New Name');
  });

  it('publishes TOOL_CALLED event after write', async () => {
    const ctx = makeCtx();
    const executor = new ConnectorExecutor();
    const run = executor.createExecutor('json-write', { collection: 'users', upsert: true });
    await run(ctx, { id: '1', name: 'Alice' });
    expect(ctx.eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'TOOL_CALLED' }));
  });
});

describe('ConnectorExecutor — transform:template', () => {
  it('sets message on finalResult using the template param', async () => {
    const ctx = makeCtx();
    const executor = new ConnectorExecutor([]);
    const run = executor.createExecutor('transform:template', { template: 'Hello {{name}}' });
    const result = await run(ctx, { name: 'Alice' });
    expect(result.message).toBe('Hello Alice');
  });

  it('includes original input fields in result', async () => {
    const ctx = makeCtx();
    const executor = new ConnectorExecutor([]);
    const run = executor.createExecutor('transform:template', { template: 'Hi {{x}}' });
    const result = await run(ctx, { x: 'World', other: 'kept' });
    expect(result.other).toBe('kept');
  });
});

describe('ConnectorExecutor — transform:logic', () => {
  it('returns first matching scenario result merged into input', async () => {
    const ctx = makeCtx();
    const executor = new ConnectorExecutor([]);
    const run = executor.createExecutor('transform:logic', {
      scenarios: [{ condition: 'score >= 90', result: { grade: 'A' } }],
    });
    const result = await run(ctx, { score: 95 });
    expect(result.grade).toBe('A');
    expect(result.score).toBe(95);
  });

  it('resolves {{variable}} syntax in scenario result values', async () => {
    const ctx = makeCtx();
    const executor = new ConnectorExecutor([]);
    const run = executor.createExecutor('transform:logic', {
      scenarios: [{ condition: 'active = true', result: { label: '{{name}} is active' } }],
    });
    const result = await run(ctx, { active: true, name: 'Alice' });
    expect(result.label).toBe('Alice is active');
  });

  it('returns input unchanged when no scenario condition matches', async () => {
    const ctx = makeCtx();
    const executor = new ConnectorExecutor([]);
    const run = executor.createExecutor('transform:logic', {
      scenarios: [{ condition: 'score >= 90', result: { grade: 'A' } }],
    });
    const result = await run(ctx, { score: 50 });
    expect(result.grade).toBeUndefined();
    expect(result.score).toBe(50);
  });

  it('returns input unchanged when isSystemStep is true', async () => {
    const ctx = makeCtx();
    const executor = new ConnectorExecutor([]);
    const run = executor.createExecutor('transform:logic', {
      scenarios: [{ condition: 'score >= 0', result: { modified: true } }],
    }, true /* isSystemStep */);
    const result = await run(ctx, { score: 95 });
    expect(result.modified).toBeUndefined();
  });
});

describe('ConnectorExecutor — template resolution in params', () => {
  it('resolves {{variable}} in string param values before passing to tool', async () => {
    const mockTool = vi.fn().mockResolvedValue({});
    const ctx = makeCtx({ tools: { 'my-tool': mockTool } });
    const executor = new ConnectorExecutor([]);
    const run = executor.createExecutor('my-tool', { dynamicParam: '{{collectionName}}' });
    await run(ctx, { collectionName: 'orders' });
    // Tool should receive resolved param
    const calledParams = mockTool.mock.calls[0][0];
    expect(calledParams.dynamicParam).toBe('orders');
  });
});

describe('ConnectorExecutor — deep path mappings', () => {
  it('assigns a deep dot-path result key (e.g. nested.key)', async () => {
    const mockUsers = [{ id: '123', name: 'John Doe' }];
    const ctx = makeCtx({
      dataSources: { json: { read: vi.fn().mockResolvedValue(mockUsers) } }
    });
    const executor = new ConnectorExecutor();
    // After json-read, finalResult.user = {id:'123', name:'John Doe'}
    // The mapping 'nested.key': 'user.name' should assign finalResult.nested.key = 'John Doe'
    const run = executor.createExecutor('json-read', {
      collection: 'users',
      find: '123',
      returns: 'user',
      mappings: { 'nested.key': 'user.name' },
    });
    const result = await run(ctx, {});
    expect(result.nested?.key).toBe('John Doe');
  });

  it('resolves a path mapping into currentInput before the tool call', async () => {
    const mockTool = vi.fn().mockResolvedValue({});
    const ctx = makeCtx({ tools: { 'my-tool': mockTool } });
    const executor = new ConnectorExecutor([]);
    // mappings: { name: 'user.name' } + input: { user: { name: 'Alice' } }
    // → pre-current phase: resolveTemplate('{{user.name}}', input) = 'Alice'
    // → currentInput.name = 'Alice' when tool is called
    const run = executor.createExecutor('my-tool', { mappings: { name: 'user.name' } });
    await run(ctx, { user: { name: 'Alice' } });
    const calledInput = mockTool.mock.calls[0][1];
    expect(calledInput.name).toBe('Alice');
  });
});

describe('ConnectorExecutor — system steps', () => {
  it('does NOT publish TOOL_CALLED event when isSystemStep is true', async () => {
    const ctx = makeCtx();
    const executor = new ConnectorExecutor([]);
    const run = executor.createExecutor('transform:template', { template: 'hi' }, true);
    await run(ctx, {});
    expect(ctx.eventBus.publish).not.toHaveBeenCalled();
  });
});

describe('ConnectorExecutor — error cases', () => {
  it('throws "Tool not found" when action is unknown with no capabilities and no special case', async () => {
    const ctx = makeCtx();
    const executor = new ConnectorExecutor([]);
    const run = executor.createExecutor('nonexistent:action', {});
    await expect(run(ctx, {})).rejects.toThrow('Tool not found: nonexistent:action');
  });
});

describe('ConnectorExecutor — tool name normalisation (: to __)', () => {
  it('looks up ctx.tools with __ after : normalisation', async () => {
    const mockTool = vi.fn().mockResolvedValue({ found: true });
    const ctx = makeCtx({ tools: { 'json__read': mockTool } });
    const executor = new ConnectorExecutor([]);
    // json:read → normalizedAction = json__read → found in ctx.tools
    const run = executor.createExecutor('json:read', { collection: 'users', find: '123', returns: 'item' });
    await run(ctx, {});
    expect(mockTool).toHaveBeenCalled();
  });
});
