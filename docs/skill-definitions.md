### Defining AI Skills (Markdown)

Skills are defined using a structured Markdown format that allows both AI agents and standard code to understand business processes. The primary file format is `.md`, stored in `data/skills/`.

#### 1. Skill Metadata
Each skill should start with a header and a **Governance** section.

```markdown
# AI Skill: [Skill Name]

## Governance
- **ID:** [unique-id]
- **Owner:** [User/System ID]
- **Status:** Draft | Published
- **Version:** 1.0.0
- **Visibility:** internal | public
```

- **ID**: Used by the server to identify the skill (e.g., `skill__[ID]`).
- **Status**: Helps track the development lifecycle.

#### 2. Context
Provide high-level context about the skill's purpose.

```markdown
## Context
Project: [Project Name]
Context: [Description of when this skill is used]
```

#### 3. Slices (Workflows)
A skill consists of multiple **Slices**, representing distinct steps or sub-workflows.

```markdown
## Slices (Workflows)

### Slice: [Slice Name]
**Role:** customer | ai | system

#### Command: [Action Description]
**Inputs:**
- [ParamName] ([Type])
```

- **Role**:
  - `customer`: Initial trigger (e.g., user input).
  - `ai`: Logic or decision-making steps.
  - `system`: Automated operations (e.g., data retrieval).
- **Command**: Describes the intent of the slice.
- **Inputs**: List of parameters required for this slice. Types like `Text`, `Numeric`, `Identifier`, `Boolean` are supported.

#### 4. Components: Query, Automation, and Jobs
Slices can contain specialized components for data interaction.

```markdown
#### Query: [Query Name]
**Parameters:**
- [ParamName] ([Type])
  **Expected Outcomes:**
- [Outcome Description]

#### Automation: [Automation Name]
**Job:** [Job Name]
**Job Static Inputs:**
- [Key]: [Value]
**Job Input Mappings:**
- [Target] ← [SourceVariable]
  **Returns:** [OutputVariableName] ([Type])
```

- **Job**: Maps to a specific operation or **Capability**.
- **Job Static Inputs**: Fixed values passed to the operation.
- **Job Input Mappings**: Maps skill variables to operation inputs. Use `target ← source` syntax.
- **Returns**: Specifies the name and type of the variable where the result is stored.

#### 5. Scenarios & Business Rules
Scenarios define how variables are transformed or how the system should react under specific conditions.

```markdown
#### Scenarios / Business Rules

**Scenario:** scenario-[id]
- Given: [Condition]
- When: [Condition]
  && [Condition]
- Then Outcomes:
  - [Result Description]
    - [VariableName] ([Type]) [[FixedValue]]
- Error Path: [Error Description]
```

- **When/Given**: Logic conditions. Supports operators like `=`, `!=`, `>`, `<`, `>=`, `<=`, `&&`, `||`, and `Null`.
- **Then Outcomes**: What happens if conditions are met. Can assign values to variables using `[VariableName] (Type) [Value]`.
- **Error Path**: Defines behavior for failure cases.

---

### Defining Capabilities (TypeScript)

Capabilities are the underlying "tools" that Slices use (via Jobs). They are defined in `src/skills/skillTools.ts`.

#### 1. The `SkillCapability` Interface
```typescript
export interface SkillCapability {
  name: string; // Internal name (e.g., 'json:read')
  description: string; // What it does
  inputParams: { name: string, type: string, required: boolean, description: string }[];
  outputParams: { name: string, type: string, description: string }[];
  
  // Parses the Markdown section to extract parameters
  parse: (section: string) => Record<string, any>;
  
  // Predicts or executes the side-effects of the capability
  execute: (params: Record<string, any>) => { assignedVariables?: string[] };
}
```

#### 2. Registering a Capability
Add your capability to the `defaultCapabilities` array.

Example for a JSON lookup:
```typescript
{
  name: 'json:read',
  description: "Looks up a record in a JSON collection by a given field",
  inputParams: [
    { name: "collection", type: "string", required: true, description: "Collection name" },
    { name: "find", type: "string", required: true, description: "Search value" },
    { name: "returns", type: "string", required: true, description: "Output variable name" }
  ],
  execute: (params) => ({ assignedVariables: [params.returns] })
}
```

#### 3. How they Link
When the `SkillLoader` finds a `Job` in the Markdown:
1. It looks for a Capability matching the `Job` name or an explicit `Tool: [name]` field.
2. It calls `capability.parse(sectionContent)` to extract inputs.
3. The resulting parameters are stored in the `SkillStep`.
4. At runtime, the `SkillRunner` executes the logic associated with that Capability.
