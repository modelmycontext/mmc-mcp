import { describe, it, expect } from 'vitest';
import { fitToolName, MCP_TOOL_NAME_MAX } from '../../src/utils/toolNameUtils.js';

describe('fitToolName', () => {
  it('returns the input unchanged when within the limit', () => {
    const name = 'wf-a3f9b2c1--request-top-projects-report';
    expect(name.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX);
    expect(fitToolName(name)).toBe(name);
  });

  it('returns the input unchanged when exactly at the limit', () => {
    const name = 'a'.repeat(MCP_TOOL_NAME_MAX);
    expect(fitToolName(name)).toBe(name);
  });

  it('truncates with a 6-char hash suffix when over the limit', () => {
    const longName = 'wf-a3f9b2c1--request-top-projects-budget-report-slack-extended-with-extras';
    expect(longName.length).toBeGreaterThan(MCP_TOOL_NAME_MAX);

    const fitted = fitToolName(longName);
    expect(fitted.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX);
    expect(fitted).toMatch(/-[0-9a-f]{6}$/);
    expect(longName.startsWith(fitted.slice(0, fitted.length - 7))).toBe(true);
  });

  it('produces deterministic output for the same input', () => {
    const longName = 'x'.repeat(80);
    expect(fitToolName(longName)).toBe(fitToolName(longName));
  });

  it('produces distinct outputs for different long inputs that share a prefix', () => {
    const base = 'wf-12345678--' + 'a'.repeat(60);
    const variantA = base + '-aaa';
    const variantB = base + '-bbb';
    const fittedA = fitToolName(variantA);
    const fittedB = fitToolName(variantB);
    expect(fittedA).not.toBe(fittedB);
    expect(fittedA.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX);
    expect(fittedB.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX);
  });
});
