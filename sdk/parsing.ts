/**
 * Generic utility for parsing Job Static Inputs and Job Input Mappings from markdown sections.
 */
export function parseJobInputs(section: string): Record<string, any> {
  const params: Record<string, any> = {};

  // Support new format: Job Static Inputs
  const staticInputsMatch = section.match(/Job Static Inputs:\s*([\s\S]*?)(?=\n\n|####|Scenario:|Job Input Mappings:|$)/i);
  if (staticInputsMatch) {
    const lines = staticInputsMatch[1].trim().split('\n');
    lines.forEach(line => {
      const m = line.match(/^\s*-\s*([^:]+):\s*(.*)/);
      if (m) {
        const key = m[1].trim();
        const value = m[2].trim();
        if (key === 'collection') params.collection = value;
        if (key === 'returns') {
          // Handle "returns: CustomerTier: {{user.tier}}"
          if (value.includes(':')) {
            const parts = value.split(':');
            const targetKey = parts[0].trim();
            const sourcePath = parts[1].trim();
            params.returns = targetKey;
            params.mappings = params.mappings || {};
            params.mappings[targetKey] = sourcePath;
          } else {
            params.returns = value;
          }
        } else {
          // Generic static input
          params[key] = value;
        }
      }
    });
  }

  // Support new format: Job Input Mappings
  const inputMappingsMatch = section.match(/(Job Input Mappings|Job Mappings):\s*([\s\S]*?)(?=\n\n|####|Scenario:|(?:\*\*)?Returns:(?:\*\*)?|$)/i);
  if (inputMappingsMatch) {
    const lines = inputMappingsMatch[2].trim().split('\n');
    lines.forEach(line => {
      // Handle "find ← CustomerId" or "target ← source"
      const m = line.match(/^\s*-\s*([^\s←]+)\s*←\s*(.*)/);
      if (m) {
        const target = m[1].trim();
        const source = m[2].trim();
        // Ensure source is wrapped in {{}} for template resolution
        const wrappedSource = (source.startsWith('{{') || source.includes('{')) ? source : `{{${source}}}`;
        if (target === 'find') {
          params.find = wrappedSource;
        } else {
          params.mappings = params.mappings || {};
          params.mappings[target] = wrappedSource;
        }
      }
    });
  }

  return params;
}

/**
 * Parses key-value pairs from a list-style block in markdown.
 */
export function parseKeyValueBlock(section: string, blockHeader: string): Record<string, string> {
  const regex = new RegExp(`${blockHeader}:\\s*([\\s\\S]*?)(?=\\n\\n|####|Scenario:|Job:|$|Job Static Inputs:|Job Input Mappings:|(?:\\*\\*)?Returns:(?:\\*\\*)?)`, 'i');
  const match = section.match(regex);
  const result: Record<string, string> = {};

  if (match) {
    const lines = match[1].trim().split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*-\s*([^:]+):\s*(.*)/);
      if (m) {
        result[m[1].trim()] = m[2].trim().replace(/['"]/g, '');
      }
    }
  }

  return result;
}

/**
 * Generic regex-based field extractor with backward compatibility for bold markers.
 */
export function extractField(section: string, fieldName: string, pattern: string = ':\\s*(.*)'): string | undefined {
  const fieldRegex = new RegExp(`${fieldName}${pattern}`, 'i');
  const boldFieldRegex = new RegExp(`\\*\\*${fieldName}\\*\\*${pattern}`, 'i');

  const match = section.match(fieldRegex) || section.match(boldFieldRegex);
  if (match) {
    return match[1].replace(/\*\*/g, '').split('(')[0].trim();
  }
  return undefined;
}
